import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function controlledClock(initial = '2026-09-01T00:00:00.000Z') {
  let current = new Date(initial);
  return {
    clock: () => new Date(current),
    set(value) { current = new Date(value); },
  };
}

async function fixture({ store = null, clockState = controlledClock() } = {}) {
  const market = await Clearinghouse.open({ store, clock: clockState.clock });
  const asset = await market.registerAsset({
    name: 'Relay One',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
  }, ctx('seller-a'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 300,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, ctx('seller-a'));
  return { market, asset, offer, clockState };
}

async function createRight(market, offer, overrides = {}, context = ctx('seller-a')) {
  return market.createCapacityRight({
    offerId: offer.id,
    holderId: 'buyer-a',
    quantity: 20,
    exerciseUnitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    reservationTtlSeconds: 120,
    expiresAt: '2026-09-01T00:30:00.000Z',
    metadata: { purpose: 'mission-contingency' },
    ...overrides,
  }, context);
}

function offerById(market, offerId) {
  return market.listOffers({ status: null }).then((offers) => offers.find((offer) => offer.id === offerId));
}

test('creating a capacity right removes real inventory from public availability immediately', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer);

  assert.equal(right.status, 'held');
  assert.equal(right.expiryDue, false);
  assert.equal(right.holderId, 'buyer-a');
  assert.equal(right.quantity, 20);
  assert.match(right.termsHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await offerById(market, offer.id)).remaining, 80);

  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 81 }, ctx('buyer-b')),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
  await assert.rejects(
    market.createCommercialCommitment({
      offerId: offer.id,
      buyerId: 'buyer-b',
      quantity: 81,
      unitPrice: offer.unitPrice,
      expiresAt: '2026-09-01T00:20:00.000Z',
    }, ctx('seller-a')),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
});

test('a right can hold the final available units and still exercise while the public offer is filled', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer, { quantity: 100 });
  const heldOffer = await offerById(market, offer.id);
  assert.equal(heldOffer.remaining, 0);
  assert.equal(heldOffer.status, 'filled');

  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-b')),
    (error) => error.code === 'CONFLICT',
  );

  const order = await market.exerciseCapacityRight(right.id, ctx('buyer-a'));
  assert.equal(order.quantity, 100);
  assert.deepEqual(order.unitPrice, right.exerciseUnitPrice);
  assert.deepEqual(order.total, { settlementAsset: 'iso4217:USD', amount: '2000', scale: 2 });
  assert.equal(order.capacityRight.id, right.id);
  assert.equal((await offerById(market, offer.id)).remaining, 0);
});

test('transfer changes exercise authority without touching held inventory', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer);
  const transferred = await market.transferCapacityRight(right.id, { toHolderId: 'buyer-b' }, ctx('buyer-a', {
    expectedVersion: right.version,
  }));

  assert.equal(transferred.holderId, 'buyer-b');
  assert.equal(transferred.version, 2);
  assert.equal(transferred.transfers.length, 1);
  assert.deepEqual(transferred.transfers[0], {
    sequence: 1,
    fromHolderId: 'buyer-a',
    toHolderId: 'buyer-b',
    transferredAt: transferred.updatedAt,
  });
  assert.equal((await offerById(market, offer.id)).remaining, 80);

  await assert.rejects(
    market.exerciseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'FORBIDDEN',
  );
  const order = await market.exerciseCapacityRight(right.id, ctx('buyer-b'));
  assert.equal(order.buyerId, 'buyer-b');
  assert.equal(order.capacityRight.id, right.id);
  assert.equal((await offerById(market, offer.id)).remaining, 80);

  const cancelled = await market.cancelOrder(order.id, ctx('buyer-b'));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await offerById(market, offer.id)).remaining, 100);
  assert.equal((await market.getCapacityRight(right.id, ctx('buyer-a'))).status, 'exercised');
});

test('previous holders retain audit visibility but lose mutation authority after transfer', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer);
  await market.transferCapacityRight(right.id, { toHolderId: 'buyer-b' }, ctx('buyer-a'));

  const historicalView = await market.getCapacityRight(right.id, ctx('buyer-a'));
  assert.equal(historicalView.holderId, 'buyer-b');
  assert.equal((await market.listCapacityRights(ctx('buyer-a'))).length, 1);

  await assert.rejects(
    market.transferCapacityRight(right.id, { toHolderId: 'buyer-c' }, ctx('buyer-a')),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    market.releaseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    market.getCapacityRight(right.id, ctx('unrelated')),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('release restores held capacity exactly once and cannot recreate the right', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer);
  const context = ctx('buyer-a', { idempotencyKey: 'release-right-1' });
  const first = await market.releaseCapacityRight(right.id, context);
  const replay = await market.releaseCapacityRight(right.id, context);

  assert.equal(first.status, 'released');
  assert.deepEqual(replay, first);
  assert.equal((await offerById(market, offer.id)).remaining, 100);
  await assert.rejects(
    market.releaseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'CONFLICT',
  );
  await assert.rejects(
    market.exerciseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'CONFLICT',
  );
  assert.equal((await offerById(market, offer.id)).remaining, 100);
});

