# Mission bundle reservations

A useful mission often depends on several scarce services together: launch, orbital transfer, relay, ground contact, docking, storage, servicing, power, compute, or payload operations.

Buying one leg without the others can strand capital and leave capacity reserved for a mission that cannot actually execute.

`MissionBundleCoordinator` provides a recoverable orchestration layer for that problem while keeping every economic reservation inside the clearinghouse kernel.

## What a bundle is

A bundle is a buyer-owned intent containing two or more ordered legs:

```json
{
  "name": "Mission A",
  "legs": [
    { "legId": "launch", "offerId": "offer-launch", "quantity": 1 },
    { "legId": "transfer", "offerId": "offer-transfer", "quantity": 1 },
    { "legId": "relay", "offerId": "offer-relay", "quantity": 5000 }
  ]
}
```

The coordinator does **not** create a second capacity system. Each successful leg is an ordinary clearinghouse order created through `Clearinghouse.createOrder()`.

## Why v1 is a saga, not an atomic bundle transaction

The bundle state store and clearinghouse state store are separate durability boundaries. A coordinator cannot honestly claim one distributed ACID transaction across them.

V1 therefore uses a recoverable saga:

```text
planned
  |
  v
reserving
  |  reserve leg 1
  |  reserve leg 2
  |  ...
  +--------------------> reserved
  |
  | later leg unavailable
  v
compensating
  |  cancel prior unfunded legs in reverse order
  +--------------------> compensated
  |
  | prior leg already funded / otherwise non-cancellable
  v
attention-required
```

## Stable idempotency

Every leg receives deterministic clearinghouse idempotency identities derived from the bundle and leg IDs:

- one key for reservation;
- one key for compensation/cancellation.

This makes ambiguous network failures recoverable. If a reservation committed but the coordinator lost the response, retrying the same leg replays the original order instead of consuming capacity twice.

The same property applies to compensation: a lost cancellation response does not release capacity twice on retry.

## Compensation rules

If a later leg cannot be reserved because the offer is gone, closed, out of capacity, or otherwise unavailable, earlier still-unfunded orders are cancelled in reverse leg order.

Compensation never bypasses normal clearinghouse rules.

A prior order in `reserved` may be cancelled by the buyer. An order already in `funded`, `delivered`, or another non-cancellable state is not silently reversed. The bundle becomes:

```text
attention-required
```

with the blocking order and state recorded in the bundle failure artifact.

This is intentionally conservative. A funded leg may require a refund, dispute, rebooking, or other external financial workflow before a mission can be unwound safely.

## Expiry semantics

A bundle may have an optional planning/execution deadline.

Before execution is claimed, an expired bundle cannot begin reserving new capacity.

Once compensation is necessary, that planning deadline no longer blocks cleanup. Capacity already reserved by a partially executed saga must be releasable even if the original planning window has elapsed.

## Persistence

Bundle state uses the same minimal CAS snapshot-store contract as other orchestration modules, but has its own schema version and revision.

This means bundle workflow state can evolve independently from clearinghouse persisted-state migrations.

The coordinator persists progress after each leg. A process restart can therefore resume reservation or compensation from durable state rather than starting the mission purchase again.

## Infrastructure failures versus economic failures

Known market failures such as insufficient capacity cause compensation.

Unexpected infrastructure failures are different. If a payment/database/network dependency fails ambiguously, the coordinator does not guess that an economic action failed. It leaves durable saga progress in place and lets the error surface. A retry uses the same idempotency identity and can safely discover/replay the prior result.

## Ordering

Leg order is explicit and deterministic. V1 reserves in the supplied order and compensates in reverse order.

The coordinator does not attempt to optimize ordering, rank providers, minimize price, or infer mission dependencies. Those are mission-planning/marketplace policies above this neutral primitive.

A higher-level planner may decide, for example, that a launch slot should be reserved after a scarce docking slot, or vice versa. The coordinator simply executes the declared plan safely.

## What this does not promise

V1 does not claim:

- distributed atomicity across operators/markets;
- escrow or automatic refunds;
- automatic provider substitution;
- route optimization;
- temporal dependency solving;
- compatibility checking between cargo, vehicle, docking, power, or data interfaces;
- that a `reserved` bundle is already funded or mission-ready.

Those can compose above or extend the bundle protocol explicitly.

## Future true atomic bundle reservation

For multiple offers that live inside one clearinghouse authority, a future kernel-level `reserveBundle()` could validate all legs and decrement every offer in a single snapshot transaction. That would provide true all-or-none capacity reservation inside that one authority.

Cross-clearinghouse or cross-operator missions will still require saga, commitment, or distributed coordination protocols.

## Space logistics relevance

The primitive is intended for the increasingly multimodal shape of commercial space services: launch-to-orbit, orbital transfer, logistics, servicing, communications, and ground/surface infrastructure may be supplied by independent businesses but consumed as one mission chain.

Keeping each leg as a standard clearinghouse order preserves interoperability while giving mission planners a durable way to coordinate the chain.
