import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MarketPriceHistoryDirectory } from '../src/market-price-history.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function controlledClock(initial) {
  let current = new Date(initial);
  return {
    clock: () => new Date(current),
    set(value) { current = new Date(value); },
  };
}

async function fixture({ capacity = 10, reservationTtlSeconds = 300, clock = () => new Date('2026-09-01T00:00:00.000Z'), store = null } = {}) {
  const market = await Clearinghouse.open({ clock, ...(store ? { store } : {}) });
  const asset = await market.registerAsset({
    name: 'Relay-terms',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
  }, ctx('seller-a'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1250', scale: 2 },
    capacity,
    reservationTtlSeconds,
    windowStart: '2026-09-01T00:00:00.000Z',
    windowEnd: '2026-09-01T02:00:00.000Z',
  }, ctx('seller-a'));
  return { market, asset, offer };
}

async function createCommitment(market, offer, overrides = {}, context = ctx('seller-a')) {
  return market.createCommercialCommitment({
    offerId: offer.id,
    buyerId: 'buyer-a',
    quantity: 4,
    unitPrice: { settlementAsset: 'iso4217:EUR', amount: '900', scale: 2 },
    reservationTtlSeconds: 120,
    expiresAt: '2026-09-01T00:30:00.000Z',
    metadata: { procurementRef: 'rfq-future-1' },
    ...overrides,
  }, context);
}

test('seller-authorized terms create an ordinary order at the negotiated exact price without pre-reserving capacity', async () => {
  const time = controlledClock('2026-09-01T00:00:00.000Z');
  const { market, offer } = await fixture({ clock: time.clock });
  const commitment = await createCommitment(market, offer);

  assert.equal(commitment.status, 'active');
  assert.match(commitment.termsHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await market.listOffers())[0].remaining, 10, 'issuing terms must not reserve capacity');

  const order = await market.exerciseCommercialCommitment(commitment.id, ctx('buyer-a', { expectedVersion: 1 }));
  assert.deepEqual(order.unitPrice, { settlementAsset: 'iso4217:EUR', amount: '900', scale: 2 });
  assert.deepEqual(order.total, { settlementAsset: 'iso4217:EUR', amount: '3600', scale: 2 });
  assert.equal(order.quantity, 4);
  assert.equal(order.fundingDueAt, '2026-09-01T00:02:00.000Z');
  assert.deepEqual(order.commercialCommitment, { id: commitment.id, termsHash: commitment.termsHash });

  const currentOffer = (await market.listOffers({ status: null }))[0];
  assert.equal(currentOffer.remaining, 6);
  assert.deepEqual(currentOffer.unitPrice, { settlementAsset: 'iso4217:USD', amount: '1250', scale: 2 }, 'public listing price stays unchanged');

  const exercised = await market.getCommercialCommitment(commitment.id, ctx('seller-a'));
  assert.equal(exercised.status, 'exercised');
  assert.equal(exercised.orderId, order.id);

  await market.fundOrder(order.id, { amount: '3600', reference: 'funding:negotiated' }, ctx('buyer-a'));
  await market.recordDelivery(order.id, { proof: { type: 'receipt', data: { deliveredQuantity: 4 } } }, ctx('seller-a'));
  await market.settleOrder(order.id, { reference: 'settlement:negotiated' }, ctx('buyer-a'));

  const history = new MarketPriceHistoryDirectory({ market });
  const benchmark = await history.getBenchmark({
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:EUR',
  });
  assert.equal(benchmark.observations, 1);
  assert.deepEqual(benchmark.unitPrice.low, { settlementAsset: 'iso4217:EUR', amount: '900', scale: 2 });
  assert.deepEqual(benchmark.settledNotional, { settlementAsset: 'iso4217:EUR', amount: '3600', scale: 2 });
  assert.equal(await market.verifyLedger(), true);
});

