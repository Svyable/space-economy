# PostgreSQL reservation expiry source

`PostgresReservationExpirySource` is the production-oriented due-candidate source for `ReservationExpiryWorker`.

It keeps candidate discovery separate from the authoritative economic transition:

```text
PostgresSnapshotStore
        |
        | committed clearinghouse snapshot
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

The projection is rebuildable read-model state. It is never an alternate order ledger and never authorizes an expiry by itself.

## Why this exists

The dependency-free `LedgerReservationExpirySource` is a correctness reference. It scans reservation history and loads current orders individually, so its hot path grows with ledger history.

The PostgreSQL source moves that derivation into an explicit refresh. `listDue()` becomes a bounded indexed deadline query over:

```text
(store_key, funding_due_at, order_id)
```

## Driver boundary

The module imports no database driver. Inject a pool compatible with the node-postgres `query()` + `connect()` surface:

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

await source.refresh();
const result = await worker.runOnce();
```

Scheduling stays external: cron, a Kubernetes CronJob, workflow engine, queue consumer, or serverless scheduler decides when to run the finite refresh/worker sequence.

## Projection schema

By default the source creates:

```text
public.space_economy_due_reservations
public.space_economy_due_reservation_meta
```

Candidate rows contain only:

```text
store_key
order_id
funding_due_at
version
```

The metadata row records the clearinghouse snapshot revision represented by the projection and the latest refresh time. SQL identifiers are validated before interpolation; `storeKey` remains a bound parameter.

## Refresh semantics

`refresh()`:

1. starts a `REPEATABLE READ` transaction;
2. takes a projection-scoped advisory transaction lock;
3. reads the authoritative snapshot revision and persisted schema version;
4. fails closed if that schema is newer than this software understands;
5. locks the projection metadata row;
6. refuses source-revision regression;
7. replaces candidate rows from `snapshot.orders`;
8. records source revision and refresh time;
9. commits atomically.

Only orders whose current persisted state is:

```text
status = reserved
fundingDueAt != null
```

are projected. Whether the deadline is already due is evaluated by `listDue({ now, limit })`, so future reservations stay indexed and become eligible naturally as time advances.

## Persisted-schema compatibility

This adapter reads the persisted PostgreSQL JSON snapshot directly instead of going through `MigratingSnapshotStore`, so it must own an explicit compatibility guard.

Historical snapshot schemas up to the currently supported clearinghouse schema are tolerated. A snapshot whose `schemaVersion` is newer than `CURRENT_SCHEMA_VERSION` fails before candidate rows are replaced with:

```text
UNSUPPORTED_EXPIRY_PROJECTION_SCHEMA
```

The existing projection remains intact because the transaction rolls back. Do not bypass that guard or guess how future order fields should be interpreted.

The source also refuses to refresh from a snapshot revision older than the revision already represented by the projection:

```text
EXPIRY_PROJECTION_REGRESSION
```

That protects operators from silently combining an older restored authoritative database with a newer derived table.

## Projection lag is safe

Projection lag can delay release, but it cannot make expiry valid earlier than the kernel permits.

Example:

1. revision 20 projects order `O` as `reserved`, version 1;
2. at revision 21 the buyer funds `O`;
3. the expiry projection has not refreshed yet;
4. `listDue()` still returns version 1;
5. the worker calls `expireOrder(O, { expectedVersion: 1, ... })`;
6. the clearinghouse rejects the stale/current-state mismatch;
7. the worker records a known race skip;
8. the next projection refresh removes `O`.

The same protection applies if another worker cancels or expires the reservation first. The worker's stable idempotency key and optimistic version are the economic safety boundary; the projection only proposes candidates.

## Multi-worker behavior

Multiple schedulers may discover the same row. At most one can win the authoritative clearinghouse transition. Others resolve as known state/version races.

Projection refresh itself is serialized per configured source through a PostgreSQL advisory transaction lock.

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
- expiry projection source revision and lag;
- time since last successful refresh;
- projected candidate count;
- due candidates scanned per worker run;
- expired vs skipped counts;
- skip codes, especially `STALE_VERSION`;
- refresh, schema-compatibility, or persistence failures;
- oldest overdue candidate.

Growing revision/time lag means unpaid capacity may be released later than policy intends, even though the kernel still prevents unsafe early expiry.

## Failure behavior

Projection refresh and worker execution are separate failure domains.

If refresh fails, its transaction rolls back and the previous projection remains available. The deployment should surface that failure. Running the worker against an older projection is a deployment policy choice; doing so remains economically safe but may generate more race skips.

If worker execution encounters an unexpected infrastructure error, it rejects rather than swallowing the failure. Already committed expiries stay committed and stable idempotency makes retry safe.

## Scaling boundary

This adapter optimizes the due-scan path, not the entire persistence model.

`PostgresSnapshotStore` still stores a monolithic clearinghouse snapshot, so `refresh()` currently performs a full derivation from `snapshot.orders`. The existing audit ledger is intentionally not projection-complete enough to reconstruct all current order state safely.

Do not rewrite historical ledger bytes just to make incremental projection easier.

A future storage evolution can retain the same `listDue({ now, limit })` source contract while deriving it from normalized order tables, a projection-complete change feed, new versioned projection events, or a durable scheduler table maintained with order state.

## Trust boundary

The PostgreSQL source answers only:

> Which projected reservations appear due for objective unpaid-expiry evaluation?

The clearinghouse still owns order existence, current status/version, deadline semantics, capacity restoration, event emission, durable idempotency, and transactional persistence.
