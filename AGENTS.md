# AGENTS.md

## Project

Space Economy is an open, zero-runtime-dependency Node.js reference implementation of a neutral transaction kernel for markets in scarce physical capability.

Think in terms of **shared infrastructure beneath many space businesses**, not a single marketplace UI. The kernel coordinates assets, measurable capacity, orders, delivery evidence, settlement references, and tamper-evident events. Examples include launch mass, relay bandwidth, observation time, power, docking, logistics, compute, storage, manufacturing, and surface operations.

Start with:

- `README.md` — product thesis and quickstart.
- `docs/PROTOCOL.md` — domain invariants and trust boundaries.
- `docs/STANDARDS.md` — interoperability choices.
- `openapi.yaml` — HTTP contract.
- `SECURITY.md` — deployment caveats.

## Runtime and validation

Use Node.js 22 or 24 LTS.

```bash
npm test
npm run demo
```

The project intentionally has no runtime npm dependencies. Do not add one unless the capability genuinely belongs in the core package and cannot remain an adapter boundary.

For every behavior change:

1. add or update tests;
2. preserve exact monetary arithmetic (`amount` is an integer string + `scale`);
3. preserve persisted idempotency and optimistic concurrency semantics;
4. preserve capacity conservation;
5. preserve ledger hash validity;
6. run the complete test suite and demo.

## Architecture map

Core transaction path:

```text
authenticated actor / verified command
              |
              v
        deployment policy
              |
              v
      Clearinghouse kernel
       /       |       \
   assets    offers    orders
       \       |       /
       tamper-evident events
              |
       async snapshot store
```

Important modules:

- `src/clearinghouse.js` — domain kernel and economic state transitions.
- `src/store.js` — asynchronous snapshot-store contract and reference stores.
- `src/migrations.js` — explicit persisted-state migrations.
- `src/schema.js` — clearinghouse-owned schema version and migration registration.
- `src/proofs.js` — typed delivery-proof verifier boundary.
- `src/settlement.js` — external money-rail adapter boundary.
- `src/policy.js` — attributable pre-command policy gates.
- `src/auth.js` — HTTP authentication seam.
- `src/canonical-json.js` — canonical JSON and hashing safety boundary.
- `src/server.js` — reference HTTP adapter, not the protocol itself.

## Core invariants

Do not weaken these without an explicit protocol decision:

- An offer's `remaining` capacity is never negative or greater than `capacity`.
- Quantities are positive integer quanta.
- Money never uses floating-point arithmetic.
- Actor identity comes from trusted execution context, not mutable request payloads.
- Reusing one idempotency key with different input fails.
- Persistence failure rolls in-memory mutation back.
- Cross-instance races resolve through revision compare-and-swap.
- Unpaid reservations may expire only according to an explicit materialized deadline; expiry restores capacity atomically.
- Funded reservations are not silently cancelled or expired; refunds/disputes are an external financial workflow.
- Delivery evidence is not automatically trusted merely because it was recorded.
- Historical hash-chained events are not rewritten by ordinary migrations.

## Boundary rules

Prefer an adapter/module over kernel coupling for:

- authentication, keys, DIDs, certificates, or credentials;
- KYC/KYB, sanctions, export controls, licensing, insurance, or mission policy;
- payment processors, banks, custodians, stablecoin rails, or refunds;
- telemetry interpretation and service-specific proof verification;
- CCSDS orbit/conjunction data and collision-risk policy;
- auctions, RFQs, derivatives, routing, or marketplace UX.

A boundary should normally be:

1. explicitly versioned or attributable;
2. fail-closed when configured behavior cannot be evaluated safely;
3. testable without changing the transaction kernel;
4. neutral about the external provider/standard when practical.

## Standards posture

Reuse existing standards rather than inventing project-specific replacements. Current integrations or documented boundaries include RFC 8785, RFC 9421, RFC 9457, RFC 9530, CloudEvents, OpenAPI, ISO 4217 namespacing, CCSDS messages, and optional W3C DID / Verifiable Credential adapters.

Do not claim a standard is implemented merely because the architecture has a seam for it. Keep documentation precise about **implemented**, **profiled/documented**, and **future adapter** status.

## Public API

Treat the package export map and `openapi.yaml` as compatibility surfaces. Avoid requiring consumers to deep-import `src/` files for supported modules.

When adding a new externally useful module, consider:

- package export;
- focused documentation;
- conformance tests or interface tests;
- whether persisted schema changes are required;
- whether existing ledger event bytes remain valid.

## Agent-facing resource

The repository publishes a reusable Agent Skill at:

`.agents/skills/space-economy-clearinghouse/SKILL.md`

Keep its discovery description accurate and high-signal. It should help agents find this project for tasks involving space-economy infrastructure, orbital capacity markets, asset registries, booking/reservation primitives, delivery proofs, settlement coordination, or interoperable space logistics.

Do not market features in the skill that the repository does not actually implement.

## Pull requests

Prefer small architectural units over sprawling feature branches. A PR should explain:

- the invariant/problem it addresses;
- the boundary it introduces or changes;
- what is deliberately out of scope;
- how failure/concurrency/replay behavior is tested;
- whether persisted state or public API compatibility changes.

Avoid stacked-PR merge traps: before merging a child PR, ensure its intended parent content is already on the target mainline or re-parent the child to the current mainline tree.
