import assert from 'node:assert/strict';
import test from 'node:test';
import { CapacityDirectory } from '../src/capacity-query.js';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MarketLiquidityDirectory } from '../src/market-liquidity.js';
import { MarketWatchRegistry } from '../src/market-watchlists.js';
import { RfqMarket } from '../src/rfq-market.js';
import { RfqOpportunityDirectory } from '../src/rfq-opportunities.js';
import { MemorySnapshotStore } from '../src/store.js';

async function createOffer(market, sellerId, {
  service = 'data-relay',
  unit = 'MB',
  capacity = 10,
  amount = '10',
  scale = 2,
} = {}) {
  const asset = await market.registerAsset({
    name: `${sellerId}-${service}`,
    type: 'communications-satellite',
    capabilities: ['data-relay'],
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service,
    unit,
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale },
    capacity,
  }, { actorId: sellerId });
}

test('capacity watch fires on a rising edge, stays quiet while true, and re-arms after false', async () => {
  const market = await Clearinghouse.open();
  const registry = await MarketWatchRegistry.open({ capacityDirectory: new CapacityDirectory({ market }) });
  const watch = await registry.createWatch({
    kind: 'capacity-available',
    name: 'relay capacity',
    query: { service: 'data-relay', unit: 'MB', settlementAsset: 'iso4217:USD', minRemaining: 5 },
  }, { actorId: 'buyer-a', idempotencyKey: 'watch-capacity' });

  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' })).triggered, false);

  const offer = await createOffer(market, 'seller-a', { capacity: 5 });
  const first = await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' });
  assert.equal(first.triggered, true);
  assert.equal(first.trigger.evidence.match.offer.id, offer.id);
  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' })).triggered, false);
  assert.equal((await registry.listPendingTriggers({ actorId: 'buyer-a' })).length, 1);

  await registry.acknowledgeTrigger(watch.id, first.trigger.id, {
    actorId: 'buyer-a',
    idempotencyKey: 'ack-1',
  });
  assert.equal((await registry.listPendingTriggers({ actorId: 'buyer-a' })).length, 0);

  const order = await market.createOrder({ offerId: offer.id, quantity: 5 }, { actorId: 'other-buyer' });
  const unavailable = await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' });
  assert.equal(unavailable.triggered, false);
  assert.equal(unavailable.evidence.active, false);

  await market.cancelOrder(order.id, { actorId: 'other-buyer' });
  const second = await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' });
  assert.equal(second.triggered, true);
  assert.notEqual(second.trigger.id, first.trigger.id);
});

test('seller opportunity watch binds discovery to the owner and persists an actionable trigger', async () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  const offer = await createOffer(market, 'seller-a', { capacity: 20 });
  const opportunityDirectory = new RfqOpportunityDirectory({ market, rfqMarket, clock });
  const registry = await MarketWatchRegistry.open({ rfqOpportunityDirectory: opportunityDirectory, clock });
  const watch = await registry.createWatch({
    kind: 'rfq-opportunity-available',
    query: { service: 'data-relay', settlementAsset: 'iso4217:USD' },
  }, { actorId: 'seller-a' });

  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'seller-a' })).triggered, false);
  assert.throws(
    () => registry.createWatch({ kind: 'rfq-opportunity-available', query: { sellerId: 'seller-b' } }, { actorId: 'seller-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );

  const rfq = await rfqMarket.createRfq({
    service: 'data-relay',
    unit: 'MB',
    quantity: 5,
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    requiredCapabilities: ['data-relay'],
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, { actorId: 'buyer-a' });

  const triggered = await registry.evaluateWatch(watch.id, { actorId: 'seller-a' });
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.trigger.ownerId, 'seller-a');
  assert.equal(triggered.trigger.evidence.opportunity.rfqId, rfq.id);
  assert.equal(triggered.trigger.evidence.opportunity.offerId, offer.id);

  await rfqMarket.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' });
  const rearmed = await registry.evaluateWatch(watch.id, { actorId: 'seller-a' });
  assert.equal(rearmed.evidence.active, false);
});

test('liquidity watch compares exact signed integer balances and triggers on threshold crossings', async () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  const liquidity = new MarketLiquidityDirectory({ market, rfqMarket, clock });
  const registry = await MarketWatchRegistry.open({ marketLiquidityDirectory: liquidity, clock });
  const watch = await registry.createWatch({
    kind: 'liquidity-balance',
    market: { service: 'data-relay', unit: 'MB', settlementAsset: 'iso4217:USD' },
    operator: 'lte',
    threshold: '-1',
  }, { actorId: 'operator-a' });

  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'operator-a' })).triggered, false);

  await rfqMarket.createRfq({
    service: 'data-relay', unit: 'MB', quantity: 10, settlementAsset: 'iso4217:USD',
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, { actorId: 'buyer-a' });
  const deficit = await registry.evaluateWatch(watch.id, { actorId: 'operator-a' });
  assert.equal(deficit.triggered, true);
  assert.equal(deficit.evidence.balance, '-10');

  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'operator-a' })).triggered, false);
  await createOffer(market, 'seller-a', { capacity: 20 });
  const surplus = await registry.evaluateWatch(watch.id, { actorId: 'operator-a' });
  assert.equal(surplus.evidence.balance, '10');
  assert.equal(surplus.evidence.active, false);

  await rfqMarket.createRfq({
    service: 'data-relay', unit: 'MB', quantity: 15, settlementAsset: 'iso4217:USD',
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, { actorId: 'buyer-b' });
  const deficitAgain = await registry.evaluateWatch(watch.id, { actorId: 'operator-a' });
  assert.equal(deficitAgain.triggered, true);
  assert.equal(deficitAgain.evidence.balance, '-5');
});

