import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

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
