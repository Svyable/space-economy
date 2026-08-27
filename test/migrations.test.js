import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySnapshotStore } from '../src/store.js';
import { MigratingSnapshotStore, SnapshotMigrationRegistry } from '../src/migrations.js';

const v1 = () => ({ schemaVersion: 1, revision: 7, assets: [], offers: [], orders: [], ledger: [], idempotency: [] });

test('runs explicit migrations in order without mutating the input snapshot', async () => {
  const original = v1();
  const registry = new SnapshotMigrationRegistry({ currentVersion: 3 })
    .register(1, async (snapshot, context) => {
      assert.deepEqual(context, { deployment: 'test', fromVersion: 1, toVersion: 2 });
      snapshot.schemaVersion = 2;
      snapshot.market = { region: 'earth-orbit' };
      return snapshot;
    })
    .register(2, (snapshot) => ({ ...snapshot, schemaVersion: 3, policyVersion: 1 }));

  const migrated = await registry.migrate(original, { deployment: 'test' });
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.market, { region: 'earth-orbit' });
  assert.equal(migrated.policyVersion, 1);
  assert.deepEqual(original, v1());
});

test('fails closed when a required migration step is missing', async () => {
  const registry = new SnapshotMigrationRegistry({ currentVersion: 3 })
    .register(1, (snapshot) => ({ ...snapshot, schemaVersion: 2 }));

  await assert.rejects(
    registry.migrate(v1()),
    (error) => error.code === 'MIGRATION_MISSING' && error.details.fromVersion === 2,
  );
});

test('rejects snapshots from newer software instead of guessing compatibility', async () => {
  const registry = new SnapshotMigrationRegistry({ currentVersion: 2 });
  await assert.rejects(
    registry.migrate({ ...v1(), schemaVersion: 3 }),
    (error) => error.code === 'UNSUPPORTED_SCHEMA',
  );
});

test('migration steps must advance exactly one schema version', async () => {
  const registry = new SnapshotMigrationRegistry({ currentVersion: 3 })
    .register(1, (snapshot) => ({ ...snapshot, schemaVersion: 3 }));

  await assert.rejects(
    registry.migrate(v1()),
    (error) => error.code === 'INVALID_MIGRATION_RESULT',
  );
});

test('store decorator migrates on read without rewriting historical state', async () => {
  const rawStore = new MemorySnapshotStore(v1());
  const registry = new SnapshotMigrationRegistry({ currentVersion: 2 })
    .register(1, (snapshot) => ({ ...snapshot, schemaVersion: 2, migrated: true }));
  const store = new MigratingSnapshotStore(rawStore, registry);

  const loaded = await store.load();
  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.migrated, true);

  const raw = await rawStore.load();
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.migrated, undefined);
});

test('store decorator only persists the current schema through the wrapped CAS path', async () => {
  const rawStore = new MemorySnapshotStore(v1());
  const registry = new SnapshotMigrationRegistry({ currentVersion: 2 })
    .register(1, (snapshot) => ({ ...snapshot, schemaVersion: 2 }));
  const store = new MigratingSnapshotStore(rawStore, registry);

  await assert.rejects(
    store.save(v1(), { expectedRevision: 7 }),
    (error) => error.code === 'INVALID_SCHEMA_VERSION',
  );

  const current = await store.load();
  current.revision = 8;
  await store.save(current, { expectedRevision: 7 });
  assert.deepEqual(await rawStore.load(), current);
});

test('registry rejects duplicate migration ownership', () => {
  const registry = new SnapshotMigrationRegistry({ currentVersion: 2 });
  registry.register(1, (snapshot) => ({ ...snapshot, schemaVersion: 2 }));
  assert.throws(
    () => registry.register(1, (snapshot) => ({ ...snapshot, schemaVersion: 2 })),
    (error) => error.code === 'MIGRATION_EXISTS',
  );
});