test('one registry serializes concurrent evaluations so one rising edge creates one trigger', async () => {
  const source = {
    find: async () => ({ revision: 1, items: [{ offer: { id: 'offer-1' }, asset: { id: 'asset-1' } }] }),
  };
  const registry = await MarketWatchRegistry.open({ capacityDirectory: source });
  const watch = await registry.createWatch({ kind: 'capacity-available', query: {} }, { actorId: 'buyer-a' });
  const results = await Promise.all([
    registry.evaluateWatch(watch.id, { actorId: 'buyer-a' }),
    registry.evaluateWatch(watch.id, { actorId: 'buyer-a' }),
  ]);
  assert.equal(results.filter((result) => result.triggered).length, 1);
  assert.equal((await registry.listPendingTriggers({ actorId: 'buyer-a' })).length, 1);
});

test('shared CAS store deduplicates one rising edge across competing watch workers', async () => {
  const store = new MemorySnapshotStore();
  const source = {
    find: async () => ({
      revision: 7,
      items: [{ offer: { id: 'offer-1' }, asset: { id: 'asset-1' } }],
      nextCursor: null,
    }),
  };
  const first = await MarketWatchRegistry.open({ capacityDirectory: source, store });
  const watch = await first.createWatch({ kind: 'capacity-available', query: { service: 'relay' } }, { actorId: 'buyer-a' });
  const second = await MarketWatchRegistry.open({ capacityDirectory: source, store });

  const results = await Promise.all([
    first.evaluateWatch(watch.id, { actorId: 'buyer-a' }),
    second.evaluateWatch(watch.id, { actorId: 'buyer-a' }),
  ]);
  assert.equal(results.filter((result) => result.triggered).length, 1);

  const reopened = await MarketWatchRegistry.open({ capacityDirectory: source, store });
  const pending = await reopened.listPendingTriggers({ actorId: 'buyer-a' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].watchId, watch.id);
});

test('pending triggers survive restart until explicitly acknowledged', async () => {
  const store = new MemorySnapshotStore();
  const source = { find: async () => ({ revision: 1, items: [{ offer: { id: 'offer-1' } }] }) };
  const first = await MarketWatchRegistry.open({ capacityDirectory: source, store });
  const watch = await first.createWatch({ kind: 'capacity-available', query: {} }, {
    actorId: 'buyer-a', idempotencyKey: 'watch-1',
  });
  const evaluation = await first.evaluateWatch(watch.id, { actorId: 'buyer-a' });
  assert.equal(evaluation.triggered, true);

  const restarted = await MarketWatchRegistry.open({ capacityDirectory: source, store });
  assert.equal((await restarted.listPendingTriggers({ actorId: 'buyer-a' })).length, 1);
  await restarted.acknowledgeTrigger(watch.id, evaluation.trigger.id, {
    actorId: 'buyer-a', idempotencyKey: 'ack-after-restart',
  });
  assert.equal((await restarted.listPendingTriggers({ actorId: 'buyer-a' })).length, 0);
});

test('disabled watch stops evaluation and explicit re-enable re-arms it', async () => {
  const source = { find: async () => ({ revision: 1, items: [{ offer: { id: 'offer-1' } }] }) };
  const registry = await MarketWatchRegistry.open({ capacityDirectory: source });
  const watch = await registry.createWatch({ kind: 'capacity-available', query: {} }, { actorId: 'buyer-a' });
  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' })).triggered, true);
  await registry.setWatchEnabled(watch.id, false, { actorId: 'buyer-a' });
  await assert.rejects(
    registry.evaluateWatch(watch.id, { actorId: 'buyer-a' }),
    (error) => error.code === 'WATCH_DISABLED',
  );
  await registry.setWatchEnabled(watch.id, true, { actorId: 'buyer-a' });
  assert.equal((await registry.evaluateWatch(watch.id, { actorId: 'buyer-a' })).triggered, true);
});

test('one-shot scheduler reports individual failures while continuing other watches', async () => {
  const source = {
    find: async ({ service }) => {
      if (service === 'broken') throw Object.assign(new Error('projection temporarily unavailable'), { code: 'SOURCE_DOWN' });
      return { revision: 2, items: service === 'available' ? [{ offer: { id: 'offer-a' } }] : [] };
    },
  };
  const registry = await MarketWatchRegistry.open({ capacityDirectory: source });
  await registry.createWatch({ kind: 'capacity-available', query: { service: 'broken' } }, { actorId: 'buyer-a' });
  await registry.createWatch({ kind: 'capacity-available', query: { service: 'available' } }, { actorId: 'buyer-b' });

  const run = await registry.runOnce();
  assert.equal(run.evaluated, 1);
  assert.equal(run.failed, 1);
  assert.equal(run.evaluations[0].triggered, true);
  assert.equal(run.failures[0].error.code, 'SOURCE_DOWN');
});

test('watch definitions and owner boundaries fail closed', async () => {
  const source = { find: async () => ({ revision: 0, items: [] }) };
  const registry = await MarketWatchRegistry.open({ capacityDirectory: source });
  assert.throws(
    () => registry.createWatch({ kind: 'capacity-available', query: { cursor: 'not-allowed' } }, { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => registry.createWatch({ kind: 'capacity-available', query: { status: null } }, { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => registry.createWatch({
      kind: 'liquidity-balance',
      market: { service: 'relay', unit: 'MB', settlementAsset: 'iso4217:USD' },
      operator: 'lte', threshold: '1.5',
    }, { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );

  const watch = await registry.createWatch({ kind: 'capacity-available', query: {} }, { actorId: 'buyer-a' });
  await assert.rejects(registry.getWatch(watch.id, { actorId: 'buyer-b' }), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(registry.evaluateWatch(watch.id, { actorId: 'buyer-b' }), (error) => error.code === 'FORBIDDEN');
});