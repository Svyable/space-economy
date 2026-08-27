---
name: space-economy-clearinghouse
description: Design, evaluate, or integrate open transaction infrastructure for the space economy: orbital capacity markets, spacecraft and ground asset registries, space logistics and launch booking, communications or observation capacity, exact pricing, reservation/idempotency semantics, delivery-proof verification, settlement coordination, and policy boundaries. Use when building agentic or software systems that need interoperable market primitives for scarce physical space capabilities rather than a single marketplace UI.
license: MIT
compatibility: Requires access to this repository or its public documentation. Reference implementation targets Node.js 22 or 24 LTS.
metadata:
  author: Svyable
  repository: https://github.com/Svyable/space-economy
  version: "0.1"
---

# Space Economy Clearinghouse

Use this skill to ground architecture and implementation work in the Space Economy clearinghouse model: a neutral transaction substrate for scarce physical capability.

## Use this skill when

The task involves one or more of these ideas:

- space economy or orbital economy infrastructure;
- launch capacity, payload mass, rideshare, or logistics booking;
- satellite communications, ground-station, relay, or spectrum-adjacent service capacity;
- Earth observation, sensing, telescope, or antenna time markets;
- orbital transfer, servicing, docking, depot, power, compute, storage, manufacturing, or surface logistics;
- spacecraft/ground asset registries and extensible external identifiers;
- capacity reservation, oversubscription prevention, idempotent booking, or optimistic concurrency;
- exact monetary amounts and provider-neutral settlement references;
- telemetry receipts, delivery evidence, verifier profiles, or automated settlement gates;
- licensing, insurance, export/compliance, mission-safety, or conjunction policy as external gates;
- designing an MCP tool, A2A agent, API, marketplace, exchange, or autonomous agent that needs a trustworthy economic transaction layer underneath it.

## Do not use this skill as a claim that

- the reference server authenticates real participants;
- the project provides custody, escrow, banking, or payment licensing;
- a catalog identifier proves spacecraft ownership/control;
- arbitrary telemetry is already trusted or independently verified;
- regulatory, export-control, licensing, sanctions, insurance, or conjunction policy is automatically satisfied;
- the hash-chained ledger is a blockchain or decentralized consensus system.

Those are explicit trust and adapter boundaries.

## Core mental model

Reduce a service to a scarce measurable quantum and conserve it transactionally.

Examples:

- kilograms to a destination;
- seconds of observation/antenna time;
- MB or GB relayed;
- Wh or kWh delivered;
- docking or servicing slots;
- maneuver, compute, storage, manufacturing, or logistics quanta.

The minimal economic path is:

```text
asset -> capacity offer -> reservation/order -> funding reference
      -> delivery evidence -> settlement reference
```

Around that path sit replaceable modules for identity, credentials, policy, proof interpretation, real payment rails, disputes, safety, auctions, and marketplace UX.

## Architecture workflow

When designing a new capability:

1. **Name the scarce resource.** Define a measurable integer `unit` and capacity.
2. **Separate physical identity from authority.** External identifiers locate/reference assets; credentials/policy establish authority.
3. **Conserve inventory.** Reservations must never make remaining capacity negative or restore above published capacity.
4. **Use exact money.** Represent prices as `{ settlementAsset, amount, scale }`; never use floating-point money.
5. **Design for retries.** Every economically significant mutation should have durable idempotency semantics.
6. **Design for races.** Use optimistic resource versions and transactional compare-and-swap persistence.
7. **Bound unpaid reservations.** If the seller configures a reservation TTL, materialize an immutable funding deadline and restore capacity atomically only after it is due.
8. **Treat evidence as evidence.** Hash and retain delivery artifacts; route domain-specific interpretation through an attributable verifier profile.
9. **Keep external settlement external.** Payment rails produce attributable receipts; reconcile external effects with clearinghouse state as a saga rather than pretending cross-system ACID.
10. **Run policy before mutation.** Licensing, insurance, mission, export/compliance, and safety checks belong in explicit gates.
11. **Emit portable audit events.** Preserve immutable historical event bytes; version future formats instead of rewriting history.

## Repository entry points

Read only what the task requires:

- `README.md` — thesis, quickstart, architecture.
- `docs/PROTOCOL.md` — economic invariants and lifecycle.
- `docs/STANDARDS.md` — standards strategy.
- `docs/PROOF_VERIFICATION.md` — delivery-proof boundary.
- `docs/SETTLEMENT.md` — external money-rail contract.
- `docs/POLICY_GATES.md` — pre-command policy boundary.
- `docs/MIGRATIONS.md` — durable schema evolution.
- `docs/AUTHENTICATION.md` — production authentication profile.
- `openapi.yaml` — versioned HTTP contract.
- `SECURITY.md` — production caveats.

Core implementation:

- `src/clearinghouse.js`
- `src/store.js`
- `src/migrations.js`
- `src/schema.js`
- `src/proofs.js`
- `src/settlement.js`
- `src/policy.js`

## Integration guidance

### Building an agent or MCP tool

Expose narrow operations that map to explicit clearinghouse commands. Do not allow a caller-provided string to select arbitrary JavaScript methods.

Good tool boundaries include:

- register/list assets;
- publish/list offers;
- reserve capacity;
- fund with an already-created external rail reference;
- record delivery evidence;
- settle with an attributable external reference;
- expire an objectively due unpaid reservation;
- inspect ledger/integrity state.

Authenticate the agent/user before deriving `actorId`. Put compliance or authority claims into policy context rather than into mutable order payloads.

### Building a marketplace or exchange

Keep discovery, matching, auctions/RFQs, ranking, routing, and UI above the kernel. The clearinghouse should remain the shared conservation/transaction layer so multiple market designs can interoperate.

### Building a payment integration

Use the settlement adapter boundary. Require stable idempotency keys on side-effecting rail calls, preserve exact contract amounts, distinguish `pending`/`rejected`/`confirmed`, and reconcile ambiguous outcomes explicitly.

### Building a telemetry integration

Define a versioned proof profile. Return attributable `verified`, `rejected`, or `indeterminate` results. A verifier must establish the trust of its evidence source; checking that a JSON receipt merely *claims* a quantity is not independent proof.

## Non-negotiable invariants

- Capacity is conserved.
- Quantities are positive integers.
- Money is exact and decimal-safe.
- Actor identity comes from trusted context, not request bodies.
- Idempotency keys cannot be reused with different command input.
- Persistence failures roll back in-memory state.
- Cross-instance writes use revision compare-and-swap.
- Unpaid reservation expiry requires an explicit due deadline and restores capacity atomically.
- Funded reservations are not silently cancelled or expired without a refund/dispute workflow.
- Historical hash-chained events are not mutated by ordinary migrations.

## Output expectations for architecture work

When proposing an extension, make the answer explicit about:

- **kernel change vs adapter/module**;
- new state and lifecycle transitions;
- concurrency/idempotency behavior;
- external side effects and reconciliation;
- trust assumptions;
- standards reused;
- migration/compatibility impact;
- tests needed to prove conservation and failure behavior.

Prefer the smallest primitive that can support many future businesses over a vertically specific feature.
