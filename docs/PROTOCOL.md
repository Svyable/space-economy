# Clearinghouse Protocol v0.1

The clearinghouse defines a narrow transaction kernel for markets in scarce physical capability: launch mass, relay bandwidth, observation time, power, docking windows, logistics, compute, storage, manufacturing, and other measurable services.

The protocol is intentionally smaller than a marketplace. Discovery, auctions, compliance, custody, telemetry interpretation, insurance, disputes, and mission-safety policy belong around the kernel as independently replaceable modules.

## Core invariants

1. **Capacity is conserved.** An offer's `remaining` quantity is never negative or greater than its published `capacity`.
2. **Billable quantities are integral quanta.** Sellers choose the smallest practical `unit` (for example gram, second, MB, Wh) and capacities/orders are positive safe integers. This avoids floating-point inventory drift.
3. **Money is exact.** Prices use `{ settlementAsset, amount, scale }`, where `amount` is an unsigned integer string. `iso4217:USD` with `amount: "1250"` and `scale: 2` means USD 12.50. Totals are calculated with integer arithmetic.
4. **Actor identity is transport context, not payload.** Buyer, seller, and owner identities are derived from the authenticated actor context supplied to the kernel. The demo HTTP adapter uses `x-participant-id` only as a local-development stand-in.
5. **Mutations are retry-safe.** An idempotency key can be persisted with a command result. Replaying the same command returns the original result; reusing a key with different input fails.
6. **Mutable resources are versioned.** Offers and orders carry monotonically increasing `version` values for optimistic concurrency checks.
7. **Persistence is transactional from the kernel's point of view.** If persistence fails, in-memory mutation is rolled back. Stores receive the expected prior revision so production adapters can implement compare-and-swap semantics.
8. **Funded reservations are not silently cancelled.** Releasing funded capacity requires a refund/dispute rail; the v0.1 kernel refuses that transition rather than creating inconsistent financial state.
9. **Proofs are recorded, not magically trusted.** Delivery proofs are hashed and marked `unverified` until a future service-specific verifier attests them.
10. **Every successful mutation emits a tamper-evident event.** Events use a CloudEvents-compatible envelope and an RFC 8785-canonicalized SHA-256 hash chain.

## Core objects

### Asset

Represents an economically useful physical system: launch vehicle, satellite, ground station, tug, habitat, power system, telescope, depot, rover, manufacturing node, or other service-producing infrastructure.

Asset identifiers are namespaced rather than hard-coded. Examples:

```json
[
  { "scheme": "cospar", "value": "2026-001A" },
  { "scheme": "norad-cat-id", "value": "99999" },
  { "scheme": "operator", "value": "relay-one:a" }
]
```

The protocol does not treat a catalog identifier as proof of ownership or control.

### Offer

Publishes measurable capacity from one asset.

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

`service` and `unit` are extensible identifiers. Domain profiles may later define controlled vocabularies without changing the clearinghouse kernel.

### Order

Reserves quantity against exactly one offer.

Lifecycle:

`reserved -> funded -> delivered -> settled`

`settled` in v0.1 means the clearinghouse has recorded a settlement reference approved by the buyer. It does **not** prove that this reference moved real funds unless the deployment's settlement adapter provides that guarantee.

### Delivery proof

A proof has a `type` plus arbitrary JSON `data`. The kernel stores a canonical SHA-256 digest and verification state.

```json
{
  "type": "telemetry-receipt",
  "data": {
    "receipt": "telemetry-receipt-001",
    "deliveredQuantity": 20000
  }
}
```

Future verifier adapters should transform `verification.status` from `unverified` to a domain-specific attestation before automated settlement policies rely on it.

### Ledger event

Each successful mutation emits a CloudEvents-compatible structured event with:

- `specversion`, `id`, `source`, `type`, `subject`, `time`, `datacontenttype`, and `data`;
- `sequence` and `previoushash` extension attributes;
- `hash`, computed over the event without the `hash` field using RFC 8785-compatible canonical JSON and SHA-256.

The chain is tamper-evident, not a decentralized consensus mechanism.

## API behavior

The HTTP reference adapter uses `/v1` paths and RFC 9457 problem details.

Mutating requests should send:

- `x-participant-id`: development-only actor adapter;
- `Idempotency-Key`: stable retry key for a logical command;
- `If-Match`: optional numeric resource version for optimistic concurrency on existing resources.

The contract is defined in [`openapi.yaml`](../openapi.yaml).

## Storage port

The kernel accepts a snapshot store with two operations:

```text
load() -> snapshot | null
save(snapshot, { expectedRevision })
```

`MemorySnapshotStore` and `JsonFileSnapshotStore` are reference adapters. The JSON adapter is single-writer local infrastructure; production deployments should use a transactional database adapter that enforces the expected revision atomically.

Persisted state includes a `schemaVersion` and refuses unknown versions instead of guessing how to interpret future data.

## Trust boundaries deliberately outside v0.1

- authentication and key custody;
- KYB/KYC, sanctions, export controls, licensing, and jurisdiction policy;
- cryptographic participant/asset credentials;
- proof verification and telemetry trust;
- actual escrow/custody/payment execution;
- refunds, chargebacks, disputes, and insurance;
- conjunction assessment and mission-safety policy;
- auctions, RFQs, derivatives, and multi-leg contracts.

These should be adapters or higher-level protocols, not hidden assumptions inside capacity accounting.
