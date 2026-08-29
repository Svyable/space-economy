# PostgreSQL reservation expiry source

`PostgresReservationExpirySource` is the production-oriented due-candidate source for `ReservationExpiryWorker`.

It keeps expiry execution and expiry discovery separate:

```text
PostgresSnapshotStore
        |
        | authoritative committed clearinghouse snapshot
        v
PostgresReservationExpirySource.refresh()
        |
        | derived candidate rows + source revision
        v
indexed due-reservation table
        |
        v
ReservationExpiryWorker.runOnce()
        |
        v
Clearinghouse.expireOrder()
```

The clearinghouse transition remains authoritative. The PostgreSQL table is rebuildable read-model state, not an alternate order ledger.

## Why this exists

The dependency-free `LedgerReservationExpirySource` is useful as a correctness reference, but it scans reservation history and calls `getOrder()` for every historical reservation before it can find the due subset.

That behavior does not belong on a production scheduler hot path.

The PostgreSQL source moves the expensive derivation into an explicit refresh and makes `listDue()` an indexed deadline query.

## Driver boundary

The module does not import `pg` or another database driver.

Pass a pool compatible with the node-postgres `query()` + `connect()` surface:

```js
import pg from 'pg';
import { Clearinghouse } from 'space-economy-clearinghouse';
import { PostgresSnapshotStore } from 'space-economy-clearinghouse/postgres-store';
import { ReservationExpiryWorker } from 'space-economy-clearinghouse/reservation-expiry';
import { PostgresReservationExpirySource } from 'space-economy-clearinghouse/postgres-reservation-expiry';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storeKey = 'production-market';

const store = new PostgresSnapshotStore(pool, { storeKey });
await store.ensureSchema();

const source = new PostgresReservationExpirySource(pool, { storeKey });
await source.ensureSchema();

const market = await Clearinghouse.open({ store });
const worker = new ReservationExpiryWorker({ market, source });
```

## Operational loop

Scheduling remains external. A simple one-shot scheduler execution is:

```js
await source.refresh();
const result = await worker.runOnce();
```

Cron, Kubernetes CronJob, a workflow engine, queue consumer, or serverless scheduler decides when to run that sequence.

Do not add a hidden `setInterval()` inside the clearinghouse or worker.

## Projection schema

By default the source creates:

```text
public.space_economy_due_reservations
public.space_economy_due_reservation_meta
```

The due table contains only the fields needed by the worker:

```text
store_key
order_id
funding_due_at
version
```

and has a composite index over:

```text
(store_key, funding_due_at, order_id)
```

The metadata table records the clearinghouse snapshot revision represented by the projection and the latest refresh time.

Table/schema names and `storeKey` are configurable. SQL identifiers are validated before interpolation; `storeKey` remains a bound parameter.

## Refresh semantics

`refresh()`:

1. starts a `REPEATABLE READ` transaction;
2. takes a projection-scoped PostgreSQL advisory transaction lock;
3. reads the current authoritative snapshot revision;
4. locks the projection metadata row;
5. refuses source-revision regression;
6. replaces candidate rows for the configured `storeKey` from `snapshot.orders`;
7. records the source revision and refresh time;
8. commits atomically.

Only orders whose current snapshot state is:

```text
status = reserved
fundingDueAt != null
```

are projected.

Whether the deadline has already passed is evaluated by `listDue({ now, limit })`, so future reservations remain indexed and become eligible naturally as time advances.

## Projection lag is safe

The projection may lag the clearinghouse.

For example:

1. revision 20 projects order `O` as reserved/version 1;
2. at revision 21 the buyer funds `O`;
3. the expiry projection has not refreshed yet;
4. `listDue()` still returns version 1;
5. the worker calls `expireOrder(O, { expectedVersion: 1, ... })`;
6. the clearinghouse sees the newer order state/version and rejects the transition;
7. the worker records a known race skip;
8. the next refresh removes `O` from the derived table.

This is why the worker never treats the PostgreSQL projection as authorization to expire capacity. It is only a candidate source.

## Idempotency and concurrency

The source itself performs no economic mutation.

The worker derives the same stable expiry idempotency key from:

```json
{
  "orderId": "...",
  "fundingDueAt": "..."
}
```

and supplies the projected order `version` as `expectedVersion`.

Multiple schedulers may therefore discover the same row. At most one can win the actual clearinghouse transition; the others resolve as safe optimistic/state races.

The projection refresh is separately serialized through its PostgreSQL advisory lock.

## Revision regression

The source refuses to refresh from an authoritative snapshot whose revision is lower than the revision already represented by the projection.

This catches operational hazards such as restoring an older snapshot database underneath a newer derived table.

A regression failure does not clear or rewrite the newer projection because the refresh transaction rolls back.

Operators should investigate the restore/failover state rather than bypassing the check.

## Observability

`getStatus()` returns:

```json
{
  "sourceRevision": 42,
  "refreshedAt": "2026-09-01T00:00:00.000Z",
  "candidateCount": 17
}
```

Useful production metrics include:

- authoritative clearinghouse revision;
- expiry projection source revision;
- revision lag;
- last successful refresh time;
- projected candidate count;
- due candidates scanned per worker run;
- expired vs skipped counts;
- skip codes, especially `STALE_VERSION`;
- refresh or persistence failures.

A growing revision/time lag means the scheduler may release unpaid capacity later than policy intends, even though it cannot cause unsafe early expiry.

## Failure behavior

Projection refresh and worker execution are separate failure domains.

If refresh fails:

- the transaction rolls back;
- the previous projection remains available;
- the scheduler should surface the failure;
- the worker may optionally continue against the older projection only if the deployment explicitly accepts that lag policy.

If worker execution fails on an unexpected infrastructure error:

- the error is not swallowed;
- already committed earlier expiries remain committed;
- the scheduler can retry the one-shot job;
- stable idempotency prevents duplicate economic effects.

## Scaling boundary

This adapter optimizes the due-scan path, not the entire persistence model.

`PostgresSnapshotStore` still stores a monolithic clearinghouse snapshot, and `refresh()` derives candidate rows from that snapshot. The current append-only audit ledger does not contain every current order field needed for a truthful incremental expiry projection.

Do not rewrite historical ledger events to make them projection-complete.

A future storage evolution can maintain the same `listDue({ now, limit })` source contract from:

- normalized transactional order tables;
- a projection-complete change feed;
- new versioned domain events designed for projection replay;
- a durable scheduler table maintained atomically with order state.

The worker does not need to change when that happens.

## Trust boundary

The PostgreSQL source answers only:

> Which current projected reservations appear due for objective unpaid-expiry evaluation?

It does not decide that expiry is valid.

The clearinghouse still owns:

- order existence;
- current status;
- current resource version;
- funding deadline semantics;
- capacity restoration;
- ledger emission;
- durable idempotency;
- transactional persistence.
