import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { LedgerReservationExpirySource, ReservationExpiryWorker } from '../src/reservation-expiry.js';

const ctx = (actorId) => ({ actorId });

async function expiringFixture({ ttl = 60 } = {}) {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, ctx('seller'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
    reservationTtlSeconds: ttl,
  }, ctx('seller'));
  const order = await market.createOrder({ offerId: offer.id, quantity: 4 }, ctx('buyer'));
  return {
    market,
    offer,
    order,
    setNow(value) { now = new Date(value); },
    clock() { return new Date(now); },
  };
}

test('one-shot worker expires due unpaid reservations and restores capacity', async () => {
  const fixture = await expiringFixture();
  const worker = new ReservationExpiryWorker({
    market: fixture.market,
    actorId: 'expiry-worker',
    clock: fixture.clock,
  });

  const early = await worker.runOnce();
  assert.equal(early.scanned, 0);
  assert.equal((await fixture.market.listOffers())[0].remaining, 6);

  fixture.setNow('2026-09-01T00:01:00.000Z');
  const due = await worker.runOnce();
  assert.equal(due.scanned, 1);
  assert.deepEqual(due.skipped, []);
  assert.equal(due.expired.length, 1);
  assert.equal(due.expired[0].orderId, fixture.order.id);
  const order = await fixture.market.getOrder(fixture.order.id);
  assert.equal(order.status, 'expired');
  assert.equal(order.expiration.triggeredBy, 'expiry-worker');
  assert.equal((await fixture.market.listOffers())[0].remaining, 10);

  const replayScan = await worker.runOnce();
  assert.equal(replayScan.scanned, 0);
});

test('reference ledger source excludes funded, unbounded, and not-yet-due reservations', async () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, ctx('seller'));
  const expiring = await market.createOffer({
    assetId: asset.id,
    service: 'relay', unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1', scale: 0 },
    capacity: 10, reservationTtlSeconds: 60,
  }, ctx('seller'));
  const unbounded = await market.createOffer({
    assetId: asset.id,
    service: 'relay', unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1', scale: 0 },
    capacity: 10,
  }, ctx('seller'));

  const dueLater = await market.createOrder({ offerId: expiring.id, quantity: 1 }, ctx('buyer-a'));
  const funded = await market.createOrder({ offerId: expiring.id, quantity: 1 }, ctx('buyer-b'));
  await market.fundOrder(funded.id, { amount: funded.total.amount, reference: 'funding:1' }, ctx('buyer-b'));
  await market.createOrder({ offerId: unbounded.id, quantity: 1 }, ctx('buyer-c'));

  const source = new LedgerReservationExpirySource({ market });
  assert.deepEqual(await source.listDue({ now: now.toISOString(), limit: 10 }), []);

  now = new Date('2026-09-01T00:01:00.000Z');
  const due = await source.listDue({ now: now.toISOString(), limit: 10 });
  assert.deepEqual(due.map((order) => order.id), [dueLater.id]);
});

test('worker treats optimistic/state races as safe skips and uses stable idempotency', async () => {
  const candidate = {
    id: 'order-1',
    fundingDueAt: '2026-09-01T00:01:00.000Z',
    version: 3,
  };
  const contexts = [];
  const market = {
    async expireOrder(orderId, context) {
      assert.equal(orderId, 'order-1');
      contexts.push(structuredClone(context));
      const error = new Error('lost race');
      error.code = 'STALE_VERSION';
      throw error;
    },
  };
  const source = { async listDue() { return [candidate]; } };
  const worker = new ReservationExpiryWorker({ market, source, actorId: 'worker' });

  const first = await worker.runOnce();
  const second = await worker.runOnce();
  assert.deepEqual(first.skipped, [{ orderId: 'order-1', code: 'STALE_VERSION' }]);
  assert.equal(first.expired.length, 0);
  assert.equal(contexts[0].actorId, 'worker');
  assert.equal(contexts[0].expectedVersion, 3);
  assert.match(contexts[0].idempotencyKey, /^reservation-expiry:[0-9a-f]{64}$/);
  assert.equal(contexts[0].idempotencyKey, contexts[1].idempotencyKey);
});

test('worker bubbles unexpected infrastructure failures instead of hiding them', async () => {
  const market = {
    async expireOrder() { throw new Error('database unavailable'); },
  };
  const source = {
    async listDue() {
      return [{ id: 'order-1', fundingDueAt: '2026-09-01T00:00:00Z', version: 1 }];
    },
  };
  const worker = new ReservationExpiryWorker({ market, source });
  await assert.rejects(worker.runOnce(), /database unavailable/);
});

test('worker enforces bounded batches and source response shape', async () => {
  const market = { async expireOrder() { throw new Error('should not run'); } };
  const emptySource = { async listDue() { return []; } };
  assert.throws(() => new ReservationExpiryWorker({ market, source: emptySource, batchSize: 0 }), /batchSize/);
  assert.throws(() => new ReservationExpiryWorker({ market, source: emptySource, batchSize: 1001 }), /batchSize/);

  const worker = new ReservationExpiryWorker({
    market,
    batchSize: 1,
    source: { async listDue() { return [{}, {}]; } },
  });
  await assert.rejects(worker.runOnce(), (error) => error.code === 'INVALID_EXPIRY_SOURCE');
});
