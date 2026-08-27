import assert from 'node:assert/strict';
import test from 'node:test';
import { StoreConflictError } from '../../src/store.js';

const snapshot = (revision) => ({
  schemaVersion: 1,
  revision,
  assets: [],
  offers: [],
  orders: [],
  ledger: [],
  idempotency: [],
});

/**
 * Registers the behavior every snapshot-store adapter must satisfy.
 * Adapter-specific integration tests should call this with a fresh isolated
 * store so database implementations are held to the same CAS semantics as the
 * reference adapters.
 */
export function defineSnapshotStoreContract(name, createStore) {
  test(`${name}: loads null from a fresh store and round-trips committed snapshots`, async () => {
    const store = await createStore();
    assert.equal(await store.load(), null);

    await store.save(snapshot(1), { expectedRevision: 0 });
    assert.deepEqual(await store.load(), snapshot(1));
  });

  test(`${name}: returned snapshots do not alias persisted state`, async () => {
    const store = await createStore();
    await store.save(snapshot(1), { expectedRevision: 0 });

    const loaded = await store.load();
    loaded.revision = 999;
    loaded.assets.push({ id: 'mutated-outside-store' });

    assert.deepEqual(await store.load(), snapshot(1));
  });

  test(`${name}: stale expected revisions fail without replacing the winner`, async () => {
    const store = await createStore();
    await store.save(snapshot(1), { expectedRevision: 0 });

    await assert.rejects(
      store.save(snapshot(2), { expectedRevision: 0 }),
      (error) => error instanceof StoreConflictError || error?.code === 'STORE_CONFLICT',
    );
    assert.deepEqual(await store.load(), snapshot(1));

    await store.save(snapshot(2), { expectedRevision: 1 });
    assert.deepEqual(await store.load(), snapshot(2));
  });
}
