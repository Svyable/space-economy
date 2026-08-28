import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresSnapshotStore } from '../src/postgres-store.js';
import { defineSnapshotStoreContract } from '../test/support/snapshot-store-contract.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for Postgres integration tests');
const pool = new Pool({ connectionString, max: 8 });

const bootstrapStore = new PostgresSnapshotStore(pool, { storeKey: 'integration-bootstrap' });
await bootstrapStore.ensureSchema();

const createStore = async (storeKey = `test-${randomUUID()}`, customPool = pool) => (
  new PostgresSnapshotStore(customPool, { storeKey })
);

const snapshot = (revision, extra = {}) => ({
  schemaVersion: 1,
  revision,
  assets: [],
  offers: [],
  orders: [],
  ledger: [],
  idempotency: [],
  ...extra,
});

defineSnapshotStoreContract('PostgresSnapshotStore', () => createStore());

test('PostgresSnapshotStore serializes cross-process-style CAS races', async () => {
  const storeKey = `race-${randomUUID()}`;
  const left = await createStore(storeKey);
  const right = await createStore(storeKey);
  await left.save(snapshot(1), { expectedRevision: 0 });

  const results = await Promise.allSettled([
    left.save(snapshot(2, { winner: 'left' }), { expectedRevision: 1 }),
    right.save(snapshot(2, { winner: 'right' }), { expectedRevision: 1 }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STORE_CONFLICT');

  const persisted = await left.load();
  assert.equal(persisted.revision, 2);
  assert.ok(persisted.winner === 'left' || persisted.winner === 'right');
});

test('PostgresSnapshotStore rolls back a write when the transaction fails before commit', async () => {
  const storeKey = `rollback-${randomUUID()}`;
  const rawStore = await createStore(storeKey);
  const injectedPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      let injected = false;
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (!injected && /^\s*INSERT INTO/i.test(text)) {
            injected = true;
            throw new Error('injected failure after transactional insert');
          }
          return result;
        },
        release() { client.release(); },
      };
    },
  };
  const failingStore = await createStore(storeKey, injectedPool);

  await assert.rejects(
    failingStore.save(snapshot(1), { expectedRevision: 0 }),
    /injected failure/,
  );
  assert.equal(await rawStore.load(), null);
});

test.after(async () => {
  await pool.end();
});
