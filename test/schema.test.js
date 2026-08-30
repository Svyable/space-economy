import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { createClearinghouseMigrationRegistry } from '../src/schema.js';
import { MemorySnapshotStore } from '../src/store.js';

const v1Snapshot = () => ({
  schemaVersion: 1,
  revision: 0,
  assets: [],
  offers: [{
    id: 'offer-legacy',
    capacity: 10,
    remaining: 10,
    status: 'open',
    version: 1,
  }],
  orders: [{
    id: 'order-legacy',
    offerId: 'offer-legacy',
    status: 'reserved',
    version: 1,
  }],
  ledger: [],
  idempotency: [],
});

const v2Snapshot = () => ({
  schemaVersion: 2,
  revision: 0,
  assets: [],
  offers: [],
  orders: [],
  ledger: [{ opaque: 'historical-event-bytes-stay-logically-identical' }],
  idempotency: [],
});

test('clearinghouse schema v3 composes expiry and commercial commitment migrations without rewriting ledger history', async () => {
  const snapshot = v1Snapshot();
  snapshot.ledger = [{ opaque: 'historical-event-bytes-stay-logically-identical' }];
  const migrated = await createClearinghouseMigrationRegistry().migrate(snapshot);

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.offers[0].reservationTtlSeconds, null);
  assert.equal(migrated.orders[0].fundingDueAt, null);
  assert.equal(migrated.orders[0].expiration, null);
  assert.deepEqual(migrated.commercialCommitments, []);
  assert.deepEqual(migrated.ledger, snapshot.ledger);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.offers[0].reservationTtlSeconds, undefined);
  assert.equal(snapshot.commercialCommitments, undefined);
});

test('schema v2 to v3 adds only the commercial commitment collection', async () => {
  const snapshot = v2Snapshot();
  const migrated = await createClearinghouseMigrationRegistry().migrate(snapshot);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.commercialCommitments, []);
  assert.deepEqual(migrated.ledger, snapshot.ledger);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.commercialCommitments, undefined);
});

test('Clearinghouse.open reads v1 state through migration and persists v3 only on the next successful mutation', async () => {
  const rawStore = new MemorySnapshotStore(v1Snapshot());
  const market = await Clearinghouse.open({ store: rawStore });

  const legacyOffer = (await market.listOffers({ status: null }))[0];
  const legacyOrder = await market.getOrder('order-legacy');
  assert.equal(legacyOffer.reservationTtlSeconds, null);
  assert.equal(legacyOrder.fundingDueAt, null);
  assert.equal(legacyOrder.expiration, null);
  assert.deepEqual(await market.listCommercialCommitments({ actorId: 'owner' }), []);

  assert.equal((await rawStore.load()).schemaVersion, 1);

  await market.registerAsset({ name: 'Migrated write', type: 'satellite' }, { actorId: 'owner' });
  const persisted = await rawStore.load();
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.offers[0].reservationTtlSeconds, null);
  assert.equal(persisted.orders[0].fundingDueAt, null);
  assert.equal(persisted.orders[0].expiration, null);
  assert.deepEqual(persisted.commercialCommitments, []);
});
