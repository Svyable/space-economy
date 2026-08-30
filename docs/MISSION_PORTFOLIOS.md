# Contingent mission portfolios

A mission is usually a dependency graph, not one reservation. Launch, relay, ground, maneuver, compute, sensing, servicing, and other scarce legs can all be individually available while the mission as a whole is infeasible.

The existing `MissionBundleCoordinator` deliberately reserves ordinary orders and compensates earlier reservations if a later reservation fails. That is useful execution infrastructure, but it is too late a commitment boundary for mission planning: once an order is funded or otherwise irreversible, pretending the bundle can roll back is unsafe.

Schema-v4 capacity rights create a stronger planning primitive because they hold real physical inventory without yet creating service orders.

## Portfolio invariant

A contingent mission portfolio is **secured** only when every required leg is backed by a live `held` capacity right owned by the portfolio buyer.

No portfolio leg may be exercised before the complete required set is secured.

```text
public availability
    -> held capacity rights for every portfolio leg
    -> ordinary orders when explicitly exercised
```

If acquisition fails before exercise begins, already-acquired rights are released in reverse acquisition order. Releasing a right restores the authoritative offer exactly once through the clearinghouse kernel. The coordinator never edits `offer.remaining` itself.

## Lifecycle

```text
planned -> acquiring -> secured -> exercising -> active
                  \-> unwinding -> unwound

exercising -> attention-required
unwinding  -> attention-required
```

`attention-required` is intentional. Once a right has been exercised into an order, the service lifecycle may no longer be reversible. The portfolio must not claim atomic rollback across funded, delivered, settled, or externally dependent work.

## Leg definition

Each leg binds:

- a stable leg ID;
- authoritative `offerId`;
- exact positive quantity;
- exact `exerciseUnitPrice`;
- right expiry / exercise deadline;
- optional reservation TTL for the resulting order;
- an integer stage for dependency ordering;
- non-authoritative metadata.

Seller identity is deliberately **not** a buyer-supplied portfolio field.

## Trusted acquisition boundary

The portfolio coordinator does not call `createCapacityRight()` by manufacturing seller context. That would let orchestration data impersonate a capacity owner.

Instead construction requires an injected `capacityRightAcquirer` with:

```js
acquireCapacityRight({
  portfolioId,
  legId,
  buyerId,
  terms,
  idempotencyKey,
})
```

The acquirer is an authorization boundary owned by the deployment. It may obtain a right through signed seller commands, negotiated procurement, RFQ award, a broker policy, or another trusted workflow.

The coordinator trusts neither the request nor the returned object blindly. Before recording a leg as held it verifies that the authoritative right:

- is live and `held`;
- is held by the portfolio buyer;
- references the requested offer;
- has the exact requested quantity;
- has the exact requested settlement asset, amount, and decimal scale;
- has the requested reservation TTL;
- has the exact requested expiry;
- carries an immutable terms hash.

This preserves the kernel rule that only authorized seller-side execution may create a physically backed right.

## Acquisition saga

For each required leg, in deterministic stage/leg order:

1. ask the trusted acquisition capability for a right using a stable per-portfolio/per-leg idempotency key;
2. validate the returned authoritative right against the requested leg;
3. persist the right ID and immutable terms hash in coordinator state;
4. continue only after that coordinator checkpoint commits.

If any acquisition fails, transition to `unwinding` and release prior held rights in reverse order with stable idempotency keys.

A crash after the external/kernel acquisition succeeds but before coordinator persistence remains recoverable: the same acquisition idempotency key must replay the same authoritative right, after which the coordinator can persist the missing checkpoint.

Coordinator persistence itself is CAS-backed. Failed saves roll in-memory state back to the last durable snapshot so callers never observe an unsaved transition as committed state.

## Exercise

Exercise is explicit and staged.

Before exercising a stage, the coordinator re-reads every right in that stage and verifies:

- status is `held`;
- holder is still the portfolio buyer;
- immutable terms hash matches the acquired artifact;
- deadline has not passed.

It then exercises rights using stable per-leg idempotency keys. Each successful exercise produces an ordinary clearinghouse order carrying capacity-right provenance.

Stages permit dependency boundaries such as “secure everything, exercise launch and ground preparation, then exercise relay capacity after deployment confirmation” without inventing a universal mission state machine.

If one right in a stage exercises and a later right fails, the portfolio becomes `attention-required`. It does not release the successful order or pretend atomic rollback.

## Ownership and transfer

A portfolio records the right it acquired; it does not own the right independently of the clearinghouse.

If a buyer transfers a secured portfolio right away before exercise, the portfolio fails closed rather than exercising inventory no longer held by the buyer. A future portfolio-transfer protocol could transfer all component rights as an attributable saga, but that is a separate primitive.

## Expiry

Passing a capacity-right deadline does not silently restore inventory. The underlying clearinghouse retains its explicit `expireCapacityRight()` transition.

A portfolio that discovers an overdue held right cannot call itself secured or active. It surfaces the specific leg as attention required while an expiry worker performs the objective kernel transition.

## Concurrency

Two competing portfolios may both request the final physical units. Their coordinators do not adjudicate that race. The authoritative right-acquisition path and clearinghouse capacity transaction do; at most one right can own the same final units.

The losing portfolio unwinds any earlier rights it already acquired. No coordinator-local counter can mint extra capacity.

## What this is not

This is not distributed ACID. It does not reserve across independent clearinghouses atomically, custody money, price derivatives, insure mission failure, or guarantee that a physical mission succeeds.

It is deterministic contingent-inventory orchestration: **secure the whole physically backed plan before converting any leg into an execution obligation.**

## Federation path

Federation checkpoints make a future cross-clearinghouse portfolio possible without one global database. A remote leg could eventually carry:

- issuing clearinghouse identity;
- capacity-right terms hash;
- signed checkpoint containing its issuance/transfer event;
- verified ledger extension from the buyer's last trusted checkpoint;
- remote trust-policy decision.

That future protocol should treat remote rights as externally attested inventory and use a saga; it must not pretend multiple clearinghouses share a transaction lock.
