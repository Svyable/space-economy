# Persisted state migrations

Persisted clearinghouse state is a protocol surface. A deployment must not silently reinterpret historical snapshots when the schema changes.

`SnapshotMigrationRegistry` provides explicit, ordered, testable transformations. `MigratingSnapshotStore` applies those transformations when reading historical state while leaving the underlying store responsible for durability, transactions, and compare-and-swap concurrency.

## Rules

1. Every persisted snapshot has a positive integer `schemaVersion`.
2. A migration owns exactly one transition: `N -> N + 1`.
3. Skipping versions is rejected.
4. Missing migration steps fail startup/read rather than guessing defaults.
5. Snapshots newer than the running software fail closed with `UNSUPPORTED_SCHEMA`.
6. Migrations operate on clones; callers do not receive aliases to the historical object.
7. Loading a historical snapshot does **not** rewrite storage.
8. Migrated state becomes durable only through a later normal `save(..., { expectedRevision })` transaction.

The last two rules are important operationally. A read-only startup or failed deployment must not unexpectedly rewrite the only durable copy of state.

## Clearinghouse schema versions

### v1

Initial snapshot schema containing assets, offers, orders, hash-chained ledger events, idempotency records, and the global store revision.

### v2

Adds bounded unpaid-reservation fields:

- `offer.reservationTtlSeconds`, migrated to `null` for every v1 offer;
- `order.fundingDueAt`, migrated to `null` for every v1 order;
- `order.expiration`, migrated to `null` for every v1 order.

The v1→v2 migration is deliberately additive. It does not infer a TTL for historical offers or reservations, because doing so would retroactively change economic terms. Existing unpaid reservations therefore remain unbounded unless they were created after a seller explicitly configured a TTL.

Historical ledger events are left unchanged. Their canonical bytes and hashes remain valid.

`Clearinghouse.open()` automatically wraps its configured store with the clearinghouse migration registry. A v1 snapshot is therefore presented to the kernel as v2 in memory, but the underlying durable copy remains v1 until a later successful domain mutation saves the current schema through normal compare-and-swap.

## Generic example

```js
import { JsonFileSnapshotStore } from '../src/store.js';
import { MigratingSnapshotStore, SnapshotMigrationRegistry } from '../src/migrations.js';

const migrations = new SnapshotMigrationRegistry({ currentVersion: 3 })
  .register(1, (snapshot) => ({
    ...snapshot,
    schemaVersion: 2,
    newField: null,
  }))
  .register(2, (snapshot) => ({
    ...snapshot,
    schemaVersion: 3,
    anotherField: [],
  }));

const store = new MigratingSnapshotStore(
  new JsonFileSnapshotStore('./data/state.json'),
  migrations,
);
```

Production deployments should use the same registry around a transactional database adapter.

## Migration quality bar

Every migration should have tests for:

- a representative historical snapshot;
- boundary/null/empty values introduced by the old schema;
- preservation of revision, idempotency, and ledger data unless the migration explicitly changes them;
- restart after migration;
- failure behavior when required historical data is malformed;
- the corresponding application downgrade/rollback plan.

A migration that modifies hash-chained historical ledger events is particularly dangerous: changing event bytes invalidates their hashes. Prefer additive state outside historical event bodies. If an event format itself must evolve, version future events rather than rewriting history.

## Rollout strategy

For a production database migration:

1. back up or snapshot the durable store;
2. deploy software capable of reading the old schema and migrating it in memory;
3. validate application behavior before intentionally persisting the new schema;
4. persist through the normal transactional/CAS path;
5. keep a documented rollback point and understand whether old software can read the new schema.

For v1→v2 specifically, old software cannot understand a persisted v2 snapshot because v1 correctly fails closed on unknown schema versions. A deployment that must support rollback should therefore keep a v1 backup/snapshot until the v2 rollout is accepted.

Some future changes may require an offline data migration instead of lazy read migration. That should be an explicit operational tool using the same versioned transformation functions, not hidden behavior inside the clearinghouse kernel.
