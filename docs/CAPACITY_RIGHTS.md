# Transferable capacity rights

Commercial commitments are promises about terms. Capacity rights are different: they are **physical inventory holds**.

A capacity right removes a quantity from an authoritative offer when the right is created, attributes that held quantity to a participant, and allows the holder to transfer, exercise, release, or let the right expire without ever creating synthetic capacity.

## Conservation model

For one offer, the clearinghouse treats capacity as moving between states rather than being copied:

```text
publicly available -> held right -> order reservation -> consumed/settled
                         |                 |
                         |                 +-> cancelled/expired -> publicly available
                         +-> release/expiry -----------------------> publicly available
```

The critical invariant is:

> A quantity leaves `offer.remaining` exactly once when a right is created. Exercising that right does not decrement `offer.remaining` again.

A right can therefore hold the final available units even when the public offer becomes `filled`. Exercise remains valid because the inventory was already removed from public availability.

## Creating a right

Only the authoritative offer seller may create a capacity right.

```js
const right = await market.createCapacityRight({
  offerId,
  holderId: 'mission-operator-a',
  quantity: 20,
  exerciseUnitPrice: {
    settlementAsset: 'iso4217:USD',
    amount: '1500',
    scale: 2,
  },
  reservationTtlSeconds: 120,
  expiresAt: '2026-09-01T12:00:00Z',
  metadata: {
    missionRef: 'mission-42',
  },
}, {
  actorId: 'relay-provider',
  idempotencyKey: 'hold-mission-42',
});
```

Creation validates current real offer availability and immediately subtracts the held quantity from `offer.remaining`.

The initial holder must differ from the seller in V1.

## Immutable terms

A right's `termsHash` binds the physical/service terms:

- `offerId`
- `assetId`
- seller
- service
- unit
- quantity
- `exerciseUnitPrice`
- reservation TTL policy
- exercise deadline
- canonical metadata

The current holder is intentionally **not** part of the immutable terms hash because ownership is transferable.

The right separately records:

- `initialHolderId`
- current `holderId`
- append-only transfer history
- lifecycle status/version
- linked order after exercise
- release/expiry evidence

## Two distinct economic prices

A secondary market introduces two potentially unrelated prices:

1. consideration paid to acquire or transfer the **right**;
2. the price of the underlying **service when the right is exercised**.

V1 keeps them separate.

`exerciseUnitPrice` is immutable and becomes the ordinary service order's `unitPrice`.

Any premium paid to acquire or resell the right is external settlement evidence and is not silently folded into the service invoice. The clearinghouse does not claim custody of that premium.

This separation avoids a common derivatives/secondary-market accounting error where the resale price of an entitlement is mistaken for the underlying service settlement amount.

## Transfer

Only the current holder may transfer a held, unexpired right:

```js
await market.transferCapacityRight(right.id, {
  toHolderId: 'mission-operator-b',
}, {
  actorId: 'mission-operator-a',
  expectedVersion: right.version,
  idempotencyKey: 'transfer-right-42',
});
```

Transfer changes ownership only.

It does **not** decrement or restore offer capacity because the quantity remains continuously held.

The previous holder immediately loses transfer/release/exercise authority after the transfer commits, while remaining able to read the right as a historical party for audit purposes.

A V1 transfer cannot name the seller as the new holder. Returning inventory to the seller is a `release`, not a disguised transfer.

## Exercise

Only the current holder may exercise a held right before its deadline.

Exercise creates an ordinary clearinghouse order with:

- holder as buyer;
- original seller;
- held quantity;
- immutable `exerciseUnitPrice`;
- normal funding deadline policy;
- `capacityRight.id` and `termsHash` provenance.

The clearinghouse does **not** subtract capacity during exercise because the quantity was removed when the right was created.

The resulting order follows the ordinary lifecycle:

```text
reserved -> funded -> delivered -> settled
reserved -> cancelled
reserved -> expired
```

If the order is cancelled or its funding reservation expires, the existing order lifecycle restores the quantity to `offer.remaining` exactly once. The right remains `exercised` and cannot be reused.

## Release

The current holder may voluntarily release a held right before its exercise deadline.

Release:

- returns the held quantity to `offer.remaining` exactly once;
- marks the right `released`;
- records attributable release evidence;
- permanently prevents exercise or another release.

A participant acquiring a right through a separate paid transaction must handle any refund/compensation semantics outside this physical-capacity transition. The clearinghouse does not fabricate a refund rail.

## Expiry

Because held capacity is real inventory, deadline passage alone must not pretend the quantity is already available again.

A read of an overdue held right therefore returns:

```json
{
  "status": "held",
  "expiryDue": true
}
```

The persisted lifecycle changes to `expired` only when `expireCapacityRight()` runs and atomically restores capacity.

Any authenticated actor may trigger objective expiry at/after the deadline. The triggering actor is recorded for audit.

Scheduling remains outside the domain kernel; a cron worker, queue consumer, or operator can invoke the deterministic transition.

## Concurrency

Capacity rights use the clearinghouse's existing command queue, persisted idempotency, optimistic resource versions, and snapshot-store CAS boundary.

That gives important race behavior without a new lock service:

### Competing right creation

Two stale workers may both believe capacity is available, but only one stale snapshot can commit. The loser receives `STORE_CONFLICT`, reloads the winner, and a retry evaluates the reduced current capacity.

### Transfer versus exercise

Both operations mutate the same right version/state. One commits; the stale worker conflicts. A retry sees either a new holder or an exercised right.

### Expiry versus exercise

A worker just before the deadline may attempt exercise while another at/after the deadline attempts expiry. CAS ensures only one state transition wins. The committed state determines whether capacity remains in an order or returns to public availability.

## Read authorization

The seller, current holder, initial holder, and participants appearing in the transfer history can read the right.

Only the current holder has holder-side mutation authority.

This preserves historical audit visibility without allowing former holders to reclaim control.

## Schema v4

Clearinghouse state schema v4 adds only:

```json
{
  "capacityRights": []
}
```

The v3 -> v4 migration does not rewrite assets, offers, orders, commercial commitments, idempotency records, or historical hash-chained ledger events.

## Events

The ledger records:

- `spaceeconomy.capacity-right.created.v1`
- `spaceeconomy.capacity-right.transferred.v1`
- `spaceeconomy.capacity-right.released.v1`
- `spaceeconomy.capacity-right.expired.v1`
- `spaceeconomy.capacity-right.exercised.v1`

Exercise also emits the ordinary `spaceeconomy.order.reserved.v1` event with capacity-right provenance.

## What this primitive enables

Once held inventory can move safely between participants, higher layers can build:

- bilateral resale listings;
- capacity auctions;
- paid options;
- broker or market-maker inventories;
- contingency capacity for missions;
- standardized forward capacity;
- collateralized commitments;
- portable rights across federated clearinghouses.

Those layers must not bypass the right's conserved physical state.

## Intentional limits

V1 does not add:

- an exchange or matching engine;
- automatic trading;
- acquisition-premium custody;
- margin accounts;
- securities-law classification;
- partial right splitting;
- merging/fungibility across offers;
- cross-clearinghouse portability;
- automatic expiry scheduling.

Those are separate protocols. The kernel owns one thing here: a transferable, attributable entitlement to a quantity of capacity that is actually unavailable to everyone else while the right is held.
