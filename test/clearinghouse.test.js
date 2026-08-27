import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function controlledClock(initial) {
  let current = new Date(initial);
  return {
    clock: () => new Date(current),
    set(value) { current = new Date(value); },
  };
}

async function fixture(options = {}) {
  const market = await Clearinghouse.open(options);
  const asset = await market.registerAsset({
    name: 'Relay-7',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
    identifiers: [
      { scheme: 'cospar', value: '2026-001A' },
      { scheme: 'norad-cat-id', value: '99999' },
    ],
    location: { orbit: 'LEO', inclinationDeg: 51.6 },
  }, ctx('orbital-relay-co'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1250', scale: 2 },
    capacity: 100,
  }, ctx('orbital-relay-co'));
  return { market, asset, offer };
}

test('settles a capacity-backed service with exact monetary arithmetic', async () => {
  const { market, offer } = await fixture();
  const order = await market.createOrder({ offerId: offer.id, quantity: 8 }, ctx('lunar-imaging-inc'));
  assert.deepEqual(order.total, { settlementAsset: 'iso4217:USD', amount: '10000', scale: 2 });
  assert.equal(order.status, 'reserved');

  await market.fundOrder(order.id, { amount: '10000', reference: 'sandbox:funding:001' }, ctx('lunar-imaging-inc'));
  await market.recordDelivery(order.id, {
    proof: { type: 'packet-receipt', data: { receipt: 'sha256:example', deliveredQuantity: 8 } },
  }, ctx('orbital-relay-co'));
  const settled = await market.settleOrder(order.id, { reference: 'sandbox:settlement:001' }, ctx('lunar-imaging-inc'));

  assert.equal(settled.status, 'settled');
  assert.equal(settled.settlement.reference, 'sandbox:settlement:001');
  assert.equal((await market.listOffers())[0].remaining, 92);
  assert.equal((await market.getLedger()).length, 6);
  assert.equal(await market.verifyLedger(), true);
});

test('prevents oversubscription and supports optimistic version checks', async () => {
  const { market, offer } = await fixture();
  await market.createOrder({ offerId: offer.id, quantity: 90 }, ctx('buyer-a', { expectedVersion: offer.version }));
  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-b', { expectedVersion: offer.version })),
    (error) => error.code === 'STALE_VERSION',
  );
  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 11 }, ctx('buyer-b')),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
});

test('uses participant context as the authorization boundary', async () => {
  const { market, offer } = await fixture();
  const order = await market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-a'));
  await assert.rejects(
    market.fundOrder(order.id, { amount: '1250', reference: 'x' }, ctx('buyer-b')),
    (error) => error.code === 'FORBIDDEN',
  );
  await market.fundOrder(order.id, { amount: '1250', reference: 'x' }, ctx('buyer-a'));
  await assert.rejects(
    market.recordDelivery(order.id, { proof: { type: 'receipt', data: {} } }, ctx('impostor')),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('idempotency replay returns the original result without double-reserving capacity', async () => {
  const { market, offer } = await fixture();
  const context = ctx('buyer-a', { idempotencyKey: 'reserve-001' });
  const first = await market.createOrder({ offerId: offer.id, quantity: 10 }, context);
  const second = await market.createOrder({ offerId: offer.id, quantity: 10 }, context);
  assert.equal(first.id, second.id);
  assert.equal((await market.listOffers())[0].remaining, 90);
  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 11 }, context),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('does not silently cancel funded orders because a refund rail is outside the kernel', async () => {
  const { market, offer } = await fixture();
  const order = await market.createOrder({ offerId: offer.id, quantity: 2 }, ctx('buyer-a'));
  await market.fundOrder(order.id, { amount: '2500', reference: 'funding:1' }, ctx('buyer-a'));
  await assert.rejects(market.cancelOrder(order.id, ctx('buyer-a')), (error) => error.code === 'CONFLICT');
  assert.equal((await market.listOffers())[0].remaining, 98);
});

test('canonical proof hashing is independent of object property insertion order', async () => {
  const left = await fixture();
  const right = await fixture();
  const a = await left.market.createOrder({ offerId: left.offer.id, quantity: 1 }, ctx('buyer-a'));
  const b = await right.market.createOrder({ offerId: right.offer.id, quantity: 1 }, ctx('buyer-a'));
  await left.market.fundOrder(a.id, { amount: '1250', reference: 'funding:a' }, ctx('buyer-a'));
  await right.market.fundOrder(b.id, { amount: '1250', reference: 'funding:b' }, ctx('buyer-a'));
  const proofA = await left.market.recordDelivery(a.id, { proof: { type: 'receipt', data: { alpha: 1, beta: 2 } } }, ctx('orbital-relay-co'));
  const proofB = await right.market.recordDelivery(b.id, { proof: { type: 'receipt', data: { beta: 2, alpha: 1 } } }, ctx('orbital-relay-co'));
  assert.equal(proofA.deliveryProof.hash, proofB.deliveryProof.hash);
});

test('persists schema version, idempotency records, and ledger integrity across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-economy-'));
  const statePath = path.join(dir, 'state.json');
  const { market, offer } = await fixture({ statePath });
  const context = ctx('buyer-a', { idempotencyKey: 'order-1' });
  const order = await market.createOrder({ offerId: offer.id, quantity: 3 }, context);

  const restored = await Clearinghouse.open({ statePath });
  const replay = await restored.createOrder({ offerId: offer.id, quantity: 3 }, context);
  assert.equal(replay.id, order.id);
  assert.equal((await restored.listAssets()).length, 1);
  assert.equal(await restored.verifyLedger(), true);
});

