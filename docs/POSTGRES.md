# PostgreSQL snapshot store

`PostgresSnapshotStore` is the first production-oriented persistence adapter for the clearinghouse. It preserves the small snapshot-store contract while moving durability and cross-process concurrency into PostgreSQL.

The module has **no database-driver runtime dependency**. Applications pass a pool with the common `query()` + `connect()` interface. `node-postgres` (`pg`) is one compatible choice, but it is not a clearinghouse protocol dependency.

## Example

```js
import pg from 'pg';
import { Clearinghouse } from './src/clearinghouse.js';
import { PostgresSnapshotStore } from './src/postgres-store.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

const store = new PostgresSnapshotStore(pool, {
  schema: 'public',
  table: 'space_economy_snapshots',
  storeKey: 'production-market',
});

await store.ensureSchema();
const market = await Clearinghouse.open({ store });
```

Configure TLS, certificates, credentials, pooling, timeouts, observability, and secret management in the selected PostgreSQL driver/deployment. The reference adapter does not weaken those settings or create its own connection layer.

## Table

`ensureSchema()` creates one table when the configured schema already exists:

```sql
CREATE TABLE IF NOT EXISTS public.space_economy_snapshots (
  store_key TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  snapshot JSONB NOT NULL CHECK (snapshot ? 'revision'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((snapshot->>'revision')::BIGINT = revision)
);
```

Schema/table identifiers are restricted to simple PostgreSQL identifiers so configuration cannot become SQL injection. `storeKey` is always passed as a query parameter and may identify an independent clearinghouse state row.

Production infrastructure may manage this DDL through its normal migration system instead of granting the runtime role `CREATE TABLE`. In that case, create the equivalent table ahead of time and do not call `ensureSchema()` from the service process.

## Compare-and-swap transaction

Every guarded `save(snapshot, { expectedRevision })` performs one PostgreSQL transaction:

1. `BEGIN`;
2. acquire a transaction-scoped advisory lock namespaced by schema/table/store key;
3. `SELECT revision ... FOR UPDATE` for the state row;
4. compare the persisted revision with `expectedRevision`;
5. throw `STORE_CONFLICT` without writing if the revision changed;
6. insert or update the row;
7. `COMMIT`.

The advisory lock matters for the **missing-row** case. `FOR UPDATE` can lock an existing row, but two first writers cannot lock a row that does not exist yet. The advisory lock serializes first creation and later updates through the same per-store-key critical section.

This is still optimistic concurrency at the clearinghouse level: a losing process gets `STORE_CONFLICT`, refreshes current state through the kernel's existing conflict path, and may retry the logical command.

## Why a snapshot row first

The reference domain kernel currently persists an atomic snapshot. Mapping every asset/offer/order/event into normalized SQL tables would create a second domain model and a much larger migration surface before the transaction protocol is stable.

A JSONB snapshot row provides:

- real PostgreSQL durability and backups;
- transactional revision CAS;
- crash-safe commit/rollback;
- multi-process coordination;
- a straightforward migration path from the existing snapshot contract.

It is not intended to be the final analytics/query model. Deployments can project CloudEvents or committed state into read-optimized tables, warehouses, search systems, or event streams without making those projections part of the clearinghouse commit transaction.

## Multi-market / multi-tenant use

Different `storeKey` values use different rows and different advisory-lock namespaces. This can host several logically independent clearinghouses in one table.

Do not treat `storeKey` as an authorization boundary. Database credentials and application policy must still prevent one tenant from choosing or reading another tenant's key. Strong multi-tenant deployments may prefer separate schemas, databases, or database roles.

## Failure semantics

A transaction failure before `COMMIT` is rolled back. The integration suite injects a failure after PostgreSQL has executed an INSERT but before commit and verifies that a second connection observes no row afterward.

If the network fails **after the server committed but before the client observed the COMMIT response**, the application may not know whether the write succeeded. The clearinghouse's persisted idempotency records and revision CAS are designed for this class of retry: reload current state and retry the same logical command with the same idempotency key.

## Operational recommendations

For production deployments:

- use managed backups / PITR appropriate to transaction value;
- monitor connection pool saturation, transaction latency, lock waits, storage growth, and failed commits;
- set statement/transaction timeouts in the database or driver;
- use a least-privilege runtime role;
- require TLS where the database connection leaves a trusted local boundary;
- rehearse restore and schema-migration procedures;
- keep application instances on compatible clearinghouse schema versions during rolling deployments.

The migration layer can wrap `PostgresSnapshotStore` exactly as it wraps memory or JSON stores; migration-on-load does not require a Postgres-specific code path.