test('overdue rights remain visibly held until explicit expiry restores inventory', async () => {
  const clockState = controlledClock();
  const { market, offer } = await fixture({ clockState });
  const right = await createRight(market, offer);
  clockState.set(right.expiresAt);

  const due = await market.getCapacityRight(right.id, ctx('buyer-a'));
  assert.equal(due.status, 'held');
  assert.equal(due.expiryDue, true);
  assert.equal((await offerById(market, offer.id)).remaining, 80);

  await assert.rejects(
    market.exerciseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'CAPACITY_RIGHT_EXPIRED',
  );
  await assert.rejects(
    market.releaseCapacityRight(right.id, ctx('buyer-a')),
    (error) => error.code === 'CAPACITY_RIGHT_EXPIRED',
  );

  const expired = await market.expireCapacityRight(right.id, ctx('operator'));
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expiryDue, false);
  assert.equal(expired.expiration.triggeredBy, 'operator');
  assert.equal((await offerById(market, offer.id)).remaining, 100);
  await assert.rejects(
    market.expireCapacityRight(right.id, ctx('operator-two')),
    (error) => error.code === 'CONFLICT',
  );
});

test('exercise uses immutable service price and does not decrement capacity a second time', async () => {
  const { market, offer } = await fixture();
  const right = await createRight(market, offer, {
    exerciseUnitPrice: { settlementAsset: 'iso4217:EUR', amount: '175', scale: 2 },
    reservationTtlSeconds: 60,
  });
  const beforeExercise = await offerById(market, offer.id);
  const order = await market.exerciseCapacityRight(right.id, ctx('buyer-a', { idempotencyKey: 'exercise-right-1' }));
  const replay = await market.exerciseCapacityRight(right.id, ctx('buyer-a', { idempotencyKey: 'exercise-right-1' }));

  assert.equal(order.id, replay.id);
  assert.deepEqual(order.unitPrice, { settlementAsset: 'iso4217:EUR', amount: '175', scale: 2 });
  assert.deepEqual(order.total, { settlementAsset: 'iso4217:EUR', amount: '3500', scale: 2 });
  assert.equal((await offerById(market, offer.id)).remaining, beforeExercise.remaining);
  assert.equal(order.capacityRight.termsHash, right.termsHash);
  assert.equal(order.fundingDueAt, '2026-09-01T00:01:00.000Z');

  await market.fundOrder(order.id, { amount: '3500', reference: 'external:funding:right-1' }, ctx('buyer-a'));
  await market.recordDelivery(order.id, { proof: { type: 'receipt', data: { quantity: 20 } } }, ctx('seller-a'));
  const settled = await market.settleOrder(order.id, { reference: 'external:settlement:right-1' }, ctx('buyer-a'));
  assert.equal(settled.status, 'settled');
  assert.deepEqual(settled.settlement.amount, order.total);
  assert.equal((await offerById(market, offer.id)).remaining, 80);
});

test('creation, transfer, and exercise idempotency survive restart', async () => {
  const store = new MemorySnapshotStore();
  const clockState = controlledClock();
  const { market, offer } = await fixture({ store, clockState });
  const createInput = {
    offerId: offer.id,
    holderId: 'buyer-a',
    quantity: 20,
    exerciseUnitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    expiresAt: '2026-09-01T00:30:00.000Z',
  };
  const createContext = ctx('seller-a', { idempotencyKey: 'create-held-right' });
  const created = await market.createCapacityRight(createInput, createContext);

  let reopened = await Clearinghouse.open({ store, clock: clockState.clock });
  assert.equal((await reopened.createCapacityRight(createInput, createContext)).id, created.id);
  const transferContext = ctx('buyer-a', { idempotencyKey: 'transfer-held-right' });
  const transferred = await reopened.transferCapacityRight(created.id, { toHolderId: 'buyer-b' }, transferContext);

  reopened = await Clearinghouse.open({ store, clock: clockState.clock });
  assert.equal((await reopened.transferCapacityRight(created.id, { toHolderId: 'buyer-b' }, transferContext)).version, transferred.version);
  const exerciseContext = ctx('buyer-b', { idempotencyKey: 'exercise-held-right' });
  const order = await reopened.exerciseCapacityRight(created.id, exerciseContext);

  reopened = await Clearinghouse.open({ store, clock: clockState.clock });
  assert.equal((await reopened.exerciseCapacityRight(created.id, exerciseContext)).id, order.id);
  assert.equal((await offerById(reopened, offer.id)).remaining, 80);
});

