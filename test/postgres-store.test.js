import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresSnapshotStore } from '../src/postgres-store.js';

const pool = {
  async query() { return { rows: [] }; },
  async connect() {
    return {
      async query() { return { rows: [] }; },
      release() {},
    };
  },
};

test('PostgresSnapshotStore keeps the database driver injectable', () => {
  const store = new PostgresSnapshotStore(pool, { storeKey: 'market-one' });
  assert.equal(store.storeKey, 'market-one');
  assert.equal(store.qualifiedTable, '"public"."space_economy_snapshots"');
});

test('PostgresSnapshotStore rejects unsafe SQL identifiers', () => {
  assert.throws(
    () => new PostgresSnapshotStore(pool, { table: 'snapshots; DROP TABLE users' }),
    /simple PostgreSQL identifier/,
  );
  assert.throws(
    () => new PostgresSnapshotStore(pool, { schema: 'tenant-one' }),
    /simple PostgreSQL identifier/,
  );
});

test('PostgresSnapshotStore rejects store keys PostgreSQL text cannot represent', () => {
  assert.throws(
    () => new PostgresSnapshotStore(pool, { storeKey: 'bad\u0000key' }),
    /must not contain NUL/,
  );
});

test('PostgresSnapshotStore requires a transaction-capable pool', () => {
  assert.throws(() => new PostgresSnapshotStore(null), /pool must provide/);
  assert.throws(() => new PostgresSnapshotStore({ query() {} }), /pool must provide/);
});
