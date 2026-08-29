import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { RfqMarket } from '../src/rfq-market.js';
import { MarketLiquidityDirectory } from '../src/market-liquidity.js';

async function createOffer(market, sellerId, {
  service = 'data-relay',
  unit = 'second',
  settlementAsset = 'iso4217:USD',
  amount = '125',
  scale = 2,
  capacity = 10,
} = {}) {
  const asset = await market.registerAsset({
    name: `${sellerId}-${settlementAsset}-${amount}-${scale}`,
    type: 'relay',
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service,
    unit,
    unitPrice: { settlementAsset, amount, scale },
    capacity,
  }, { actorId: sellerId });
}

async function createRfq(rfqMarket, buyerId, overrides = {}) {
  return rfqMarket.createRfq({
    service: 'data-relay',
    unit: 'second',
    quantity: 1,
    settlementAsset: 'iso4217:USD',
    expiresAt: '2026-08-29T19:00:00.000Z',
    ...overrides,
  }, { actorId: buyerId });
}

test('aggregates open supply and RFQ demand without pretending price ceilings are bids', async () => {
  let now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });

  const usdLow = await createOffer(market, 'seller-a', { amount: '125', scale: 2, capacity: 10 });
  await createOffer(market, 'seller-b', { amount: '1500', scale: 3, capacity: 5 });
  await createOffer(market, 'seller-eur', {
    settlementAsset: 'iso4217:EUR',
    amount: '175',
    scale: 2,
    capacity: 4,
  });

  await market.createOrder({ offerId: usdLow.id, quantity: 2 }, { actorId: 'buyer-reserved' });

  await createRfq(rfqMarket, 'buyer-usd-priced', {
    quantity: 6,
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '140', scale: 2 },
  });
  await createRfq(rfqMarket, 'buyer-usd-unpriced', { quantity: 3 });
  await createRfq(rfqMarket, 'buyer-eur', {
    quantity: 2,
    settlementAsset: 'iso4217:EUR',
    maxUnitPrice: { settlementAsset: 'iso4217:EUR', amount: '2000', scale: 3 },
  });
  await createRfq(rfqMarket, 'buyer-flexible', {
    quantity: 7,
    settlementAsset: null,
    maxUnitPrice: null,
  });
  await createRfq(rfqMarket, 'buyer-expired', {
    quantity: 9,
    expiresAt: '2026-08-29T18:05:00.000Z',
  });
  const cancelled = await createRfq(rfqMarket, 'buyer-cancelled', { quantity: 11 });
  await rfqMarket.cancelRfq(cancelled.id, { actorId: 'buyer-cancelled' });

  now = new Date('2026-08-29T18:10:00.000Z');
  const directory = new MarketLiquidityDirectory({ market, rfqMarket, clock });
  const snapshot = await directory.snapshot();

  assert.equal(snapshot.totalMarkets, 2);
  assert.equal(snapshot.hasMore, false);
  assert.ok(Number.isSafeInteger(snapshot.marketRevision));
  assert.ok(Number.isSafeInteger(snapshot.rfqRevision));

  const usd = snapshot.markets.find((row) => row.settlementAsset === 'iso4217:USD');
  assert.deepEqual(usd.supply, {
    offerCount: 2,
    remainingQuantity: '13',
    unitPriceRange: {
      low: { settlementAsset: 'iso4217:USD', amount: '125', scale: 2 },
      high: { settlementAsset: 'iso4217:USD', amount: '1500', scale: 3 },
    },
  });
  assert.deepEqual(usd.constrainedDemand, {
    rfqCount: 2,
    quantity: '9',
    pricedRfqCount: 1,
    pricedQuantity: '6',
    maxUnitPriceCeilingRange: {
      low: { settlementAsset: 'iso4217:USD', amount: '140', scale: 2 },
      high: { settlementAsset: 'iso4217:USD', amount: '140', scale: 2 },
    },
  });
  assert.equal(usd.constrainedBalance, '4');
  assert.equal('spread' in usd, false);
  assert.equal('fairValue' in usd, false);
  assert.equal('score' in usd, false);

  const eur = snapshot.markets.find((row) => row.settlementAsset === 'iso4217:EUR');
  assert.equal(eur.supply.remainingQuantity, '4');
  assert.equal(eur.constrainedDemand.quantity, '2');
  assert.equal(eur.constrainedBalance, '2');

  assert.deepEqual(snapshot.unconstrainedDemand, [{
    service: 'data-relay',
    unit: 'second',
    rfqCount: 1,
    quantity: '7',
  }]);
});

test('surfaces demand-only markets and keeps asset-neutral demand separate from currency filters', async () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });

  await createRfq(rfqMarket, 'buyer-demand-only', {
    service: 'orbital-compute',
    unit: 'compute-second',
    quantity: 12,
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
  });
  await createRfq(rfqMarket, 'buyer-flexible', {
    service: 'orbital-compute',
    unit: 'compute-second',
    quantity: 4,
    settlementAsset: null,
    maxUnitPrice: null,
  });

  const directory = new MarketLiquidityDirectory({ market, rfqMarket, clock });
  const snapshot = await directory.snapshot({ settlementAsset: 'iso4217:USD' });
  assert.equal(snapshot.totalMarkets, 1);
  assert.deepEqual(snapshot.markets[0].supply, {
    offerCount: 0,
    remainingQuantity: '0',
    unitPriceRange: null,
  });
  assert.equal(snapshot.markets[0].constrainedDemand.quantity, '12');
  assert.equal(snapshot.markets[0].constrainedBalance, '-12');
  assert.deepEqual(snapshot.unconstrainedDemand, [{
    service: 'orbital-compute',
    unit: 'compute-second',
    rfqCount: 1,
    quantity: '4',
  }]);
});

test('uses deterministic market ordering and bounded market results', async () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  await createOffer(market, 'seller-b', { service: 'storage', unit: 'megabyte' });
  await createOffer(market, 'seller-a', { service: 'compute', unit: 'second' });

  const directory = new MarketLiquidityDirectory({ market, rfqMarket, clock });
  const all = await directory.snapshot();
  assert.deepEqual(all.markets.map((row) => row.service), ['compute', 'storage']);

  const bounded = await directory.snapshot({ limit: 1 });
  assert.equal(bounded.totalMarkets, 2);
  assert.equal(bounded.markets.length, 1);
  assert.equal(bounded.hasMore, true);
  assert.equal(bounded.markets[0].service, 'compute');
});

test('fails explicitly if supply or demand changes throughout snapshot assembly', async () => {
  let marketRevision = 0;
  const directory = new MarketLiquidityDirectory({
    maxRevisionRetries: 2,
    market: {
      getRevision: async () => marketRevision++,
      listOffers: async () => [],
    },
    rfqMarket: {
      getRevision: async () => 3,
      listRfqs: async () => [],
    },
  });

  await assert.rejects(
    directory.snapshot(),
    (error) => error.code === 'LIQUIDITY_CHANGED',
  );
});

test('rejects unbounded result requests', async () => {
  const directory = new MarketLiquidityDirectory({
    market: {
      getRevision: async () => 0,
      listOffers: async () => [],
    },
    rfqMarket: {
      getRevision: async () => 0,
      listRfqs: async () => [],
    },
  });

  await assert.rejects(directory.snapshot({ limit: 501 }), (error) => error.code === 'INVALID_REQUEST');
});
