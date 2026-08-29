import assert from 'node:assert/strict';
import test from 'node:test';
import { CapacityDirectory } from '../src/capacity-query.js';
import { PostgresCapacityProjection } from '../src/postgres-capacity-projection.js';

function fakePool() {
  return {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query() { return { rows: [] }; },
        release() {},
      };
    },
  };
}

test('PostgresCapacityProjection keeps the database driver injectable', () => {
  assert.doesNotThrow(() => new PostgresCapacityProjection(fakePool()));
  assert.throws(() => new PostgresCapacityProjection(null), /pool must provide query\(\) and connect\(\)/);
  assert.throws(() => new PostgresCapacityProjection({ query() {} }), /pool must provide query\(\) and connect\(\)/);
});

test('PostgresCapacityProjection rejects unsafe identifiers and projection keys', () => {
  const pool = fakePool();
  assert.throws(() => new PostgresCapacityProjection(pool, { schema: 'public; DROP SCHEMA public' }), /schema/);
  assert.throws(() => new PostgresCapacityProjection(pool, { tablePrefix: 'space-economy' }), /tablePrefix/);
  assert.throws(() => new PostgresCapacityProjection(pool, { tablePrefix: 'x'.repeat(41) }), /tablePrefix/);
  assert.throws(() => new PostgresCapacityProjection(pool, { projectionKey: 'bad\u0000key' }), /NUL/);
});

test('CapacityDirectory can delegate cursor semantics to a projected search source', async () => {
  const calls = [];
  const source = {
    async search(request) {
      calls.push(structuredClone(request));
      return {
        revision: 7,
        items: request.offset === 0
          ? [{ offer: { id: 'offer-1' }, asset: { id: 'asset-1' } }]
          : [{ offer: { id: 'offer-2' }, asset: { id: 'asset-2' } }],
        hasMore: request.offset === 0,
      };
    },
  };
  const directory = new CapacityDirectory({ source });

  const first = await directory.find({ service: 'relay', limit: 1 });
  assert.equal(first.revision, 7);
  assert.ok(first.nextCursor);
  assert.equal(calls[0].expectedRevision, null);
  assert.equal(calls[0].filters.service, 'relay');

  const second = await directory.find({ service: 'relay', limit: 1, cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert.equal(calls[1].expectedRevision, 7);
  assert.equal(calls[1].offset, 1);
});

test('CapacityDirectory rejects malformed query-source responses', async () => {
  const badRevision = new CapacityDirectory({
    source: { search: async () => ({ revision: -1, items: [], hasMore: false }) },
  });
  await assert.rejects(badRevision.find(), (error) => error.code === 'INVALID_QUERY_SOURCE');

  const tooMany = new CapacityDirectory({
    source: { search: async () => ({ revision: 1, items: [{}, {}], hasMore: false }) },
  });
  await assert.rejects(tooMany.find({ limit: 1 }), (error) => error.code === 'INVALID_QUERY_SOURCE');
});

test('projection refresh rolls back and releases the client when a database write fails', async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (String(sql).startsWith('SELECT revision')) return { rows: [] };
      if (String(sql).startsWith('DELETE FROM')) throw new Error('injected projection failure');
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async query() { return { rows: [] }; },
    async connect() { return client; },
  };
  const projection = new PostgresCapacityProjection(pool);
  const market = {
    async getRevision() { return 0; },
    async listAssets() { return []; },
    async listOffers() { return []; },
  };

  await assert.rejects(projection.refreshFromMarket(market), /injected projection failure/);
  assert.ok(statements.includes('ROLLBACK'));
  assert.equal(released, true);
});
