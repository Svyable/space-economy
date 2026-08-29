# Reservation expiry execution

The clearinghouse kernel already owns the objective rule for unpaid reservation expiry:

- the order must still be `reserved`;
- the seller must have configured a reservation TTL;
- the materialized `fundingDueAt` must be due;
- funded orders must never be silently expired;
- capacity restoration and order expiry happen in one clearinghouse mutation.

`ReservationExpiryWorker` adds the missing **operational execution primitive** without putting timers or background work inside the kernel.

## Package entry point

```text
space-economy-clearinghouse/reservation-expiry
```

## One-shot execution

```js
import { ReservationExpiryWorker } from 'space-economy-clearinghouse/reservation-expiry';

const worker = new ReservationExpiryWorker({
  market,
  actorId: 'system:reservation-expiry',
  batchSize: 100,
});

const result = await worker.runOnce();
```

`runOnce()` is deliberately finite. A deployment chooses how and when it runs:

- cron;
- Kubernetes CronJob;
- a durable queue consumer;
- a workflow engine;
- a scheduled serverless job;
- an operator-triggered maintenance command.

The library does not create an interval, daemon, detached promise, or hidden background task.

## Execution safety

For every due candidate, the worker calls the authoritative clearinghouse transition with:

- configured worker `actorId`;
- the candidate order's `version` as `expectedVersion`;
- a stable idempotency key derived from `{ orderId, fundingDueAt }`.

The idempotency key format is:

```text
reservation-expiry:<sha256>
```

That keeps retries stable without depending on potentially long/custom order identifiers.

The clearinghouse still re-checks status and deadline at mutation time. Candidate discovery is never treated as authorization or proof that expiry is still valid.

## Races

A reservation may change after candidate discovery and before `expireOrder()` runs.

The worker treats these known state/concurrency outcomes as safe skips:

```text
NOT_FOUND
CONFLICT
STALE_VERSION
RESERVATION_NOT_EXPIRABLE
RESERVATION_NOT_DUE
```

Examples:

- the buyer funds between scan and expiry;
- another worker expires the same order first;
- the order version advances;
- the candidate source was stale.

The worker records the skip and continues the batch.

Unexpected errors—database outages, persistence failures, programming errors—are **not swallowed**. `runOnce()` rejects so the external scheduler can retry or alert.

## Reference candidate source

`LedgerReservationExpirySource` is the dependency-free reference source.

It:

1. scans `getLedger()` for `spaceeconomy.order.reserved.v1` order IDs;
2. loads current state with `getOrder()`;
3. keeps only `reserved` orders with non-null `fundingDueAt` at or before the supplied scan time;
4. orders candidates by `fundingDueAt`, then order ID;
5. returns at most the requested batch size.

This is intentionally simple and rebuildable. It proves the worker contract but is not the production scaling target because scanning the entire ledger is O(history).

## PostgreSQL candidate source

For deployments already using `PostgresSnapshotStore`, the package also provides:

```text
space-economy-clearinghouse/postgres-reservation-expiry
```

`PostgresReservationExpirySource` derives current expirable reservations from the authoritative PostgreSQL snapshot into a deadline-indexed table. A scheduler can run:

```js
await source.refresh();
const result = await worker.runOnce();
```

The projection is explicitly derived and may lag. That is safe because `ReservationExpiryWorker` still supplies optimistic `expectedVersion` and the clearinghouse revalidates the current order state before restoring capacity.

See [`POSTGRES_RESERVATION_EXPIRY.md`](POSTGRES_RESERVATION_EXPIRY.md) for schema, refresh, revision-regression, lag, failure, and observability guidance.

## Replaceable due-reservation source

A deployment may inject any source implementing:

```text
listDue({ now, limit }) -> Order[]
```

The worker only requires each candidate to carry:

- `id`;
- `fundingDueAt`;
- positive integer `version`.

A production source can therefore use:

- the provided indexed PostgreSQL projection;
- a due-time priority queue;
- a durable scheduler;
- a read projection maintained from normalized application commits.

The candidate source may be stale; the clearinghouse transition remains the final authority.

## Batch behavior

`batchSize` defaults to 100 and is bounded from 1 to 1000.

Execution is sequential in the reference worker. That keeps database pressure predictable and makes race/failure behavior easy to reason about. A high-throughput deployment can shard candidate sources or run multiple workers because optimistic versions and persisted idempotency protect the economic transition.

Multiple workers are expected to race occasionally. Known race outcomes are skips, not corruption.

## Actor identity

The default actor ID is:

```text
system:reservation-expiry
```

The kernel intentionally permits any authenticated actor to trigger an objectively due unpaid reservation. The worker actor therefore does not gain a special financial privilege—it merely provides attribution.

Production deployments should choose a stable authenticated service identity and run normal policy gates if the deployment requires them.

For signed/offline execution, the same `order.expire` operation is available through `SignedCommandExecutor`.

## Why the worker is outside the kernel

The kernel should answer:

> Is this reservation due, and can capacity be restored atomically now?

It should not answer:

> Which scheduler, clock daemon, queue, deployment platform, or retry policy should wake up at that time?

Keeping scheduling external preserves deterministic domain behavior and lets different operators choose reliability infrastructure appropriate to their mission.

## Production evolution

The worker and PostgreSQL source close the basic operational loop, but durable scheduling can still evolve further.

Future production infrastructure may add:

1. incremental due-index maintenance rather than full snapshot-derived refresh;
2. durable wake-up/retry state;
3. metrics for due backlog and oldest overdue reservation;
4. dead-letter/alert behavior for repeated infrastructure failures;
5. sharding/leases for very high-throughput multi-worker operation;
6. optional signed-command transport when execution crosses trust/network boundaries.

Do not weaken the kernel deadline/status/version checks when adding those features, and do not rewrite historical ledger events merely to make an incremental projector easier.
