# Market watchlists

`MarketWatchRegistry` turns read-only market evidence into durable, edge-triggered conditions that an external scheduler or agent runtime can evaluate safely.

It deliberately does **not** contain a timer, send notifications, or execute trades.

## Why a separate operational primitive

Market data already has explicit read contracts:

- `CapacityDirectory.find()` for bounded capacity discovery;
- `RfqOpportunityDirectory.listOpportunities()` for seller-actionable buyer demand;
- `MarketLiquidityDirectory.snapshot()` for aggregate supply/demand evidence.

A watch should consume those contracts rather than duplicate their matching logic inside the clearinghouse kernel.

The resulting architecture is:

```text
market/RFQ truth
      |
      v
read directories / projections
      |
      v
MarketWatchRegistry
      |
      +--> durable pending trigger
      |
external scheduler / notification adapter / agent
```

The watch store is operational state. It is not transaction authority.

## Public module

```js
import { MarketWatchRegistry } from 'space-economy-clearinghouse/market-watchlists';
```

Inject whichever read capabilities the deployment wants to support:

```js
const watches = await MarketWatchRegistry.open({
  capacityDirectory,
  rfqOpportunityDirectory,
  marketLiquidityDirectory,
  statePath: './data/watches.json',
});
```

A custom snapshot store may be supplied instead of `statePath`. The registry uses the same asynchronous `load()` / `save(snapshot, { expectedRevision })` CAS contract as other orchestration modules.

## Watch kinds

### Capacity available

```js
const watch = await watches.createWatch({
  kind: 'capacity-available',
  query: {
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    minRemaining: 1000,
    capabilities: ['optical'],
  },
}, {
  actorId: 'buyer-a',
  idempotencyKey: 'relay-watch-1',
});
```

The registry calls the configured `CapacityDirectory` with a one-result bounded query.

The condition is true when at least one matching capacity item exists.

Watch definitions do not accept cursors. Every evaluation asks the selected read source for the current condition.

### RFQ opportunity available

```js
await watches.createWatch({
  kind: 'rfq-opportunity-available',
  query: {
    service: 'data-relay',
    settlementAsset: 'iso4217:USD',
  },
}, { actorId: 'seller-a' });
```

The seller identity is taken from trusted watch ownership and injected into `RfqOpportunityDirectory` at evaluation time.

A watch definition cannot supply another `sellerId`. This prevents an agent from using the watch configuration to redefine whose actionable demand is being monitored.

The condition is true when at least one currently quoteable RFQ/offer pair exists.

### Liquidity balance threshold

```js
await watches.createWatch({
  kind: 'liquidity-balance',
  market: {
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
  },
  operator: 'lte',
  threshold: '-1000',
}, { actorId: 'operator-a' });
```

`threshold` is a signed integer string. The watch compares it exactly with the liquidity directory's:

```text
constrainedBalance = open supply - constrained RFQ demand
```

Supported operators are `lte` and `gte`.

No floating-point ratio, spread, fair-value model, or hidden liquidity score is introduced.

## Edge-trigger behavior

A watch fires on a condition transition:

```text
false -> true
```

It does not fire again while the condition remains true.

After the condition becomes false, a later transition back to true creates another trigger.

The first evaluation establishes the initial observation. If the condition is already true on that first evaluation, it creates a trigger.

Disabling and explicitly re-enabling a watch resets its observation, so a currently true condition may trigger again after re-enable.

## Durable trigger outbox

Evaluation does not merely return an in-memory notification.

A rising edge first persists a trigger record inside the watch store:

```text
id
watchId
ownerId
kind
triggeredAt
evidenceDigest
sourceCursor
evidence
```

Only after that durable CAS commit does `evaluateWatch()` return the new trigger.

This gives notification delivery an **at-least-once** recovery path:

```js
const pending = await watches.listPendingTriggers({ actorId: 'buyer-a' });
```

