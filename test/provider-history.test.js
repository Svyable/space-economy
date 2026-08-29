import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { ProviderHistoryDirectory } from '../src/provider-history.js';

async function createOffer(market, sellerId, {
  service = 'data-relay',
  amount = '125',
  scale = 2,
  capacity = 100,
  reservationTtlSeconds = null,
} = {}) {
  const asset = await market.registerAsset({
    name: `${sellerId}-${service}-${scale}`,
    type: 'space-infrastructure',
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service,
    unit: 'unit',
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale },
    capacity,
    reservationTtlSeconds,
  }, { actorId: sellerId });
}

test('aggregates mixed provider outcomes without inventing a reputation score', async () => {
  let now = new Date('2026-08-29T17:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const offerScale2 = await createOffer(market, 'provider-a', { amount: '125', scale: 2, capacity: 20 });
  const offerScale3 = await createOffer(market, 'provider-a', { amount: '1250', scale: 3, capacity: 20 });
  const offerExpiry = await createOffer(market, 'provider-a', {
    amount: '1250',
    scale: 3,
    capacity: 20,
    reservationTtlSeconds: 30,
  });

  now = new Date('2026-08-29T17:10:00.000Z');
  const settledOne = await market.createOrder({ offerId: offerScale2.id, quantity: 2 }, { actorId: 'buyer-1' });
  now = new Date('2026-08-29T17:11:00.000Z');
  await market.fundOrder(settledOne.id, { amount: settledOne.total.amount, reference: 'fund:1' }, { actorId: 'buyer-1' });
  now = new Date('2026-08-29T17:13:00.000Z');
  await market.recordDelivery(settledOne.id, { proof: { type: 'test', data: { n: 1 } } }, { actorId: 'provider-a' });
  now = new Date('2026-08-29T17:14:00.000Z');
  await market.settleOrder(settledOne.id, { reference: 'settle:1' }, { actorId: 'buyer-1' });

  now = new Date('2026-08-29T17:20:00.000Z');
  const settledTwo = await market.createOrder({ offerId: offerScale3.id, quantity: 1 }, { actorId: 'buyer-2' });
  now = new Date('2026-08-29T17:21:00.000Z');
  await market.fundOrder(settledTwo.id, { amount: settledTwo.total.amount, reference: 'fund:2' }, { actorId: 'buyer-2' });
  now = new Date('2026-08-29T17:22:00.000Z');
  await market.recordDelivery(settledTwo.id, { proof: { type: 'test', data: { n: 2 } } }, { actorId: 'provider-a' });
  now = new Date('2026-08-29T17:23:00.000Z');
  await market.settleOrder(settledTwo.id, { reference: 'settle:2' }, { actorId: 'buyer-2' });

  now = new Date('2026-08-29T17:30:00.000Z');
  const cancelled = await market.createOrder({ offerId: offerScale2.id, quantity: 1 }, { actorId: 'buyer-3' });
  now = new Date('2026-08-29T17:31:00.000Z');
  await market.cancelOrder(cancelled.id, { actorId: 'buyer-3' });

  now = new Date('2026-08-29T17:40:00.000Z');
  const expired = await market.createOrder({ offerId: offerExpiry.id, quantity: 1 }, { actorId: 'buyer-4' });
  now = new Date('2026-08-29T17:41:00.000Z');
  await market.expireOrder(expired.id, { actorId: 'expiry-worker' });

  now = new Date('2026-08-29T17:50:00.000Z');
  const fundedOnly = await market.createOrder({ offerId: offerScale2.id, quantity: 1 }, { actorId: 'buyer-5' });
  now = new Date('2026-08-29T17:51:00.000Z');
  await market.fundOrder(fundedOnly.id, { amount: fundedOnly.total.amount, reference: 'fund:5' }, { actorId: 'buyer-5' });

  const directory = new ProviderHistoryDirectory({ market });
  const history = await directory.getProviderHistory({ sellerId: 'provider-a', service: 'data-relay' });

  assert.equal(history.ledgerValid, true);
  assert.equal(history.orders.total, 5);
  assert.equal(history.orders.settled, 2);
  assert.equal(history.orders.cancelled, 1);
  assert.equal(history.orders.expired, 1);
  assert.equal(history.orders.funded, 1);
  assert.deepEqual(history.terminalOutcomes, { total: 4, settled: 2, cancelled: 1, expired: 1 });
  assert.deepEqual(history.quantities, { contracted: 6, settled: 3, cancelled: 1, expired: 1 });
  assert.deepEqual(history.contractedTotals, [{ settlementAsset: 'iso4217:USD', amount: '7500', scale: 3 }]);
  assert.deepEqual(history.settledTotals, [{ settlementAsset: 'iso4217:USD', amount: '3750', scale: 3 }]);
  assert.deepEqual(history.timing.funding, { count: 3, averageMs: 60000, minMs: 60000, maxMs: 60000 });
  assert.deepEqual(history.timing.delivery, { count: 2, averageMs: 150000, minMs: 120000, maxMs: 180000 });
  assert.deepEqual(history.timing.settlement, { count: 2, averageMs: 210000, minMs: 180000, maxMs: 240000 });
  assert.equal('score' in history, false);
  assert.equal('buyers' in history, false);
});

test('lists provider/service histories deterministically without ranking by performance', async () => {
  const market = await Clearinghouse.open();
  const relayA = await createOffer(market, 'z-provider', { service: 'relay' });
  const relayB = await createOffer(market, 'a-provider', { service: 'relay' });
  const computeA = await createOffer(market, 'a-provider', { service: 'compute' });
  await market.createOrder({ offerId: relayA.id, quantity: 1 }, { actorId: 'buyer-1' });
  await market.createOrder({ offerId: relayB.id, quantity: 1 }, { actorId: 'buyer-2' });
  await market.createOrder({ offerId: computeA.id, quantity: 1 }, { actorId: 'buyer-3' });

  const directory = new ProviderHistoryDirectory({ market });
  const relay = await directory.listProviderHistories({ service: 'relay' });
  assert.deepEqual(relay.map((item) => item.sellerId), ['a-provider', 'z-provider']);
  assert.ok(relay.every((item) => item.service === 'relay'));

  const all = await directory.listProviderHistories();
  assert.deepEqual(all.map((item) => `${item.sellerId}:${item.service}`), [
    'a-provider:compute',
    'a-provider:relay',
    'z-provider:relay',
  ]);
});

test('refuses to derive history from a ledger that fails integrity verification', async () => {
  const directory = new ProviderHistoryDirectory({
    market: {
      getRevision: async () => 1,
      verifyLedger: async () => false,
      getLedger: async () => [],
      getOrder: async () => { throw new Error('should not read orders'); },
    },
  });
  await assert.rejects(
    directory.listProviderHistories(),
    (error) => error.code === 'LEDGER_INTEGRITY_FAILED',
  );
});

test('fails explicitly when the market changes on every attempted history snapshot', async () => {
  let revision = 0;
  const directory = new ProviderHistoryDirectory({
    maxRevisionRetries: 2,
    market: {
      getRevision: async () => revision++,
      verifyLedger: async () => true,
      getLedger: async () => [],
      getOrder: async () => { throw new Error('no orders expected'); },
    },
  });
  await assert.rejects(
    directory.listProviderHistories(),
    (error) => error.code === 'HISTORY_CHANGED',
  );
});

test('getProviderHistory fails closed when seller/service has no observed orders', async () => {
  const market = await Clearinghouse.open();
  const directory = new ProviderHistoryDirectory({ market });
  await assert.rejects(
    directory.getProviderHistory({ sellerId: 'unknown', service: 'relay' }),
    (error) => error.code === 'NOT_FOUND',
  );
});