test('concurrent capacity-right creation across instances cannot oversubscribe one offer', async () => {
  const store = new MemorySnapshotStore();
  const clockState = controlledClock();
  const { market, offer } = await fixture({ store, clockState });
  const left = await Clearinghouse.open({ store, clock: clockState.clock });
  const right = await Clearinghouse.open({ store, clock: clockState.clock });

  const inputA = {
    offerId: offer.id,
    holderId: 'buyer-a',
    quantity: 60,
    exerciseUnitPrice: offer.unitPrice,
    expiresAt: '2026-09-01T00:30:00.000Z',
  };
  const inputB = { ...inputA, holderId: 'buyer-b' };
  const settled = await Promise.allSettled([
    left.createCapacityRight(inputA, ctx('seller-a')),
    right.createCapacityRight(inputB, ctx('seller-a')),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STORE_CONFLICT');

  const refreshedLoser = settled[0].status === 'rejected' ? left : right;
  await assert.rejects(
    refreshedLoser.createCapacityRight(inputB, ctx('seller-a')),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
  assert.equal((await offerById(refreshedLoser, offer.id)).remaining, 40);
  assert.equal((await market.listOffers({ status: null })).find((item) => item.id === offer.id).remaining, 100);
});

test('transfer versus exercise race has one durable winner and never changes held quantity twice', async () => {
  const store = new MemorySnapshotStore();
  const clockState = controlledClock();
  const { market, offer } = await fixture({ store, clockState });
  const right = await createRight(market, offer);
  const left = await Clearinghouse.open({ store, clock: clockState.clock });
  const rightWorker = await Clearinghouse.open({ store, clock: clockState.clock });

  const results = await Promise.allSettled([
    left.transferCapacityRight(right.id, { toHolderId: 'buyer-b' }, ctx('buyer-a')),
    rightWorker.exerciseCapacityRight(right.id, ctx('buyer-a')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'STORE_CONFLICT').length, 1);

  const observer = await Clearinghouse.open({ store, clock: clockState.clock });
  const state = await observer.getCapacityRight(right.id, ctx('seller-a'));
  assert.equal((await offerById(observer, offer.id)).remaining, 80);
  if (state.status === 'held') {
    assert.equal(state.holderId, 'buyer-b');
    assert.equal(state.orderId, null);
  } else {
    assert.equal(state.status, 'exercised');
    const order = await observer.getOrder(state.orderId);
    assert.equal(order.buyerId, 'buyer-a');
    assert.equal(order.quantity, 20);
  }
});

test('expiry versus exercise race has one winner even when workers observe opposite sides of the deadline', async () => {
  const store = new MemorySnapshotStore();
  const baseClock = controlledClock('2026-09-01T00:29:58.000Z');
  const { market, offer } = await fixture({ store, clockState: baseClock });
  const right = await createRight(market, offer, { expiresAt: '2026-09-01T00:30:00.000Z' });

  const earlyClock = () => new Date('2026-09-01T00:29:59.000Z');
  const dueClock = () => new Date('2026-09-01T00:30:00.000Z');
  const exerciser = await Clearinghouse.open({ store, clock: earlyClock });
  const expirer = await Clearinghouse.open({ store, clock: dueClock });
  const results = await Promise.allSettled([
    exerciser.exerciseCapacityRight(right.id, ctx('buyer-a')),
    expirer.expireCapacityRight(right.id, ctx('operator')),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'STORE_CONFLICT').length, 1);

  const observer = await Clearinghouse.open({ store, clock: dueClock });
  const state = await observer.getCapacityRight(right.id, ctx('seller-a'));
  if (state.status === 'expired') {
    assert.equal((await offerById(observer, offer.id)).remaining, 100);
  } else {
    assert.equal(state.status, 'exercised');
    assert.equal((await offerById(observer, offer.id)).remaining, 80);
  }
});

test('capacity-right immutable terms hash is canonical while holder transfers do not rewrite it', async () => {
  const leftFixture = await fixture();
  const rightFixture = await fixture();
  const left = await createRight(leftFixture.market, leftFixture.offer, {
    metadata: { alpha: 1, beta: { x: true, y: 'z' } },
  });
  const right = await createRight(rightFixture.market, rightFixture.offer, {
    metadata: { beta: { y: 'z', x: true }, alpha: 1 },
  });
  assert.equal(left.termsHash, right.termsHash);

  const transferred = await leftFixture.market.transferCapacityRight(left.id, { toHolderId: 'buyer-b' }, ctx('buyer-a'));
  assert.equal(transferred.termsHash, left.termsHash);
});

test('invalid holder, deadlines, quantities, and exercise prices fail before capacity moves', async () => {
  const { market, offer } = await fixture();
  const remaining = (await offerById(market, offer.id)).remaining;

  await assert.rejects(
    createRight(market, offer, { holderId: 'seller-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    createRight(market, offer, { quantity: 101 }),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
  await assert.rejects(
    createRight(market, offer, { expiresAt: '2026-09-04T00:00:00.000Z' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    createRight(market, offer, { exerciseUnitPrice: { settlementAsset: 'iso4217:USD', amount: '0', scale: 2 } }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.equal((await offerById(market, offer.id)).remaining, remaining);
});
