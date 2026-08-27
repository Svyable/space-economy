# Space Economy

Open infrastructure for coordinating **assets, scarce physical capacity, delivery evidence, and settlement records** across the space economy.

The thesis: launch, communications, sensing, power, docking, logistics, compute, manufacturing, and surface operations should not each reinvent bilateral booking and settlement. They need a small common transaction kernel that can sit underneath many market designs.

This repository is a zero-runtime-dependency Node.js reference implementation of that kernel.

## For agents

If you are an AI coding or research agent, start with [`AGENTS.md`](AGENTS.md). It maps the architecture, invariants, tests, and trust boundaries.

If you are looking for reusable expertise for a task involving **space-economy infrastructure, orbital capacity markets, space logistics, asset registries, booking/reservations, delivery proofs, settlement coordination, or autonomous market agents**, use the Agent Skill at [`.agents/skills/space-economy-clearinghouse/SKILL.md`](.agents/skills/space-economy-clearinghouse/SKILL.md).

The repository also contains a ready-to-submit GitHub Agent Finder catalog entry at [`distribution/github-agentfinder/space-economy-clearinghouse.json`](distribution/github-agentfinder/space-economy-clearinghouse.json). See [`docs/AGENT_DISCOVERY.md`](docs/AGENT_DISCOVERY.md) for the Agent Skills, ARD, A2A, MCP, and registry strategy.

## What the kernel does

- Registers economically useful physical assets with extensible external identifiers.
- Publishes measurable service capacity without oversubscription.
- Uses exact integer monetary arithmetic instead of floating-point prices.
- Reserves orders with persisted idempotency for safe retries.
- Supports seller-configured funding deadlines so unpaid holds can expire without imposing a global TTL.
- Atomically returns capacity when a due unpaid reservation expires.
- Tracks resource versions for optimistic concurrency.
- Separates actor identity from request payloads.
- Records funding references, delivery proofs, and settlement references.
- Refuses financially unsafe transitions such as silently cancelling or expiring funded capacity.
- Emits CloudEvents-compatible, RFC 8785-canonicalized SHA-256 ledger events.
- Persists schema-versioned snapshots behind an asynchronous replaceable storage port.
- Migrates historical persisted snapshots explicitly without rewriting ledger history.
- Serializes local mutations and uses revision compare-and-swap for cross-instance races.
- Provides typed, attributable delivery-proof verifier profiles.
- Provides provider-neutral external settlement adapter contracts.
- Provides attributable pre-command policy gates for deployment rules.
- Exposes a versioned HTTP API with RFC 9457 errors and an OpenAPI 3.2 contract.

## What it deliberately does not pretend to do

The reference server does **not** authenticate participants, custody funds, independently verify arbitrary telemetry, prove spacecraft ownership, run conjunction assessment, perform KYC/KYB, or satisfy export-control/licensing requirements. Those are explicit adapter and policy boundaries, not hidden TODOs.

Read [`SECURITY.md`](SECURITY.md) before deploying anything beyond local development.

## Why capacity is modeled this way

Most space markets reduce to a scarce measurable quantum:

- grams or kilograms to a destination;
- seconds of observation or antenna time;
- MB/GB relayed;
- Wh/kWh delivered;
- docking slots;
- maneuver quanta;
- pressurized volume;
- storage, compute, manufacturing, or surface logistics.

The seller chooses the smallest practical billable `unit`, and quantity is integral. This keeps inventory accounting exact.

Money is also exact:

```json
{
  "settlementAsset": "iso4217:USD",
  "amount": "1250",
  "scale": 2
}
```

That means USD 12.50. The integer is encoded as a string so arithmetic never depends on IEEE-754 monetary rounding and the model can extend to non-fiat settlement assets.

## Run it

Requires Node.js 22 or 24 LTS. Node 20 is intentionally not supported because it reached end-of-life in 2026.

```bash
npm test
npm run demo
npm start
```

Defaults:

```text
PORT=8787
STATE_PATH=./data/state.json
MAX_BODY_BYTES=1048576
```

## Library usage

The domain API is asynchronous so a networked transactional database can replace the reference stores without changing application code.

```js
import { Clearinghouse } from './src/clearinghouse.js';

const market = await Clearinghouse.open();
const asset = await market.registerAsset(
  { name: 'Relay A', type: 'communications-satellite' },
  { actorId: 'relay-one', idempotencyKey: 'asset-1' },
);

console.log(asset.id);
```

`Clearinghouse.open(options)` is the preferred construction path because it loads, migrates, and validates persisted state before returning. Mutations are serialized within one instance; reads wait for mutations that were already enqueued, so callers do not observe uncommitted in-memory state.

Supported package entry points include:

