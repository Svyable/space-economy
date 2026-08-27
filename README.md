# Space Economy

Open infrastructure for coordinating **assets, scarce physical capacity, delivery evidence, and settlement records** across the space economy.

The thesis: launch, communications, sensing, power, docking, logistics, compute, manufacturing, and surface operations should not each reinvent bilateral booking and settlement. They need a small common transaction kernel that can sit underneath many market designs.

This repository is a zero-runtime-dependency Node.js reference implementation of that kernel.

## What the kernel does

- Registers economically useful physical assets with extensible external identifiers.
- Publishes measurable service capacity without oversubscription.
- Uses exact integer monetary arithmetic instead of floating-point prices.
- Reserves orders with persisted idempotency for safe retries.
- Tracks resource versions for optimistic concurrency.
- Separates actor identity from request payloads.
- Records funding references, delivery proofs, and settlement references.
- Refuses financially unsafe transitions such as silently cancelling funded capacity.
- Emits CloudEvents-compatible, RFC 8785-canonicalized SHA-256 ledger events.
- Persists schema-versioned snapshots behind an asynchronous replaceable storage port.
- Serializes local mutations and uses revision compare-and-swap for cross-instance races.
- Provides a transactionally CAS-protected PostgreSQL adapter without making a database driver a runtime dependency.
- Exposes a versioned HTTP API with RFC 9457 errors and an OpenAPI 3.2 contract.

## What it deliberately does not pretend to do

The reference server does **not** authenticate participants, custody funds, verify telemetry, prove spacecraft ownership, run conjunction assessment, perform KYC/KYB, or satisfy export-control/licensing requirements. Those are explicit adapter and policy boundaries, not hidden TODOs.

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

`Clearinghouse.open(options)` is the preferred construction path because it loads and validates persisted state before returning. Mutations are serialized within one instance; reads wait for mutations that were already enqueued, so callers do not observe uncommitted in-memory state.

### PostgreSQL persistence

`PostgresSnapshotStore` accepts a standard pool interface instead of importing a driver itself:

```js
import pg from 'pg';
import { Clearinghouse } from './src/clearinghouse.js';
import { PostgresSnapshotStore } from './src/postgres-store.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresSnapshotStore(pool, { storeKey: 'production-market' });
await store.ensureSchema();

const market = await Clearinghouse.open({ store });
```

The adapter uses a PostgreSQL transaction, a per-store advisory lock, row locking, and expected-revision comparison so two application instances cannot both commit from the same revision. See [`docs/POSTGRES.md`](docs/POSTGRES.md) for deployment, DDL, failure, and operational guidance.

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
  "capacity": 500000
}
```

A 20,000 MB order against that offer totals `300000` at scale `2`, i.e. USD 3,000.00, with no floating-point multiplication.

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
          async snapshot store port
              /             \
       memory/dev JSON     PostgreSQL

External policy/adapters:
identity • credentials • payments • proof verification • compliance
conjunction safety • disputes • insurance • auctions/RFQs
```

The core storage contract is deliberately tiny: `await load()` and `await save(snapshot, { expectedRevision })`. The local JSON adapter uses atomic file replacement and revision checks but remains single-writer. `PostgresSnapshotStore` moves the same contract into a real transaction with cross-process locking and revision CAS. A lost race refreshes the clearinghouse instance from the winning snapshot before returning `STORE_CONFLICT`, so an application can retry against current state.

## Standards strategy

The project uses or targets existing interoperability standards rather than replacing them:

- RFC 8785 canonical JSON for hashing;
- RFC 9457 problem details for API errors;
- RFC 9421 HTTP Message Signatures and RFC 9530 Digest Fields at the production authentication boundary;
- CloudEvents 1.0.2 for portable event envelopes;
- OpenAPI 3.2.0 for the HTTP contract;
- ISO 4217 namespacing for fiat settlement assets;
- CCSDS Orbit Data Messages and Conjunction Data Messages at space-data boundaries;
- W3C DID / Verifiable Credentials as optional identity and credential adapters.

See [`docs/STANDARDS.md`](docs/STANDARDS.md) for the versioned rationale, [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the production identity boundary, and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for invariants and trust boundaries.

## Near-term roadmap

1. Database deployment hardening: migration rollout, backup/restore drills, observability, and read-model projections.
2. Production authentication adapters and signed-request profiles.
3. Verifiable participant and asset-control credentials.
4. Service-specific delivery-proof verifier interface.
5. Settlement/custody adapters with refunds and disputes.
6. Reservation expiry and time-window policy.
7. RFQ/auction matching above the clearing kernel.
8. CCSDS-backed orbit/conjunction policy gates.
9. External ledger anchoring and receipt export.

The long-term goal is not one marketplace. It is a transaction substrate that many independent space businesses can compose around.