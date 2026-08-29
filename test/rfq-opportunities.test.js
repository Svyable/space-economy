import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { RfqMarket } from '../src/rfq-market.js';
import { RfqOpportunityDirectory } from '../src/rfq-opportunities.js';

async function createOffer(market, sellerId, {
  name = 'relay-node',
  service = 'data-relay',
  unit = 'second',
  amount = '125',
  scale = 2,
  settlementAsset = 'iso4217:USD',
  capacity = 20,
  capabilities = ['optical', 'leo'],
  windowStart = '2026-08-29T19:00:00.000Z',
  windowEnd = '2026-08-29T22:00:00.000Z',
} = {}) {
  const asset = await market.registerAsset({
    name,
    type: 'relay',
    capabilities,
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service,
    unit,
    unitPrice: { settlementAsset, amount, scale },
    capacity,
    windowStart,
    windowEnd,
  }, { actorId: sellerId });
}

async function createRfq(rfqMarket, buyerId, overrides = {}) {
  return rfqMarket.createRfq({
    service: 'data-relay',
    unit: 'second',
    quantity: 5,
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '1250', scale: 3 },
    requiredCapabilities: ['optical'],
    serviceWindowStart: '2026-08-29T19:30:00.000Z',
    serviceWindowEnd: '2026-08-29T20:00:00.000Z',
    expiresAt: '2026-08-29T18:30:00.000Z',
    ...overrides,
  }, { actorId: buyerId });
}

test('returns only RFQ/offer pairs that pass the real quote eligibility path', async () => {
  let now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  const sellerId = 'seller-a';
  const offer = await createOffer(market, sellerId);

  const matching = await createRfq(rfqMarket, 'buyer-match');
  await createRfq(rfqMarket, 'buyer-capacity', { quantity: 25 });
  await createRfq(rfqMarket, 'buyer-price', {
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '124', scale: 2 },
  });
  await createRfq(rfqMarket, 'buyer-capability', { requiredCapabilities: ['ka-band'] });
  await createRfq(rfqMarket, 'buyer-unit', { unit: 'megabyte' });
  await createRfq(rfqMarket, sellerId);
  await createRfq(rfqMarket, 'buyer-currency', {
    settlementAsset: 'iso4217:EUR',
    maxUnitPrice: { settlementAsset: 'iso4217:EUR', amount: '200', scale: 2 },
  });
  await createRfq(rfqMarket, 'buyer-window', {
    serviceWindowStart: '2026-08-29T18:30:00.000Z',
    serviceWindowEnd: '2026-08-29T20:00:00.000Z',
  });

  const directory = new RfqOpportunityDirectory({ rfqMarket, market, clock });
  const result = await directory.listOpportunities({ sellerId });

  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.opportunities[0].rfqId, matching.id);
  assert.equal(result.opportunities[0].offerId, offer.id);
  assert.deepEqual(result.opportunities[0].unitPrice, offer.unitPrice);
  assert.deepEqual(result.opportunities[0].total, {
    settlementAsset: 'iso4217:USD',
    amount: '625',
    scale: 2,
  });
  assert.equal(result.opportunities[0].remaining, 20);
  assert.ok(Number.isSafeInteger(result.rfqRevision));
  assert.ok(Number.isSafeInteger(result.marketRevision));

  const quote = await rfqMarket.submitQuote(
    result.opportunities[0].rfqId,
    { offerId: result.opportunities[0].offerId },
    { actorId: sellerId },
  );
  assert.equal(quote.rfqId, matching.id);
  assert.equal(quote.offerId, offer.id);

  const afterQuote = await directory.listOpportunities({ sellerId });
  assert.equal(afterQuote.total, 0);
});

test('filters expired demand at read time without mutating the RFQ book', async () => {
  let now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  await createOffer(market, 'seller-a');
  const rfq = await createRfq(rfqMarket, 'buyer-a', { expiresAt: '2026-08-29T18:05:00.000Z' });

  const directory = new RfqOpportunityDirectory({ rfqMarket, market, clock });
  assert.equal((await directory.listOpportunities({ sellerId: 'seller-a' })).total, 1);
  const revisionBeforeExpiryRead = await rfqMarket.getRevision();

  now = new Date('2026-08-29T18:05:00.000Z');
  const expired = await directory.listOpportunities({ sellerId: 'seller-a' });
  assert.equal(expired.total, 0);
  assert.equal(await rfqMarket.getRevision(), revisionBeforeExpiryRead);
  assert.equal((await rfqMarket.getRfq(rfq.id)).status, 'expired');
});

test('orders opportunities deterministically and reports bounded result metadata', async () => {
  const now = new Date('2026-08-29T18:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  await createOffer(market, 'seller-a', { name: 'relay-a' });
  await createOffer(market, 'seller-a', { name: 'relay-b' });
  const later = await createRfq(rfqMarket, 'buyer-later', { expiresAt: '2026-08-29T18:40:00.000Z' });
  const sooner = await createRfq(rfqMarket, 'buyer-sooner', { expiresAt: '2026-08-29T18:20:00.000Z' });

  const directory = new RfqOpportunityDirectory({ rfqMarket, market, clock });
  const all = await directory.listOpportunities({ sellerId: 'seller-a' });
  assert.equal(all.total, 4);
  assert.deepEqual(all.opportunities.slice(0, 2).map((item) => item.rfqId), [sooner.id, sooner.id]);
  assert.deepEqual(all.opportunities.slice(2).map((item) => item.rfqId), [later.id, later.id]);

  const bounded = await directory.listOpportunities({ sellerId: 'seller-a', limit: 1 });
  assert.equal(bounded.total, 4);
  assert.equal(bounded.opportunities.length, 1);
  assert.equal(bounded.hasMore, true);
  assert.equal(bounded.opportunities[0].rfqId, sooner.id);
});

test('fails explicitly instead of mixing changing RFQ and capacity snapshots', async () => {
  let rfqRevision = 0;
  const directory = new RfqOpportunityDirectory({
    maxRevisionRetries: 2,
    rfqMarket: {
      getRevision: async () => rfqRevision++,
      listRfqs: async () => [],
      listQuotes: async () => [],
    },
    market: {
      getRevision: async () => 7,
      listOffers: async () => [],
      listAssets: async () => [],
    },
  });

  await assert.rejects(
    directory.listOpportunities({ sellerId: 'seller-a' }),
    (error) => error.code === 'OPPORTUNITIES_CHANGED',
  );
});

test('requires an explicit seller and bounded result size', async () => {
  const directory = new RfqOpportunityDirectory({
    rfqMarket: {
      getRevision: async () => 0,
      listRfqs: async () => [],
      listQuotes: async () => [],
    },
    market: {
      getRevision: async () => 0,
      listOffers: async () => [],
      listAssets: async () => [],
    },
  });

  await assert.rejects(directory.listOpportunities(), (error) => error.code === 'INVALID_REQUEST');
  await assert.rejects(
    directory.listOpportunities({ sellerId: 'seller-a', limit: 501 }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