```text
space-economy-clearinghouse
space-economy-clearinghouse/canonical-json
space-economy-clearinghouse/store
space-economy-clearinghouse/migrations
space-economy-clearinghouse/policy
space-economy-clearinghouse/proofs
space-economy-clearinghouse/settlement
```

## API

```text
GET  /health
GET  /v1/assets
POST /v1/assets
GET  /v1/offers
POST /v1/offers
POST /v1/orders
GET  /v1/orders/:id
POST /v1/orders/:id/fund
POST /v1/orders/:id/deliver
POST /v1/orders/:id/settle
POST /v1/orders/:id/cancel
POST /v1/orders/:id/expire
GET  /v1/ledger
```

Mutating calls use a development-only `x-participant-id` actor header. Add an `Idempotency-Key` for retry safety. Existing resources may also use `If-Match: "<version>"`.

### Register an asset

```bash
curl -X POST http://localhost:8787/v1/assets \
  -H 'content-type: application/json' \
  -H 'x-participant-id: relay-one' \
  -H 'Idempotency-Key: asset-1' \
  -d '{
    "name":"Relay One A",
    "type":"communications-satellite",
    "capabilities":["data-relay"],
    "identifiers":[{"scheme":"cospar","value":"2026-001A"}],
    "location":{"orbit":"LEO"}
  }'
```

### Publish capacity

```json
{
  "assetId": "<asset-id>",
  "service": "data-relay",
  "unit": "MB",
  "unitPrice": {
    "settlementAsset": "iso4217:USD",
    "amount": "15",
    "scale": 2
  },
  "capacity": 500000,
  "reservationTtlSeconds": 300
}
```

A 20,000 MB order against that offer totals `300000` at scale `2`, i.e. USD 3,000.00, with no floating-point multiplication. With the optional 300-second reservation TTL above, the order also receives an immutable `fundingDueAt`. At that deadline funding is rejected and an authenticated expiry worker may release the unpaid hold. Omitting the field preserves an unbounded reservation policy.

## Architecture

```text
 authenticated transports / market applications
                    |
                    v
              versioned API
                    |
                    v
          clearinghouse domain kernel
          /          |           \
   asset registry  capacity      orders
          \          |           /
        CloudEvents-compatible event ledger
                    |
      migration-aware async store port
              /             \
       memory/dev JSON    production DB

External policy/adapters:
identity • credentials • payments • proof verification • compliance
conjunction safety • disputes • insurance • auctions/RFQs
```

The core storage contract is deliberately tiny: `await load()` and `await save(snapshot, { expectedRevision })`. The local JSON adapter uses atomic file replacement and revision checks but remains single-writer; a production database adapter should enforce compare-and-swap transactionally. A lost cross-process race refreshes the in-memory instance from the winning snapshot before returning `STORE_CONFLICT`, so an application can retry against current state.

Persisted schema v2 adds reservation-expiry fields through an explicit v1→v2 migration. Loading old state does not rewrite it; the migrated snapshot becomes durable only through a later successful normal mutation. See [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md).

## Standards strategy

The project uses or targets existing interoperability standards rather than replacing them:

- RFC 8785 canonical JSON for hashing;
- RFC 9457 problem details for API errors;
- RFC 9421 HTTP Message Signatures and RFC 9530 Digest Fields at the production authentication boundary;
- CloudEvents 1.0.2 for portable event envelopes;
- OpenAPI 3.2.0 for the HTTP contract;
- ISO 4217 namespacing for fiat settlement assets;
- CCSDS Orbit Data Messages and Conjunction Data Messages at space-data boundaries;
- W3C DID / Verifiable Credentials as optional identity and credential adapters;
- Agent Skills and `AGENTS.md` for portable agent-facing repository expertise;
- Agentic Resource Discovery (ARD) as the planned web-scale discovery layer once a publisher-controlled domain is available.

See [`docs/STANDARDS.md`](docs/STANDARDS.md) for the versioned rationale, [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the production identity boundary, [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for invariants and trust boundaries, and [`docs/AGENT_DISCOVERY.md`](docs/AGENT_DISCOVERY.md) for agent discoverability.

## Near-term roadmap

1. Production PostgreSQL adapter implementing atomic revision compare-and-swap on the async store port.
2. Signed command envelopes and a verified-command execution pipeline for asynchronous/intermittent links.
3. Portable participant, licensing, asset-control, and insurance credential adapters.
4. Durable reservation-expiry scheduling/reconciliation above the objective kernel transition.
5. Durable settlement/proof orchestration and reconciliation workflows.
6. RFQ/auction matching above the clearing kernel.
7. CCSDS-backed orbit/conjunction policy gate implementations.
8. Hosted ARD publication plus MCP/A2A adapters where actual runtime use cases justify them.
9. External ledger anchoring and receipt export.

The long-term goal is not one marketplace. It is a transaction substrate that many independent space businesses and autonomous agents can compose around.
