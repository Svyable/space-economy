# Capacity discovery

`CapacityDirectory` is the read-side contract for finding scarce physical capability without turning the clearinghouse kernel into a marketplace ranking engine.

It is available through:

```text
space-economy-clearinghouse/capacity-query
GET /v1/capacity
MCP tool: find_capacity
```

The existing `listOffers()` / `GET /v1/offers` / `list_offers` surfaces remain for compatibility. New agent and marketplace discovery flows should prefer the bounded query contract.

## Why this is separate from the transaction kernel

The clearinghouse owns economic truth:

- published capacity;
- remaining capacity;
- exact prices;
- reservation/order transitions;
- persisted revision;
- tamper-evident events.

Discovery systems own different concerns:

- filtering;
- pagination;
- indexes and projections;
- search latency;
- optional future ranking/routing.

Those concerns should be replaceable without changing reservation or settlement semantics. `CapacityDirectory` therefore reads through the public clearinghouse interface and does not mutate persisted state.

## Stable read snapshot

A discovery page is built from one clearinghouse revision.

The reference implementation brackets asset/offer reads with the monotonic market revision:

```text
revision before
     |
     v
read assets + offers
     |
     v
revision after
```

The page is accepted only when the two revisions match. If the market repeatedly changes while a snapshot is being assembled, the query fails with:

```text
READ_SNAPSHOT_CONFLICT
```

A caller should retry the query. No economic mutation is rolled back or affected by a discovery failure.

## Filters

The v1 query supports exact, composable constraints:

- `service`;
- `unit`;
- `settlementAsset`;
- `sellerId`;
- `assetType`;
- `capabilities` — all requested capabilities must be present on the producing asset;
- `minRemaining` — positive integer capacity floor;
- `availableAt` — instant that must be inside the offer service window;
- `status` — defaults to `open`; `all`/`null` includes open and filled offers.

The query intentionally does **not** rank by seller, price, reputation, policy preference, routing preference, or mission utility. Those are marketplace/agent concerns above this neutral read contract.

## Availability semantics

For `availableAt`:

- a null `windowStart` is unbounded in the past;
- a null `windowEnd` is unbounded in the future;
- `windowStart` is inclusive;
- `windowEnd` is exclusive.

This query filter does not reserve capacity. A matching offer may be consumed by another participant before the caller submits a reservation command.

## Pagination

Default page size is 25 and maximum page size is 100.

Results are ordered deterministically by:

1. offer `createdAt`;
2. offer `id`.

The caller receives:

```json
{
  "revision": 42,
  "items": [],
  "nextCursor": "opaque-or-null"
}
```

The HTTP representation places `items` under `data` and the revision/cursor under `meta`. MCP returns the same information as structured tool output.

### Cursor contract

A cursor is opaque. Clients must not parse, edit, construct, or persist assumptions about its encoding.

The reference cursor binds:

- cursor schema version;
- clearinghouse revision;
- result offset;
- canonical hash of the filter set.

`limit` is intentionally not part of the filter hash, so a caller may change page size while continuing the same revision/filter sequence.

Reusing a cursor with different filters fails with:

```text
CURSOR_QUERY_MISMATCH
```

If any successful market mutation changes the clearinghouse revision before the next page, continuation fails with:

```text
STALE_CURSOR
```

The caller restarts from page one. This is preferable to silently skipping or duplicating offers while inventory is changing.

## Why revision-pinned pagination

Offset pagination over a live capacity market is unsafe by default.

Example:

```text
page 1: offers A, B
another buyer fills A
page 2 offset now points after C
```

Without snapshot semantics the caller can miss C or observe duplicates depending on the store/query implementation.

Pinning the cursor to an economic revision makes this race explicit. The first implementation uses in-memory filtering, but the cursor contract can remain the same when discovery moves to indexed PostgreSQL projections, search infrastructure, or another read store.

## Future read-model implementation

A production-scale directory can replace the reference snapshot scan with a projection keyed by clearinghouse revision.

Useful indexes may include:

- service + status;
- asset type/capability;
- settlement asset;
- remaining quantity;
- availability window;
- seller;
- geographic/orbital fields owned by a domain-specific projection.

The projection should preserve these external semantics:

1. one page corresponds to one clearinghouse revision;
2. cursor/filter mismatch fails closed;
3. market revision changes invalidate continuation unless the read store can serve the historical pinned revision;
4. ranking remains an explicit higher layer rather than hidden inside clearing/settlement logic.

## Trust boundary

Discovery answers what capacity the clearinghouse currently records. It does not independently establish:

- spacecraft ownership/control;
- regulatory authority;
- seller reputation;
- telemetry truth;
- payment finality;
- conjunction safety;
- future physical availability.

Credentials, policy gates, proof verifiers, settlement adapters, and mission-safety systems remain separate attributable boundaries.
