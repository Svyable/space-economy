import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
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

async function createMatchingRfq(book, overrides = {}, context = { actorId: 'buyer-a' }) {
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
  }, context);
}

test('buyer demand can be quoted from real capacity and accepted into an ordinary clearinghouse order', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createMatchingRfq(book);
  const quote = await book.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' });

  assert.equal(quote.quantity, 20);
  assert.deepEqual(quote.unitPrice, offer.unitPrice);
  assert.deepEqual(quote.total, { settlementAsset: 'iso4217:USD', amount: '500', scale: 2 });
  assert.equal(quote.offerVersionAtQuote, offer.version);

  const awarded = await book.acceptQuote(quote.id, { actorId: 'buyer-a', expectedVersion: rfq.version });
  assert.equal(awarded.rfq.status, 'awarded');
  assert.equal(awarded.quote.status, 'accepted');
  assert.equal(awarded.rfq.orderId, awarded.order.id);
  assert.equal(awarded.quote.orderId, awarded.order.id);
  assert.equal(awarded.order.status, 'reserved');
  assert.equal(awarded.order.quantity, 20);
  assert.deepEqual(awarded.order.unitPrice, offer.unitPrice);
  assert.equal((await market.listOffers({ status: null })).find((item) => item.id === offer.id).remaining, 80);
});

test('accepting the same quote again reuses the awarded order and does not reserve capacity twice', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createMatchingRfq(book);
  const quote = await book.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' });

  const first = await book.acceptQuote(quote.id, { actorId: 'buyer-a' });
  const second = await book.acceptQuote(quote.id, { actorId: 'buyer-a' });
  assert.equal(second.order.id, first.order.id);
  assert.equal((await market.listOffers({ status: null })).find((item) => item.id === offer.id).remaining, 80);
});

test('quote validation enforces exact decimal price ceilings, capabilities, service windows, and seller ownership', async () => {
  const { book, offer } = await fixture();
  const priceTooLow = await createMatchingRfq(book, {
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '249', scale: 3 },
  });
  await assert.rejects(
    book.submitQuote(priceTooLow.id, { offerId: offer.id }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_PRICE_EXCEEDED',
  );

  const capabilityMismatch = await createMatchingRfq(book, { requiredCapabilities: ['optical-crosslink'] }, { actorId: 'buyer-b' });
  await assert.rejects(
    book.submitQuote(capabilityMismatch.id, { offerId: offer.id }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );

  const windowMismatch = await createMatchingRfq(book, {
    serviceWindowStart: '2026-09-03T00:00:00.000Z',
    serviceWindowEnd: '2026-09-03T01:00:00.000Z',
  }, { actorId: 'buyer-c' });
  await assert.rejects(
    book.submitQuote(windowMismatch.id, { offerId: offer.id }, { actorId: 'seller-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );

  const wrongSeller = await createMatchingRfq(book, {}, { actorId: 'buyer-d' });
  await assert.rejects(
    book.submitQuote(wrongSeller.id, { offerId: offer.id }, { actorId: 'seller-b' }),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('if quoted capacity disappears before award, the quote becomes unavailable and the RFQ reopens', async () => {
  const { market, book, offer } = await fixture();
  const rfq = await createMatchingRfq(book, { quantity: 80 });
  const quote = await book.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' });

  await market.createOrder({ offerId: offer.id, quantity: 30 }, { actorId: 'other-buyer' });

  await assert.rejects(
    book.acceptQuote(quote.id, { actorId: 'buyer-a' }),
    (error) => error.code === 'QUOTE_UNAVAILABLE' && error.details.causeCode === 'INSUFFICIENT_CAPACITY',
  );
  assert.equal((await book.getRfq(rfq.id)).status, 'open');
  const unavailable = await book.getQuote(quote.id);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.closedReason, 'INSUFFICIENT_CAPACITY');
});

test('RFQ and quote expiry is derived without mutating persisted state', async () => {
  const { book, offer, setNow } = await fixture();
  const rfq = await createMatchingRfq(book, { expiresAt: '2026-09-01T00:10:00.000Z' });
  const quote = await book.submitQuote(rfq.id, {
    offerId: offer.id,
    validUntil: '2026-09-01T00:05:00.000Z',
  }, { actorId: 'seller-a' });

  setNow('2026-09-01T00:05:00.000Z');
  assert.equal((await book.getQuote(quote.id)).status, 'expired');
  assert.equal((await book.getRfq(rfq.id)).status, 'open');
  await assert.rejects(book.acceptQuote(quote.id, { actorId: 'buyer-a' }), (error) => error.code === 'QUOTE_EXPIRED');

  setNow('2026-09-01T00:10:00.000Z');
  assert.equal((await book.getRfq(rfq.id)).status, 'expired');
});

test('RFQ commands are durably idempotent and survive reopening the book', async () => {
  const { market, clock } = await fixture();
  const store = new MemorySnapshotStore();
  const first = await RfqMarket.open({ market, clock, store });
  const input = {
    service: 'data-relay',
    unit: 'MB',
    quantity: 5,
    expiresAt: '2026-09-01T01:00:00.000Z',
  };
  const context = { actorId: 'buyer-a', idempotencyKey: 'rfq-1' };
  const created = await first.createRfq(input, context);
  const replay = await first.createRfq(input, context);
  assert.equal(replay.id, created.id);

  await assert.rejects(
    first.createRfq({ ...input, quantity: 6 }, context),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );

  const reopened = await RfqMarket.open({ market, clock, store });
  assert.equal((await reopened.getRfq(created.id)).id, created.id);
  assert.equal((await reopened.createRfq(input, context)).id, created.id);
});

test('cancelling an RFQ closes active quotes while a seller can withdraw its own quote', async () => {
  const { book, offer } = await fixture();
  const rfq = await createMatchingRfq(book);
  const quote = await book.submitQuote(rfq.id, { offerId: offer.id }, { actorId: 'seller-a' });
  const withdrawn = await book.withdrawQuote(quote.id, { actorId: 'seller-a' });
  assert.equal(withdrawn.status, 'withdrawn');

  const rfqTwo = await createMatchingRfq(book, {}, { actorId: 'buyer-b' });
  const quoteTwo = await book.submitQuote(rfqTwo.id, { offerId: offer.id }, { actorId: 'seller-a' });
  const cancelled = await book.cancelRfq(rfqTwo.id, { actorId: 'buyer-b' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await book.getQuote(quoteTwo.id)).status, 'closed');
  assert.equal((await book.getQuote(quoteTwo.id)).closedReason, 'rfq-cancelled');
});
