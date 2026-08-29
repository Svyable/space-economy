import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MarketPriceHistoryDirectory } from '../src/market-price-history.js';

async function createOffer(market, sellerId, {
  service = 'data-relay',
  unit = 'MB',
  amount = '100',
  scale = 2,
  capacity = 100,
} = {}) {
  const asset = await market.registerAsset({
    name: `${sellerId}-${service}-${unit}-${amount}-${scale}`,
    type: 'space-infrastructure',
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service,
    unit,
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale },
    capacity,
  }, { actorId: sellerId });
}

async function settle(market, offer, buyerId, quantity, suffix) {
  const order = await market.createOrder({ offerId: offer.id, quantity }, { actorId: buyerId });
  await market.fundOrder(order.id, {
    amount: order.total.amount,
    reference: `fund:${suffix}`,
  }, { actorId: buyerId });
  await market.recordDelivery(order.id, {
    proof: { type: 'benchmark-test', data: { suffix } },
  }, { actorId: offer.sellerId });
  return market.settleOrder(order.id, { reference: `settle:${suffix}` }, { actorId: buyerId });
}

test('builds exact settled-only price evidence across decimal scales', async () => {
  let now = new Date('2026-08-29T18:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const low = await createOffer(market, 'seller-a', { amount: '100', scale: 2 });
  const middle = await createOffer(market, 'seller-b', { amount: '1250', scale: 3 });
  const high = await createOffer(market, 'seller-c', { amount: '200', scale: 2 });
  const unsettled = await createOffer(market, 'seller-d', { amount: '999', scale: 2 });

  now = new Date('2026-08-29T18:10:00.000Z');
  await settle(market, low, 'buyer-1', 2, 'low');
  now = new Date('2026-08-29T18:20:00.000Z');
  await settle(market, middle, 'buyer-2', 1, 'middle');
  now = new Date('2026-08-29T18:30:00.000Z');
  await settle(market, high, 'buyer-3', 3, 'high');
  now = new Date('2026-08-29T18:40:00.000Z');
  const pending = await market.createOrder({ offerId: unsettled.id, quantity: 50 }, { actorId: 'buyer-4' });
  await market.fundOrder(pending.id, { amount: pending.total.amount, reference: 'fund:unsettled' }, { actorId: 'buyer-4' });

  const directory = new MarketPriceHistoryDirectory({ market });
  const benchmark = await directory.getBenchmark({
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
  });

  assert.equal(benchmark.ledgerValid, true);
  assert.equal(benchmark.observations, 3);
  assert.equal(benchmark.settledQuantity, 6);
  assert.deepEqual(benchmark.unitPrice.low, { settlementAsset: 'iso4217:USD', amount: '1000', scale: 3 });
  assert.deepEqual(benchmark.unitPrice.high, { settlementAsset: 'iso4217:USD', amount: '2000', scale: 3 });
  assert.deepEqual(benchmark.unitPrice.median, {
    settlementAsset: 'iso4217:USD',
    amountNumerator: '1250',
    amountDenominator: '1',
    scale: 3,
  });
  assert.deepEqual(benchmark.settledNotional, { settlementAsset: 'iso4217:USD', amount: '9250', scale: 3 });
  assert.equal(benchmark.firstSettledAt, '2026-08-29T18:10:00.000Z');
  assert.equal(benchmark.lastSettledAt, '2026-08-29T18:30:00.000Z');
  assert.equal('fairValue' in benchmark, false);
  assert.equal('sellers' in benchmark, false);
});

test('represents an even-sample median exactly without floating-point rounding', async () => {
  const market = await Clearinghouse.open();
  const one = await createOffer(market, 'seller-a', { service: 'compute', unit: 'second', amount: '100', scale: 2 });
  const two = await createOffer(market, 'seller-b', { service: 'compute', unit: 'second', amount: '125', scale: 2 });
  await settle(market, one, 'buyer-1', 1, 'one');
  await settle(market, two, 'buyer-2', 1, 'two');

  const benchmark = await new MarketPriceHistoryDirectory({ market }).getBenchmark({
    service: 'compute',
    unit: 'second',
    settlementAsset: 'iso4217:USD',
  });
  assert.deepEqual(benchmark.unitPrice.median, {
    settlementAsset: 'iso4217:USD',
    amountNumerator: '225',
    amountDenominator: '2',
    scale: 2,
  });
});

test('time windows include since and exclude until', async () => {
  let now = new Date('2026-08-29T18:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const offer = await createOffer(market, 'seller', { service: 'ground-contact', unit: 'second' });
  now = new Date('2026-08-29T18:10:00.000Z');
  await settle(market, offer, 'buyer-1', 1, 'first');
  now = new Date('2026-08-29T18:20:00.000Z');
  await settle(market, offer, 'buyer-2', 1, 'second');
  now = new Date('2026-08-29T18:30:00.000Z');
  await settle(market, offer, 'buyer-3', 1, 'third');

  const directory = new MarketPriceHistoryDirectory({ market });
  const benchmark = await directory.getBenchmark({
    service: 'ground-contact',
    unit: 'second',
    settlementAsset: 'iso4217:USD',
    since: '2026-08-29T18:20:00.000Z',
    until: '2026-08-29T18:30:00.000Z',
  });
  assert.equal(benchmark.observations, 1);
  assert.equal(benchmark.firstSettledAt, '2026-08-29T18:20:00.000Z');
  assert.equal(benchmark.lastSettledAt, '2026-08-29T18:20:00.000Z');
});

test('lists markets deterministically and supports minimum observation thresholds', async () => {
  const market = await Clearinghouse.open();
  const relay = await createOffer(market, 'seller-a', { service: 'relay', unit: 'MB' });
  const compute = await createOffer(market, 'seller-b', { service: 'compute', unit: 'second' });
  await settle(market, relay, 'buyer-1', 1, 'relay-1');
  await settle(market, relay, 'buyer-2', 1, 'relay-2');
  await settle(market, compute, 'buyer-3', 1, 'compute-1');

  const directory = new MarketPriceHistoryDirectory({ market });
  const all = await directory.listBenchmarks();
  assert.deepEqual(all.map((item) => `${item.service}:${item.unit}:${item.settlementAsset}`), [
    'compute:second:iso4217:USD',
    'relay:MB:iso4217:USD',
  ]);
  const liquid = await directory.listBenchmarks({ minObservations: 2 });
  assert.deepEqual(liquid.map((item) => item.service), ['relay']);
});

test('fails closed for invalid ledgers and repeated revision churn', async () => {
  const invalidLedger = new MarketPriceHistoryDirectory({
    market: {
      getRevision: async () => 1,
      verifyLedger: async () => false,
      getLedger: async () => [],
      getOrder: async () => { throw new Error('should not read'); },
    },
  });
  await assert.rejects(
    invalidLedger.listBenchmarks(),
    (error) => error.code === 'LEDGER_INTEGRITY_FAILED',
  );

  let revision = 0;
  const churn = new MarketPriceHistoryDirectory({
    maxRevisionRetries: 2,
    market: {
      getRevision: async () => revision++,
      verifyLedger: async () => true,
      getLedger: async () => [],
      getOrder: async () => { throw new Error('should not read'); },
    },
  });
  await assert.rejects(
    churn.listBenchmarks(),
    (error) => error.code === 'HISTORY_CHANGED',
  );
});

test('getBenchmark requires a concrete market and fails when no settled history exists', async () => {
  const market = await Clearinghouse.open();
  const directory = new MarketPriceHistoryDirectory({ market });
  await assert.rejects(
    directory.getBenchmark({ service: 'relay', unit: 'MB', settlementAsset: 'iso4217:USD' }),
    (error) => error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    directory.getBenchmark({ service: 'relay', unit: 'MB', settlementAsset: null }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
