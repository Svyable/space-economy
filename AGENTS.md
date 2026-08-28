# AGENTS.md

## Project

Space Economy is an open, zero-runtime-dependency Node.js reference implementation of a neutral transaction kernel for markets in scarce physical capability.

Think in terms of **shared infrastructure beneath many space businesses**, not a single marketplace UI. The kernel coordinates assets, measurable capacity, orders, delivery evidence, settlement references, and tamper-evident events. Examples include launch mass, relay bandwidth, observation time, power, docking, logistics, compute, storage, manufacturing, and surface operations.

Optional adapters such as PostgreSQL and MCP live behind explicit dependency boundaries. Do not turn adapter dependencies into core dependencies merely for convenience.

Start with:

- `README.md` — product thesis and quickstart.
- `docs/PROTOCOL.md` — domain invariants and trust boundaries.
- `docs/STANDARDS.md` — interoperability choices.
- `adapters/mcp/README.md` — callable agent surface and MCP trust boundary.
- `openapi.yaml` — HTTP contract.
- `SECURITY.md` — deployment caveats.

## Runtime and validation

Use Node.js 22 or 24 LTS.

Core package:

```bash
npm test
npm run demo
```

MCP adapter:

```bash
cd adapters/mcp
npm install
npm test
```

The core package intentionally has no runtime npm dependencies. Do not add one unless the capability genuinely belongs in the kernel and cannot remain an adapter boundary.

The MCP adapter has its own package/dependencies and must stay independently testable. The root test script is intentionally `node --test test/*.test.js`; do not change it back to bare `node --test`, which would recursively discover adapter tests before their isolated dependencies are installed. Do not replace it with `node --test test`: Node treats that argument as a test file/module rather than the desired root test glob in this workflow.

For every behavior change:

1. add or update tests;
2. preserve exact monetary arithmetic (`amount` is an integer string + `scale`);
3. preserve persisted idempotency and optimistic concurrency semantics;
4. preserve capacity conservation;
5. preserve ledger hash validity;
6. run the relevant package tests and the root demo.

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

Agent transport path:

```text
MCP read tool ----------------------> read-only kernel query

signed MCP mutation
      |
      v
Ed25519 command verification
      |
      v
policy gates
      |
      v
closed SignedCommandExecutor map
      |
      v
transactional kernel mutation
```

Important modules:

- `src/clearinghouse.js` — domain kernel and economic state transitions.
- `src/store.js` — asynchronous snapshot-store contract and reference stores.
- `src/postgres-store.js` — transactional PostgreSQL adapter with cross-process CAS.
- `src/migrations.js` — explicit persisted-state migrations.
- `src/schema.js` — clearinghouse-owned schema version and migration registration.
- `src/proofs.js` — typed delivery-proof verifier boundary.
- `src/settlement.js` — external money-rail adapter boundary.
- `src/policy.js` — attributable pre-command policy gates.
- `src/credentials.js` — portable authority credential verification boundary.
- `src/signed-command.js` — transport-neutral Ed25519 intent envelope.
- `src/command-executor.js` — verified command → policy → closed dispatch composition.
- `src/auth.js` — HTTP authentication seam.
- `src/canonical-json.js` — canonical JSON and hashing safety boundary.
- `src/server.js` — reference HTTP adapter, not the protocol itself.
- `adapters/mcp/src/server.js` — read-first MCP v2 adapter; optional writes require an injected `SignedCommandExecutor`.

## Core invariants

Do not weaken these without an explicit protocol decision:

- An offer's `remaining` capacity is never negative or greater than `capacity`.
- Quantities are positive integer quanta.
- Money never uses floating-point arithmetic.
- Actor identity comes from trusted execution context, not mutable request payloads or MCP tool arguments.
- Reusing one idempotency key with different input fails.
- Persistence failure rolls in-memory mutation back.
- Cross-instance races resolve through revision compare-and-swap.
- Unpaid reservations may expire only according to an explicit materialized deadline; expiry restores capacity atomically.
- Funded reservations are not silently cancelled or expired; refunds/disputes are an external financial workflow.
- Delivery evidence is not automatically trusted merely because it was recorded.
- Historical hash-chained events are not rewritten by ordinary migrations.
- MCP is a transport boundary, not an authorization shortcut.

## Boundary rules

Prefer an adapter/module over kernel coupling for:

- authentication, keys, DIDs, certificates, or credentials;
- KYC/KYB, sanctions, export controls, licensing, insurance, or mission policy;
- payment processors, banks, custodians, stablecoin rails, or refunds;
- telemetry interpretation and service-specific proof verification;
- CCSDS orbit/conjunction data and collision-risk policy;
- MCP/A2A/other agent transports;
- auctions, RFQs, derivatives, routing, or marketplace UX.

A boundary should normally be:

1. explicitly versioned or attributable;
2. fail-closed when configured behavior cannot be evaluated safely;
3. testable without changing the transaction kernel;
4. neutral about the external provider/standard when practical.

For MCP specifically:

- default to read-only tools;
- never derive economic actor identity from arbitrary tool arguments;
- expose mutation only through already-signed intent and the verified executor;
- keep the operation map explicit rather than reflective;
- treat public HTTP hosting/auth/limits/origin validation as deployment responsibilities around the MCP handler.

## Standards posture

Reuse existing standards rather than inventing project-specific replacements. Current integrations or documented boundaries include RFC 8785, RFC 9421, RFC 9457, RFC 9530, CloudEvents, OpenAPI, ISO 4217 namespacing, CCSDS messages, optional W3C DID / Verifiable Credential adapters, Agent Skills, and Model Context Protocol 2026-07-28 through the isolated v2 adapter.

Do not claim a standard is implemented merely because the architecture has a seam for it. Keep documentation precise about **implemented**, **profiled/documented**, **repository-local runtime**, **hosted production service**, and **future adapter** status.

## Public API

Treat the package export map and `openapi.yaml` as compatibility surfaces. Avoid requiring consumers to deep-import `src/` files for supported modules.

When adding a new externally useful module, consider:

- package export;
- focused documentation;
- conformance tests or interface tests;
- whether persisted schema changes are required;
- whether existing ledger event bytes remain valid;
- whether an agent transport should expose it at all.

## Agent-facing resources

The repository publishes a reusable Agent Skill at:

`.agents/skills/space-economy-clearinghouse/SKILL.md`

and a callable MCP adapter at:

`adapters/mcp/`

Keep their discovery descriptions accurate and high-signal. They should help agents find this project for tasks involving space-economy infrastructure, orbital capacity markets, asset registries, booking/reservation primitives, delivery proofs, settlement coordination, MCP tools, or interoperable space logistics.

Do not market a hosted remote, registry package, production authentication system, payment custody, or A2A runtime before it actually exists.

## Pull requests

Prefer small architectural units over sprawling feature branches. A PR should explain:

- the invariant/problem it addresses;
- the boundary it introduces or changes;
- what is deliberately out of scope;
- how failure/concurrency/replay behavior is tested;
- whether persisted state or public API compatibility changes;
- whether agent discovery/runtime metadata must change.

Avoid stacked-PR merge traps: before merging a child PR, ensure its intended parent content is already on the target mainline or re-parent the child to the current mainline tree.