After a notification adapter successfully delivers a trigger, the owner acknowledges it:

```js
await watches.acknowledgeTrigger(watchId, triggerId, {
  actorId: 'buyer-a',
  idempotencyKey: `ack:${triggerId}`,
});
```

Until acknowledgement, the trigger survives process restart.

Delivery adapters should therefore tolerate duplicate delivery attempts. Acknowledgement is durably idempotent when the caller supplies an idempotency key.

Each watch retains at most 100 unacknowledged triggers. A new rising edge fails explicitly with `TRIGGER_BACKLOG_FULL` rather than silently discarding an alert.

## Concurrency

Within one registry instance, evaluations join the same serialized command queue as watch mutations.

Across registry instances, the snapshot store revision is the compare-and-swap boundary.

If two workers observe the same rising edge concurrently:

1. both may read the same market evidence;
2. one commits the new trigger first;
3. the losing worker reloads the winning watch state;
4. it sees that the condition is already active;
5. it does not append a second trigger for that edge.

The read source and the watch store are still separate systems. This is not a distributed transaction. The trigger records the source revision(s) and evidence digest that produced it.

## Source revisions and projection lag

Evidence records source revision metadata:

- capacity watches: clearinghouse/read-source revision;
- RFQ opportunity watches: RFQ revision + clearinghouse revision;
- liquidity watches: RFQ revision + clearinghouse revision.

If a deployment injects an eventually consistent projection, the watch follows the revision that projection actually served. It does not pretend projection data is current merely because wall-clock time advanced.

## One-shot scheduler

A deployment scheduler may call:

```js
const run = await watches.runOnce({ limit: 100 });
```

`runOnce()`:

- evaluates active watches sequentially;
- is bounded to 100 watches per invocation;
- may be scoped to one `ownerId`;
- returns successful evaluations and attributable per-watch failures;
- does not swallow source errors;
- does not choose its own recurrence interval.

Cron, queues, serverless scheduled jobs, or another agent runtime should own cadence.

`runOnce()` is an operator surface: it may inspect watches belonging to several owners and returns owner IDs. Deployments must place authentication, authorization, tenancy isolation, and notification routing around it. Do not expose it as an unauthenticated public endpoint.

## Owner boundary

User-facing watch operations require trusted actor context:

- `createWatch()`
- `getWatch()`
- `listWatches()`
- `setWatchEnabled()`
- `evaluateWatch()`
- `listPendingTriggers()`
- `acknowledgeTrigger()`

A participant cannot read, evaluate, modify, or acknowledge another participant's watch through these methods.

## What watches do not do

A watch does not:

- reserve capacity;
- submit an RFQ quote;
- accept an RFQ award;
- execute a signed command;
- rank buyers or sellers;
- predict price or demand;
- guarantee that evidence remains actionable after the trigger is emitted;
- send email, SMS, Slack, webhook, or push notifications itself.

After a trigger, any economic action still goes through the normal current-state checks, trusted identity, policy, idempotency, and capacity-conservation path.

## Recommended delivery loop

```text
scheduler invokes runOnce()
        |
        v
new durable pending triggers
        |
        v
notification adapter attempts delivery
        |
    success? ---- no ---> retry later
        |
       yes
        v
acknowledgeTrigger()
```

Do not acknowledge before delivery if loss of the alert is unacceptable.

## Scaling path

The reference registry stores watch definitions and trigger outbox records through the generic snapshot-store contract. That is appropriate for reference/local operation and makes cross-instance CAS semantics testable.

A high-volume deployment can later add:

- PostgreSQL watch/index storage;
- sharded due/evaluation queues;
- source-revision fanout so unchanged watches need not all be polled;
- Webhook/CloudEvents notification adapters;
- tenant-scoped worker leases;
- trigger retention/archive policy.

Those should preserve the same observable semantics: durable definitions, explicit source revisions, false-to-true triggering, durable pending triggers, and acknowledgement after delivery.
