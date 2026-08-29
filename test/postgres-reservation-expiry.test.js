import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresReservationExpirySource } from '../src/postgres-reservation-expiry.js';

const pool = {
  async query() { return { rows: [], rowCount: 0 }; },
  async connect() {
    return {
      async query() { return { rows: [], rowCount: 0 }; },
      release() {},
    };
  },
};

test('PostgresReservationExpirySource keeps the database driver injectable', () => {
  const source = new PostgresReservationExpirySource(pool);
  assert.equal(source.pool, pool);
});

test('PostgresReservationExpirySource rejects unsafe SQL identifiers and store keys', () => {
  assert.throws(() => new PostgresReservationExpirySource(pool, { schema: 'public; DROP SCHEMA public' }), /schema/);
  assert.throws(() => new PostgresReservationExpirySource(pool, { snapshotTable: 'snapshot-table' }), /snapshotTable/);
  assert.throws(() => new PostgresReservationExpirySource(pool, { projectionTable: 'x'.repeat(60) }), /too long/);
  assert.throws(() => new PostgresReservationExpirySource(pool, { storeKey: 'bad\u0000key' }), /NUL/);
});

test('PostgresReservationExpirySource requires a transaction-capable pool', () => {
  assert.throws(() => new PostgresReservationExpirySource({ query() {} }), /query\(\) and connect\(\)/);
});

test('listDue validates scheduler timestamps and bounded batch sizes before querying', async () => {
  let calls = 0;
  const quietPool = {
    ...pool,
    async query() { calls += 1; return { rows: [], rowCount: 0 }; },
  };
  const source = new PostgresReservationExpirySource(quietPool);
  await assert.rejects(source.listDue({ now: 'not-a-time', limit: 10 }), /valid timestamp/);
  await assert.rejects(source.listDue({ now: new Date(), limit: 0 }), /limit/);
  await assert.rejects(source.listDue({ now: new Date(), limit: 1001 }), /limit/);
  assert.equal(calls, 0);
});

test('refresh rolls back if projection maintenance fails before commit', async () => {
  const statements = [];
  const failingPool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() {
      return {
        async query(text) {
          statements.push(text.trim().split(/\s+/, 2).join(' '));
          if (/^DELETE FROM/.test(text.trim())) throw new Error('projection write failed');
          if (/SELECT revision, snapshot->>'schemaVersion'/.test(text)) {
            return { rows: [{ revision: 3, schema_version: 2 }], rowCount: 1 };
          }
          if (/SELECT source_revision FROM/.test(text)) return { rows: [{ source_revision: 2 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const source = new PostgresReservationExpirySource(failingPool);
  await assert.rejects(source.refresh(), /projection write failed/);
  assert.ok(statements.some((statement) => statement === 'ROLLBACK'));
});

test('refresh fails closed before projection writes for an unknown future snapshot schema', async () => {
  const statements = [];
  const futurePool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() {
      return {
        async query(text) {
          statements.push(text.trim());
          if (/SELECT revision, snapshot->>'schemaVersion'/.test(text)) {
            return { rows: [{ revision: 9, schema_version: 999 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const source = new PostgresReservationExpirySource(futurePool);
  await assert.rejects(
    source.refresh(),
    (error) => error.code === 'UNSUPPORTED_EXPIRY_PROJECTION_SCHEMA'
      && error.details.sourceSchemaVersion === 999,
  );
  assert.ok(statements.some((statement) => statement === 'ROLLBACK'));
  assert.ok(!statements.some((statement) => /^DELETE FROM/.test(statement)));
});
