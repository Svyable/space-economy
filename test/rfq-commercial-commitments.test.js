import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MultiAwardProcurementCoordinator } from '../src/multi-award-procurement.js';
import { RfqMarket } from '../src/rfq-market.js';
import { MemorySnapshotStore } from '../src/store.js';

async function fixture() {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const asset = await market.registerAsset({
    name: 'Relay One',
    type: 'communications-satellite',
    capabilities: ['data-relay', 'store-and-forward'],
  }, { actorId: 'seller-a' });
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 300,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, { actorId: 'seller-a' });
  const book = await RfqMarket.open({ market, clock });
  return {
    market,
    book,
    asset,
    offer,
    clock,
    setNow(value) { now = new Date(value); },
  };
}

async function createRfq(book, overrides = {}, actorId = 'buyer-a') {
  return book.createRfq({
    service: 'data-relay',
    unit: 'MB',
    quantity: 20,
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '30', scale: 2 },
    requiredCapabilities: ['data-relay'],
    serviceWindowStart: '2026-09-02T06:00:00.000Z',
    serviceWindowEnd: '2026-09-02T12:00:00.000Z',
    expiresAt: '2026-09-01T01:00:00.000Z',
    ...overrides,
  }, { actorId });
}

async function createCommitment(market, offer, overrides = {}) {
  return market.createCommercialCommitment({
    offerId: offer.id,
    buyerId: 'buyer-a',
    quantity: 20,
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    reservationTtlSeconds: 120,
    expiresAt: '2026-09-01T00:30:00.000Z',
    metadata: { negotiation: 'rfq' },
    ...overrides,
  }, { actorId: 'seller-a' });
}

test('RFQ acceptance enforces negotiated commercial terms instead of the public offer price', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createRfq(book, {
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '22', scale: 2 },
  });

  await assert.rejects(
    book.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_PRICE_EXCEEDED',
  );

  const commitment = await createCommitment(market, offer);
  const quote = await book.submitQuote(rfq.id, {
    offerId: offer.id,
    commercialCommitmentId: commitment.id,
  }, { actorId: 'seller-a' });

  assert.equal(quote.pricingSource, 'commercial-commitment');
  assert.equal(quote.commercialCommitmentId, commitment.id);
  assert.equal(quote.commercialTermsHash, commitment.termsHash);
  assert.deepEqual(quote.unitPrice, commitment.unitPrice);
  assert.deepEqual(quote.total, { settlementAsset: 'iso4217:USD', amount: '400', scale: 2 });
  assert.equal(quote.validUntil, commitment.expiresAt);
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 100);

  const award = await book.acceptQuote(quote.id, { actorId: 'buyer-a' });
  assert.deepEqual(award.order.unitPrice, commitment.unitPrice);
  assert.deepEqual(award.order.total, quote.total);
  assert.equal(award.order.commercialCommitment.id, commitment.id);
  assert.equal(award.order.commercialCommitment.termsHash, commitment.termsHash);
  assert.equal((await market.getCommercialCommitment(commitment.id, { actorId: 'buyer-a' })).status, 'exercised');
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 80);
});

test('a negotiated settlement asset can satisfy an RFQ even when the public listing uses another asset', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createRfq(book, {
    settlementAsset: 'iso4217:EUR',
    maxUnitPrice: { settlementAsset: 'iso4217:EUR', amount: '19', scale: 2 },
  });
  const commitment = await createCommitment(market, offer, {
    unitPrice: { settlementAsset: 'iso4217:EUR', amount: '18', scale: 2 },
  });

  const quote = await book.submitQuote(rfq.id, {
    offerId: offer.id,
    commercialCommitmentId: commitment.id,
  }, { actorId: 'seller-a' });
  assert.deepEqual(quote.unitPrice, { settlementAsset: 'iso4217:EUR', amount: '18', scale: 2 });

  const award = await book.acceptQuote(quote.id, { actorId: 'buyer-a' });
  assert.deepEqual(award.order.total, { settlementAsset: 'iso4217:EUR', amount: '360', scale: 2 });
  assert.deepEqual((await market.listOffers({ status: null }))[0].unitPrice, offer.unitPrice);
});