test('rolls in-memory state back when persistence fails', async () => {
  class FailingStore extends MemorySnapshotStore {
    async save() {
      const error = new Error('disk unavailable');
      error.code = 'IO_FAILURE';
      throw error;
    }
  }
  const market = await Clearinghouse.open({ store: new FailingStore() });
  await assert.rejects(market.registerAsset({ name: 'A', type: 'satellite' }, ctx('owner')));
  assert.equal((await market.listAssets()).length, 0);
  assert.equal((await market.getLedger()).length, 0);
  assert.equal(await market.getRevision(), 0);
});

test('serializes commands within one instance across asynchronous saves', async () => {
  class SlowStore extends MemorySnapshotStore {
    activeSaves = 0;
    maxActiveSaves = 0;

    async save(snapshot, options) {
      this.activeSaves += 1;
      this.maxActiveSaves = Math.max(this.maxActiveSaves, this.activeSaves);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await super.save(snapshot, options);
      } finally {
        this.activeSaves -= 1;
      }
    }
  }

  const store = new SlowStore();
  const market = await Clearinghouse.open({ store });
  const first = market.registerAsset({ name: 'A', type: 'satellite' }, ctx('owner-a'));
  const second = market.registerAsset({ name: 'B', type: 'satellite' }, ctx('owner-b'));
  await Promise.all([first, second]);

  assert.equal(store.maxActiveSaves, 1);
  assert.equal((await market.listAssets()).length, 2);
  assert.equal(await market.getRevision(), 2);
});

test('reads wait for a failed mutation to roll back before exposing state', async () => {
  class DelayedFailingStore extends MemorySnapshotStore {
    async save() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('write failed');
    }
  }

  const market = await Clearinghouse.open({ store: new DelayedFailingStore() });
  const mutation = market.registerAsset({ name: 'A', type: 'satellite' }, ctx('owner'));
  const read = market.listAssets();

  await assert.rejects(mutation, /write failed/);
  assert.deepEqual(await read, []);
  assert.equal(await market.getRevision(), 0);
});

test('cross-instance CAS conflicts refresh the loser so a retry can succeed', async () => {
  const store = new MemorySnapshotStore();
  const left = await Clearinghouse.open({ store });
  const right = await Clearinghouse.open({ store });

  const leftAsset = await left.registerAsset({ name: 'Left', type: 'satellite' }, ctx('left-owner'));
  await assert.rejects(
    right.registerAsset({ name: 'Right', type: 'satellite' }, ctx('right-owner')),
    (error) => error.code === 'STORE_CONFLICT',
  );

  const refreshed = await right.listAssets();
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, leftAsset.id);

  await right.registerAsset({ name: 'Right', type: 'satellite' }, ctx('right-owner'));
  assert.equal((await right.listAssets()).length, 2);
  assert.equal(await right.getRevision(), 2);
});