test('commercial commitments bind seller and buyer identity and fail closed after revocation or expiry', async () => {
  const time = controlledClock('2026-09-01T00:00:00.000Z');
  const { market, offer } = await fixture({ clock: time.clock });

  await assert.rejects(
    createCommitment(market, offer, {}, ctx('impostor')),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    createCommitment(market, offer, { buyerId: 'seller-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );

  const revocable = await createCommitment(market, offer, { buyerId: 'buyer-a' });
  await assert.rejects(
    market.getCommercialCommitment(revocable.id, ctx('buyer-b')),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    market.exerciseCommercialCommitment(revocable.id, ctx('buyer-b')),
    (error) => error.code === 'FORBIDDEN',
  );
  const revoked = await market.revokeCommercialCommitment(revocable.id, ctx('seller-a', { expectedVersion: 1 }));
  assert.equal(revoked.status, 'revoked');
  await assert.rejects(
    market.exerciseCommercialCommitment(revocable.id, ctx('buyer-a')),
    (error) => error.code === 'CONFLICT',
  );

  const expiring = await createCommitment(market, offer, {
    buyerId: 'buyer-b',
    expiresAt: '2026-09-01T00:05:00.000Z',
  });
  time.set('2026-09-01T00:05:00.000Z');
  assert.equal((await market.getCommercialCommitment(expiring.id, ctx('buyer-b'))).status, 'expired');
  await assert.rejects(
    market.exerciseCommercialCommitment(expiring.id, ctx('buyer-b')),
    (error) => error.code === 'COMMITMENT_EXPIRED',
  );
  await assert.rejects(
    market.revokeCommercialCommitment(expiring.id, ctx('seller-a')),
    (error) => error.code === 'COMMITMENT_EXPIRED',
  );
});

test('commitment issuance does not hold capacity and a failed exercise leaves terms active for a later retry', async () => {
  const { market, offer } = await fixture({ capacity: 5 });
  const commitment = await createCommitment(market, offer, { quantity: 5 });
  const publicOrder = await market.createOrder({ offerId: offer.id, quantity: 5 }, ctx('buyer-b'));

  await assert.rejects(
    market.exerciseCommercialCommitment(commitment.id, ctx('buyer-a')),
    (error) => error.code === 'CONFLICT' || error.code === 'INSUFFICIENT_CAPACITY',
  );
  assert.equal((await market.getCommercialCommitment(commitment.id, ctx('buyer-a'))).status, 'active');

  await market.cancelOrder(publicOrder.id, ctx('buyer-b'));
  const negotiated = await market.exerciseCommercialCommitment(commitment.id, ctx('buyer-a'));
  assert.equal(negotiated.quantity, 5);
  assert.equal((await market.listOffers({ status: null }))[0].remaining, 0);
});

test('commercial commitment creation and exercise are durably idempotent across restart', async () => {
  const store = new MemorySnapshotStore();
  const { market, offer } = await fixture({ store });
  const createContext = ctx('seller-a', { idempotencyKey: 'terms-1' });
  const first = await createCommitment(market, offer, {}, createContext);

  const restarted = await Clearinghouse.open({ store, clock: () => new Date('2026-09-01T00:00:00.000Z') });
  const replayed = await createCommitment(restarted, offer, {}, createContext);
  assert.equal(replayed.id, first.id);

  const exerciseContext = ctx('buyer-a', { idempotencyKey: 'exercise-1' });
  const order = await restarted.exerciseCommercialCommitment(first.id, exerciseContext);
  const restartedAgain = await Clearinghouse.open({ store, clock: () => new Date('2026-09-01T00:00:00.000Z') });
  const replayedOrder = await restartedAgain.exerciseCommercialCommitment(first.id, exerciseContext);
  assert.equal(replayedOrder.id, order.id);
  assert.equal((await restartedAgain.listOffers({ status: null }))[0].remaining, 6);

  const reservedEvents = (await restartedAgain.getLedger()).filter((event) => event.type === 'spaceeconomy.order.reserved.v1');
  assert.equal(reservedEvents.length, 1);
});

test('overlapping non-reserving commitments cannot oversubscribe capacity across competing clearinghouse instances', async () => {
  const store = new MemorySnapshotStore();
  const { market, offer } = await fixture({ capacity: 5, store });
  const leftTerms = await createCommitment(market, offer, { buyerId: 'buyer-a', quantity: 5 });
  const rightTerms = await createCommitment(market, offer, { buyerId: 'buyer-b', quantity: 5 });

  const left = await Clearinghouse.open({ store, clock: () => new Date('2026-09-01T00:00:00.000Z') });
  const right = await Clearinghouse.open({ store, clock: () => new Date('2026-09-01T00:00:00.000Z') });
  const results = await Promise.allSettled([
    left.exerciseCommercialCommitment(leftTerms.id, ctx('buyer-a')),
    right.exerciseCommercialCommitment(rightTerms.id, ctx('buyer-b')),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STORE_CONFLICT');

  const current = await Clearinghouse.open({ store, clock: () => new Date('2026-09-01T00:00:00.000Z') });
  assert.equal((await current.listOffers({ status: null }))[0].remaining, 0);
  assert.equal((await current.getLedger()).filter((event) => event.type === 'spaceeconomy.order.reserved.v1').length, 1);
  const commitments = await current.listCommercialCommitments(ctx('seller-a'));
  assert.equal(commitments.filter((commitment) => commitment.status === 'exercised').length, 1);
  assert.equal(commitments.filter((commitment) => commitment.status === 'active').length, 1);
});

test('terms hash is canonical and excludes mutable lifecycle fields', async () => {
  const { market, offer } = await fixture();
  const first = await createCommitment(market, offer, {
    metadata: { alpha: 1, beta: { x: 2, y: 3 } },
  });
  const second = await createCommitment(market, offer, {
    metadata: { beta: { y: 3, x: 2 }, alpha: 1 },
  });
  assert.equal(first.termsHash, second.termsHash);
  assert.notEqual(first.id, second.id);

  await market.revokeCommercialCommitment(first.id, ctx('seller-a'));
  const after = await market.getCommercialCommitment(first.id, ctx('seller-a'));
  assert.equal(after.termsHash, first.termsHash);
});

test('commercial commitment inputs enforce bounded quantity, validity, and exact money', async () => {
  const { market, offer } = await fixture({ capacity: 5 });
  await assert.rejects(
    createCommitment(market, offer, { quantity: 6 }),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
  await assert.rejects(
    createCommitment(market, offer, { expiresAt: '2026-09-01T02:00:00.001Z' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    createCommitment(market, offer, { unitPrice: { settlementAsset: 'iso4217:EUR', amount: '9.5', scale: 2 } }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    createCommitment(market, offer, { reservationTtlSeconds: 0 }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
