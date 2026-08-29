# PostgreSQL capacity projection

`PostgresCapacityProjection` is an indexed read model for the bounded capacity-discovery contract defined in [`CAPACITY_DISCOVERY.md`](CAPACITY_DISCOVERY.md).

It does **not** replace the clearinghouse transaction store. The clearinghouse remains authoritative for reservations, funding, delivery, settlement, ledger history, and resource versions. The projection exists only to make market discovery cheaper and more scalable.

## Package entry point

```text
space-economy-clearinghouse/postgres-capacity-projection
```

The module imports no PostgreSQL driver. Inject a node-postgres-compatible pool (or equivalent `query()` + `connect()` adapter).

```js
import pg from 'pg';
import { Clearinghouse } from 'space-economy-clearinghouse';
import { PostgresSnapshotStore } from 'space-economy-clearinghouse/postgres-store';
import { PostgresCapacityProjection } from 'space-economy-clearinghouse/postgres-capacity-projection';
import { createHttpServer } from './src/server.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const store = new PostgresSnapshotStore(pool, { storeKey: 'production-market' });
await store.ensureSchema();
const market = await Clearinghouse.open({ store });

const capacitySource = new PostgresCapacityProjection(pool, {
  projectionKey: 'production-market',
});
await capacitySource.ensureSchema();
await capacitySource.refreshFromMarket(market);

const server = createHttpServer({ market, capacitySource });
```

The MCP adapter accepts the same source:

```js
const handler = createSpaceEconomyMcpHandler({
  market,
  capacitySource,
});
```

Only `find_capacity` uses the injected source. Asset listing, order reads, market integrity status, and signed mutations continue to use the authoritative clearinghouse instance.

## Data model

The default `tablePrefix` is:

```text
space_economy_capacity
```

The projection creates three tables:

```text
space_economy_capacity_meta
space_economy_capacity_assets
space_economy_capacity_offers
```

The metadata row records the clearinghouse `revision` represented by one `projectionKey`.

Asset rows retain:

- asset ID;
- asset type;
- capabilities as JSONB;
- full asset JSON.

Offer rows retain indexed discovery dimensions:

- offer ID;
- asset ID;
- seller ID;
- service;
- unit;
- settlement asset;
- remaining quantity;
- status;
- service-window start/end;
- creation time;
- full offer JSON.

Indexes cover the main v1 query dimensions, including a GIN index for asset capabilities.

## Refresh semantics

`refreshFromMarket(market)` first captures one stable clearinghouse snapshot by bracketing public asset/offer reads with `getRevision()`.

It then opens one PostgreSQL transaction and:

1. acquires an advisory transaction lock for the projection key;
2. locks the current projection metadata row;
3. refuses to replace a newer projection with an older clearinghouse revision;
4. replaces the projection's offer rows;
5. replaces the projection's asset rows;
6. writes the new projection revision;
7. commits atomically.

Readers therefore observe either the old complete projection or the new complete projection, not a half-refreshed mixture.

A revision regression fails with:

```text
PROJECTION_REGRESSION
```

A repeatedly changing clearinghouse snapshot during refresh fails with:

```text
READ_SNAPSHOT_CONFLICT
```

Refresh failure rolls the database transaction back.

## Query semantics

`PostgresCapacityProjection` implements the `CapacityDirectory` source contract:

```text
search({ filters, expectedRevision, offset, limit })
  -> { revision, items, hasMore }
```

Queries run inside `REPEATABLE READ READ ONLY` transactions.

Filtering, counting, deterministic ordering, offset, and bounded `limit + 1` retrieval happen in PostgreSQL. The full projection is not loaded into JavaScript before filtering.

`CapacityDirectory` still owns:

- query normalization;
- canonical filter hashing;
- opaque cursor encoding;
- filter/cursor mismatch detection;
- public page shape.

This keeps HTTP/MCP/client semantics identical whether discovery uses the live market source or PostgreSQL.

## Projection lag and cursors

The projection revision is the clearinghouse revision from which the projected rows were captured.

Example:

```text
clearinghouse revision: 106
projection revision:    104
```

A `find_capacity` response served from the projection reports revision `104`.

If a caller received a cursor for revision 104 and the clearinghouse advances to 107 **without the projection refreshing**, the cursor can still continue against the internally consistent revision-104 projection.

After the projection refreshes to revision 107, continuing a revision-104 cursor fails with:

```text
STALE_CURSOR
```

This is intentional. The contract is "one page sequence from one represented economic revision," not "every read must synchronously block on the newest clearinghouse write."

Applications that require maximum freshness can compare:

```js
const marketRevision = await market.getRevision();
const projectionRevision = await capacitySource.getRevision();
const lag = marketRevision - projectionRevision;
```

and apply their own freshness/SLO policy.

## Refresh orchestration

The reference projection does **not** automatically subscribe to mutations.

A production deployment must choose an explicit refresh strategy, for example:

- refresh after a successful clearinghouse mutation in an application service;
- periodic refresh for discovery workloads that tolerate bounded lag;
- a durable background worker driven by transaction/event notifications;
- a future incremental event/read-model projector.

Do not place an external projection refresh inside the clearinghouse's transaction and pretend the two systems share ACID. If refresh fails after a committed economic mutation, retry/reconcile the read model independently.

## Current scaling boundary

The first implementation performs a full transactional replacement for one `projectionKey` on refresh. Query cost is indexed, but refresh cost is proportional to the number of projected assets/offers.

That is a deliberate intermediate step:

- it proves the source/query abstraction;
- it preserves exact revision semantics;
- it gives production-shaped indexed reads;
- it avoids inventing incomplete event-sourcing guarantees before the ledger contains every projection field required for reconstruction.

The next scale step is an incremental projector that advances from one clearinghouse revision to the next, while retaining the same `CapacityDirectory` source contract.

## Operational notes

Use distinct `projectionKey` values for independent markets/tenants that share the same tables.

`schema` and `tablePrefix` are restricted to simple PostgreSQL identifiers. `tablePrefix` is capped so generated index names remain within PostgreSQL's identifier length limit.

Back up the authoritative clearinghouse store first. The capacity projection is derived data and should be rebuildable; it must never be the sole record of an economic transaction.

Monitor at least:

- clearinghouse revision;
- projection revision;
- projection lag;
- refresh duration/failures;
- `STALE_CURSOR` rate;
- `PROJECTION_EMPTY` / `PROJECTION_REGRESSION` errors;
- query latency and result counts.

## Trust boundary

An indexed projection makes discovery faster. It does not strengthen the truth of the underlying claims.

It still does not independently prove:

- spacecraft ownership/control;
- regulatory authority;
- future physical availability;
- telemetry correctness;
- seller reputation;
- payment finality;
- conjunction safety.

Those remain credential, policy, proof, settlement, and mission-safety concerns outside the read model.