test('seller-configured reservation TTL materializes a funding deadline', async () => {
  const time = controlledClock('2026-08-26T20:00:00.000Z');
  const market = await Clearinghouse.open({ clock: time.clock });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, ctx('seller'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 60,
  }, ctx('seller'));
  const order = await market.createOrder({ offerId: offer.id, quantity: 10 }, ctx('buyer'));

  assert.equal(offer.reservationTtlSeconds, 60);
  assert.equal(order.fundingDueAt, '2026-08-26T20:01:00.000Z');
  assert.equal(order.expiration, null);

  time.set('2026-08-26T20:00:59.999Z');
  const funded = await market.fundOrder(order.id, { amount: '100', reference: 'funding:before-deadline' }, ctx('buyer'));
  assert.equal(funded.status, 'funded');
});

test('late funding is blocked and any authenticated actor may trigger objective expiry', async () => {
  const time = controlledClock('2026-08-26T20:00:00.000Z');
  const market = await Clearinghouse.open({ clock: time.clock });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, ctx('seller'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 60,
  }, ctx('seller'));
  const order = await market.createOrder({ offerId: offer.id, quantity: 25 }, ctx('buyer'));
  assert.equal((await market.listOffers())[0].remaining, 75);

  time.set('2026-08-26T20:01:00.000Z');
  await assert.rejects(
    market.fundOrder(order.id, { amount: '250', reference: 'too-late' }, ctx('buyer')),
    (error) => error.code === 'RESERVATION_EXPIRED' && error.details.fundingDueAt === order.fundingDueAt,
  );

  const expired = await market.expireOrder(order.id, ctx('expiry-worker', { expectedVersion: order.version, idempotencyKey: 'expire-1' }));
  assert.equal(expired.status, 'expired');
  assert.deepEqual(expired.expiration, {
    reason: 'funding-deadline',
    fundingDueAt: '2026-08-26T20:01:00.000Z',
    expiredAt: '2026-08-26T20:01:00.000Z',
    triggeredBy: 'expiry-worker',
  });
  const currentOffer = (await market.listOffers())[0];
  assert.equal(currentOffer.remaining, 100);
  assert.equal(currentOffer.status, 'open');
  assert.equal(await market.verifyLedger(), true);
  assert.equal((await market.getLedger()).at(-1).type, 'spaceeconomy.order.expired.v1');
});

test('expiry cannot be triggered early and no-TTL offers remain unbounded', async () => {
  const time = controlledClock('2026-08-26T20:00:00.000Z');
  const market = await Clearinghouse.open({ clock: time.clock });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, ctx('seller'));
  const bounded = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 60,
  }, ctx('seller'));
  const boundedOrder = await market.createOrder({ offerId: bounded.id, quantity: 10 }, ctx('buyer-a'));
  time.set('2026-08-26T20:00:59.999Z');
  await assert.rejects(
    market.expireOrder(boundedOrder.id, ctx('worker')),
    (error) => error.code === 'RESERVATION_NOT_DUE',
  );

  const unbounded = await market.createOffer({
    assetId: asset.id,
    service: 'storage',
    unit: 'MB-hour',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1', scale: 2 },
    capacity: 100,
  }, ctx('seller'));
  const unboundedOrder = await market.createOrder({ offerId: unbounded.id, quantity: 1 }, ctx('buyer-b'));
  assert.equal(unboundedOrder.fundingDueAt, null);
  time.set('2030-01-01T00:00:00.000Z');
  await assert.rejects(
    market.expireOrder(unboundedOrder.id, ctx('worker')),
    (error) => error.code === 'RESERVATION_NOT_EXPIRABLE',
  );
});

test('service window end prevents creating new reservations without imposing a global TTL', async () => {
  const time = controlledClock('2026-08-26T20:30:00.000Z');
  const market = await Clearinghouse.open({ clock: time.clock });
  const asset = await market.registerAsset({ name: 'Telescope', type: 'telescope' }, ctx('seller'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'observation',
    unit: 'second',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '5', scale: 2 },
    capacity: 100,
    windowStart: '2026-08-26T20:00:00.000Z',
    windowEnd: '2026-08-26T21:00:00.000Z',
  }, ctx('seller'));

  const order = await market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-a'));
  assert.equal(order.fundingDueAt, null);

  time.set('2026-08-26T21:00:00.000Z');
  await assert.rejects(
    market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-b')),
    (error) => error.code === 'OFFER_WINDOW_CLOSED',
  );
});
