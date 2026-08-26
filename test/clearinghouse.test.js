import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function fixture(options = {}) {
  const market = new Clearinghouse(options);
  const asset = market.registerAsset({
    name: 'Relay-7',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
    identifiers: [
      { scheme: 'cospar', value: '2026-001A' },
      { scheme: 'norad-cat-id', value: '99999' },
    ],
    location: { orbit: 'LEO', inclinationDeg: 51.6 },
  }, ctx('orbital-relay-co'));
  const offer = market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1250', scale: 2 },
    capacity: 100,
  }, ctx('orbital-relay-co'));
  return { market, asset, offer };
}

test('settles a capacity-backed service with exact monetary arithmetic', () => {
  const { market, offer } = fixture();
  const order = market.createOrder({ offerId: offer.id, quantity: 8 }, ctx('lunar-imaging-inc'));
  assert.deepEqual(order.total, { settlementAsset: 'iso4217:USD', amount: '10000', scale: 2 });
  assert.equal(order.status, 'reserved');

  market.fundOrder(order.id, { amount: '10000', reference: 'sandbox:funding:001' }, ctx('lunar-imaging-inc'));
  market.recordDelivery(order.id, {
    proof: { type: 'packet-receipt', data: { receipt: 'sha256:example', deliveredQuantity: 8 } },
  }, ctx('orbital-relay-co'));
  const settled = market.settleOrder(order.id, { reference: 'sandbox:settlement:001' }, ctx('lunar-imaging-inc'));

  assert.equal(settled.status, 'settled');
  assert.equal(settled.settlement.reference, 'sandbox:settlement:001');
  assert.equal(market.listOffers()[0].remaining, 92);
  assert.equal(market.getLedger().length, 6);
  assert.equal(market.verifyLedger(), true);
});

test('prevents oversubscription and supports optimistic version checks', () => {
  const { market, offer } = fixture();
  market.createOrder({ offerId: offer.id, quantity: 90 }, ctx('buyer-a', { expectedVersion: offer.version }));
  assert.throws(
    () => market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-b', { expectedVersion: offer.version })),
    (error) => error.code === 'STALE_VERSION',
  );
  assert.throws(
    () => market.createOrder({ offerId: offer.id, quantity: 11 }, ctx('buyer-b')),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
});

test('uses participant context as the authorization boundary', () => {
  const { market, offer } = fixture();
  const order = market.createOrder({ offerId: offer.id, quantity: 1 }, ctx('buyer-a'));
  assert.throws(
    () => market.fundOrder(order.id, { amount: '1250', reference: 'x' }, ctx('buyer-b')),
    (error) => error.code === 'FORBIDDEN',
  );
  market.fundOrder(order.id, { amount: '1250', reference: 'x' }, ctx('buyer-a'));
  assert.throws(
    () => market.recordDelivery(order.id, { proof: { type: 'receipt', data: {} } }, ctx('impostor')),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('idempotency replay returns the original result without double-reserving capacity', () => {
  const { market, offer } = fixture();
  const context = ctx('buyer-a', { idempotencyKey: 'reserve-001' });
  const first = market.createOrder({ offerId: offer.id, quantity: 10 }, context);
  const second = market.createOrder({ offerId: offer.id, quantity: 10 }, context);
  assert.equal(first.id, second.id);
  assert.equal(market.listOffers()[0].remaining, 90);
  assert.throws(
    () => market.createOrder({ offerId: offer.id, quantity: 11 }, context),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('does not silently cancel funded orders because a refund rail is outside the kernel', () => {
  const { market, offer } = fixture();
  const order = market.createOrder({ offerId: offer.id, quantity: 2 }, ctx('buyer-a'));
  market.fundOrder(order.id, { amount: '2500', reference: 'funding:1' }, ctx('buyer-a'));
  assert.throws(() => market.cancelOrder(order.id, ctx('buyer-a')), (error) => error.code === 'CONFLICT');
  assert.equal(market.listOffers()[0].remaining, 98);
});

test('canonical proof hashing is independent of object property insertion order', () => {
  const left = fixture();
  const right = fixture();
  const a = left.market.createOrder({ offerId: left.offer.id, quantity: 1 }, ctx('buyer-a'));
  const b = right.market.createOrder({ offerId: right.offer.id, quantity: 1 }, ctx('buyer-a'));
  left.market.fundOrder(a.id, { amount: '1250', reference: 'funding:a' }, ctx('buyer-a'));
  right.market.fundOrder(b.id, { amount: '1250', reference: 'funding:b' }, ctx('buyer-a'));
  const proofA = left.market.recordDelivery(a.id, { proof: { type: 'receipt', data: { alpha: 1, beta: 2 } } }, ctx('orbital-relay-co'));
  const proofB = right.market.recordDelivery(b.id, { proof: { type: 'receipt', data: { beta: 2, alpha: 1 } } }, ctx('orbital-relay-co'));
  assert.equal(proofA.deliveryProof.hash, proofB.deliveryProof.hash);
});

test('persists schema version, idempotency records, and ledger integrity across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-economy-'));
  const statePath = path.join(dir, 'state.json');
  const { market, offer } = fixture({ statePath });
  const context = ctx('buyer-a', { idempotencyKey: 'order-1' });
  const order = market.createOrder({ offerId: offer.id, quantity: 3 }, context);

  const restored = new Clearinghouse({ statePath });
  const replay = restored.createOrder({ offerId: offer.id, quantity: 3 }, context);
  assert.equal(replay.id, order.id);
  assert.equal(restored.listAssets().length, 1);
  assert.equal(restored.verifyLedger(), true);
});

test('rolls in-memory state back when persistence fails', () => {
  class FailingStore extends MemorySnapshotStore {
    save() {
      const error = new Error('disk unavailable');
      error.code = 'IO_FAILURE';
      throw error;
    }
  }
  const market = new Clearinghouse({ store: new FailingStore() });
  assert.throws(() => market.registerAsset({ name: 'A', type: 'satellite' }, ctx('owner')));
  assert.equal(market.listAssets().length, 0);
  assert.equal(market.getLedger().length, 0);
  assert.equal(market.getRevision(), 0);
});
