import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { Clearinghouse } from '../src/clearinghouse.js';
import { PostgresReservationExpirySource } from '../src/postgres-reservation-expiry.js';
import { PostgresSnapshotStore } from '../src/postgres-store.js';
import { ReservationExpiryWorker } from '../src/reservation-expiry.js';
import { CURRENT_SCHEMA_VERSION } from '../src/schema.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for Postgres integration tests');
const pool = new Pool({ connectionString, max: 8 });

async function fixture() {
  const storeKey = `expiry-${randomUUID()}`;
  const store = new PostgresSnapshotStore(pool, { storeKey });
  await store.ensureSchema();
  const source = new PostgresReservationExpirySource(pool, { storeKey });
  await source.ensureSchema();

  let now = new Date('2026-09-01T00:00:00.000Z');
  const market = await Clearinghouse.open({ store, clock: () => new Date(now) });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller' });
  const expiring = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 20,
    reservationTtlSeconds: 60,
  }, { actorId: 'seller' });
  const unbounded = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 20,
  }, { actorId: 'seller' });

  const due = await market.createOrder({ offerId: expiring.id, quantity: 4 }, { actorId: 'buyer-due' });
  const funded = await market.createOrder({ offerId: expiring.id, quantity: 3 }, { actorId: 'buyer-funded' });
  await market.fundOrder(
    funded.id,
    { amount: funded.total.amount, reference: 'funding:confirmed' },
    { actorId: 'buyer-funded' },
  );
  await market.createOrder({ offerId: unbounded.id, quantity: 2 }, { actorId: 'buyer-unbounded' });

  return {
    storeKey,
    market,
    source,
    due,
    expiring,
    setNow(value) { now = new Date(value); },
    clock() { return new Date(now); },
  };
}

test('PostgreSQL expiry projection filters the authoritative snapshot and serves indexed due candidates', async () => {
  const state = await fixture();
  const refresh = await state.source.refresh();
  assert.equal(refresh.sourceRevision, await state.market.getRevision());
  assert.equal(refresh.sourceSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(refresh.candidateCount, 1);

  assert.deepEqual(
    await state.source.listDue({ now: '2026-09-01T00:00:59.999Z', limit: 10 }),
    [],
  );

  const due = await state.source.listDue({ now: '2026-09-01T00:01:00.000Z', limit: 10 });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, state.due.id);
  assert.equal(due[0].version, state.due.version);
  assert.equal(due[0].fundingDueAt, state.due.fundingDueAt);

  const status = await state.source.getStatus();
  assert.equal(status.sourceRevision, refresh.sourceRevision);
  assert.equal(status.candidateCount, 1);
  assert.ok(status.refreshedAt);
});

test('stale projection rows are safe worker races and disappear after refresh', async () => {
  const state = await fixture();
  await state.source.refresh();
  state.setNow('2026-09-01T00:01:00.000Z');

  const worker = new ReservationExpiryWorker({
    market: state.market,
    source: state.source,
    actorId: 'system:postgres-expiry',
    clock: state.clock,
  });

  const first = await worker.runOnce();
  assert.deepEqual(first.skipped, []);
  assert.equal(first.expired.length, 1);
  assert.equal(first.expired[0].orderId, state.due.id);
  assert.equal((await state.market.listOffers({ status: null })).find((offer) => offer.id === state.expiring.id).remaining, 17);

  const stale = await worker.runOnce();
  assert.deepEqual(stale.expired, []);
  assert.deepEqual(stale.skipped, [{ orderId: state.due.id, code: 'STALE_VERSION' }]);

  const refresh = await state.source.refresh();
  assert.equal(refresh.candidateCount, 0);
  assert.equal((await state.source.listDue({ now: state.clock(), limit: 10 })).length, 0);
});

test('projection revision cannot move backward and failed refresh preserves the newer projection', async () => {
  const state = await fixture();
  const current = await state.source.refresh();
  assert.ok(current.sourceRevision > 1);

  await pool.query(`
    UPDATE public.space_economy_snapshots
       SET revision = 1,
           snapshot = jsonb_set(snapshot, '{revision}', '1'::jsonb),
           updated_at = now()
     WHERE store_key = $1
  `, [state.storeKey]);

  await assert.rejects(
    state.source.refresh(),
    (error) => error.code === 'EXPIRY_PROJECTION_REGRESSION'
      && error.details.projectedRevision === current.sourceRevision
      && error.details.sourceRevision === 1,
  );

  const status = await state.source.getStatus();
  assert.equal(status.sourceRevision, current.sourceRevision);
  assert.equal(status.candidateCount, 1);
});

test('unknown future persisted schemas fail closed without replacing the current projection', async () => {
  const state = await fixture();
  const current = await state.source.refresh();

  await pool.query(`
    UPDATE public.space_economy_snapshots
       SET snapshot = jsonb_set(snapshot, '{schemaVersion}', '999'::jsonb),
           updated_at = now()
     WHERE store_key = $1
  `, [state.storeKey]);

  await assert.rejects(
    state.source.refresh(),
    (error) => error.code === 'UNSUPPORTED_EXPIRY_PROJECTION_SCHEMA'
      && error.details.sourceSchemaVersion === 999
      && error.details.supportedSchemaVersion === CURRENT_SCHEMA_VERSION,
  );

  const status = await state.source.getStatus();
  assert.equal(status.sourceRevision, current.sourceRevision);
  assert.equal(status.candidateCount, 1);
});

test.after(async () => {
  await pool.end();
});