test('commitment-backed quote validation binds buyer, quantity, price, asset and deadline', async () => {
  const { market, book, offer } = await fixture();

  const wrongBuyerRfq = await createRfq(book, {}, 'buyer-b');
  const buyerACommitment = await createCommitment(market, offer);
  await assert.rejects(
    book.submitQuote(wrongBuyerRfq.id, {
      offerId: offer.id,
      commercialCommitmentId: buyerACommitment.id,
    }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );

  const quantityRfq = await createRfq(book, { quantity: 10 });
  await assert.rejects(
    book.submitQuote(quantityRfq.id, {
      offerId: offer.id,
      commercialCommitmentId: buyerACommitment.id,
    }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );

  const priceRfq = await createRfq(book, {
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '19', scale: 2 },
  });
  await assert.rejects(
    book.submitQuote(priceRfq.id, {
      offerId: offer.id,
      commercialCommitmentId: buyerACommitment.id,
    }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_PRICE_EXCEEDED',
  );

  const assetRfq = await createRfq(book, {
    settlementAsset: 'iso4217:EUR',
    maxUnitPrice: { settlementAsset: 'iso4217:EUR', amount: '30', scale: 2 },
  });
  await assert.rejects(
    book.submitQuote(assetRfq.id, {
      offerId: offer.id,
      commercialCommitmentId: buyerACommitment.id,
    }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );

  const deadlineRfq = await createRfq(book);
  await assert.rejects(
    book.submitQuote(deadlineRfq.id, {
      offerId: offer.id,
      commercialCommitmentId: buyerACommitment.id,
      validUntil: '2026-09-01T00:31:00.000Z',
    }, { actorId: 'seller-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('revoking negotiated terms after quote submission makes only that quote unavailable and reopens the RFQ', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createRfq(book);
  const commitment = await createCommitment(market, offer);
  const quote = await book.submitQuote(rfq.id, {
    offerId: offer.id,
    commercialCommitmentId: commitment.id,
  }, { actorId: 'seller-a' });

  await market.revokeCommercialCommitment(commitment.id, { actorId: 'seller-a' });
  await assert.rejects(
    book.acceptQuote(quote.id, { actorId: 'buyer-a' }),
    (error) => error.code === 'QUOTE_UNAVAILABLE' && error.details.causeCode === 'CONFLICT',
  );

  assert.equal((await book.getRfq(rfq.id)).status, 'open');
  const unavailable = await book.getQuote(quote.id);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.closedReason, 'CONFLICT');
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 100);
});

test('awarded commitment quote is replay-safe across an RFQ book restart', async () => {
  const { market, clock, offer } = await fixture();
  const store = new MemorySnapshotStore();
  const first = await RfqMarket.open({ market, clock, store });
  const rfq = await createRfq(first);
  const commitment = await createCommitment(market, offer);
  const quote = await first.submitQuote(rfq.id, {
    offerId: offer.id,
    commercialCommitmentId: commitment.id,
  }, { actorId: 'seller-a' });
  const awarded = await first.acceptQuote(quote.id, { actorId: 'buyer-a' });

  const reopened = await RfqMarket.open({ market, clock, store });
  const replay = await reopened.acceptQuote(quote.id, { actorId: 'buyer-a' });
  assert.equal(replay.order.id, awarded.order.id);
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 80);
});

test('RFQ schema v1 snapshots without commitment fields remain readable as public-offer quotes', async () => {
  const store = new MemorySnapshotStore({
    schemaVersion: 1,
    revision: 1,
    rfqs: [{
      id: 'rfq-legacy',
      buyerId: 'buyer-a',
      service: 'relay',
      unit: 'MB',
      quantity: 1,
      settlementAsset: null,
      maxUnitPrice: null,
      requiredCapabilities: [],
      serviceWindowStart: null,
      serviceWindowEnd: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      metadata: {},
      status: 'open',
      acceptedQuoteId: null,
      orderId: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    quotes: [{
      id: 'quote-legacy',
      rfqId: 'rfq-legacy',
      offerId: 'offer-legacy',
      assetId: 'asset-legacy',
      sellerId: 'seller-a',
      quantity: 1,
      unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
      total: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
      offerVersionAtQuote: 1,
      validUntil: '2099-01-01T00:00:00.000Z',
      metadata: {},
      status: 'active',
      closedReason: null,
      orderId: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    idempotency: [],
  });
  const market = await Clearinghouse.open();
  const book = await RfqMarket.open({ market, store });
  const quote = await book.getQuote('quote-legacy');
  assert.equal(quote.pricingSource, 'public-offer');
  assert.equal(quote.commercialCommitmentId, null);
  assert.equal(quote.commercialTermsHash, null);
});

test('multi-award lots inherit negotiated terms through ordinary RFQ acceptance', async () => {
  const { market, book, offer, clock } = await fixture();
  const coordinator = await MultiAwardProcurementCoordinator.open({ rfqMarket: book, clock });
  const program = await coordinator.createProgram({
    name: 'Split relay buy',
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '22', scale: 2 },
    requiredCapabilities: ['data-relay'],
    serviceWindowStart: '2026-09-02T06:00:00.000Z',
    serviceWindowEnd: '2026-09-02T12:00:00.000Z',
    expiresAt: '2026-09-01T01:00:00.000Z',
    lots: [
      { lotId: 'primary', quantity: 10 },
      { lotId: 'backup', quantity: 15 },
    ],
  }, { actorId: 'buyer-a' });
  const opened = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });

  const awards = [];
  for (const [index, lot] of opened.lots.entries()) {
    const commitment = await createCommitment(market, offer, {
      quantity: lot.quantity,
      unitPrice: { settlementAsset: 'iso4217:USD', amount: String(18 + index), scale: 2 },
    });
    const quote = await book.submitQuote(lot.rfqId, {
      offerId: offer.id,
      commercialCommitmentId: commitment.id,
    }, { actorId: 'seller-a' });
    awards.push(await coordinator.acceptLotQuote(program.id, lot.lotId, quote.id, { actorId: 'buyer-a' }));
  }

  assert.equal(awards[0].award.order.quantity, 10);
  assert.equal(awards[0].award.order.unitPrice.amount, '18');
  assert.equal(awards[1].award.order.quantity, 15);
  assert.equal(awards[1].award.order.unitPrice.amount, '19');
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 75);
});
