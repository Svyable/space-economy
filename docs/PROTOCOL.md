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
8. **Commands are serialized per clearinghouse instance.** Once persistence is asynchronous, only one mutation may be in its commit phase at a time. Reads wait for already-enqueued commands so callers never observe state that has not successfully committed.
9. **Cross-instance races converge through compare-and-swap.** A store revision conflict causes the losing instance to refresh from the winning snapshot before returning `STORE_CONFLICT`, allowing a meaningful retry.
10. **Reservation expiry is seller-configured, not globally imposed.** An offer may define `reservationTtlSeconds`. If present, every new order receives an immutable `fundingDueAt`; if absent, the kernel does not invent a TTL.
11. **Expired unpaid reservations release capacity atomically.** At or after `fundingDueAt`, funding is rejected and an authenticated caller may trigger `reserved -> expired`, restoring the reserved quantity in the same persisted mutation.
12. **Service windows stop new reservations once they end.** Advance booking is allowed before and during a configured service window, but no new reservation may be created at or after `windowEnd`.
13. **Funded reservations are not silently cancelled or expired.** Releasing funded capacity requires a refund/dispute rail; the kernel refuses those transitions rather than creating inconsistent financial state.
14. **Proofs are recorded, not magically trusted.** Delivery proofs are hashed and marked `unverified` until a service-specific verifier attests them.
15. **Every successful mutation emits a tamper-evident event.** Events use a CloudEvents-compatible envelope and an RFC 8785-canonicalized SHA-256 hash chain.

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
  "capacity": 500000,
  "reservationTtlSeconds": 300
}
```

`service` and `unit` are extensible identifiers. Domain profiles may later define controlled vocabularies without changing the clearinghouse kernel.

`reservationTtlSeconds` is optional. When null/omitted, unpaid reservations are not automatically bounded by a clearinghouse TTL. Sellers that need bounded holds can configure a positive duration per offer. The selected duration is copied into a concrete order deadline at reservation time so later offer-policy changes cannot retroactively change an existing buyer's funding deadline.

`windowStart` / `windowEnd` describe the service availability window, not a global funding TTL. Advance reservation before `windowStart` is allowed. Once `windowEnd` has been reached, the offer cannot accept another reservation.

### Order

Reserves quantity against exactly one offer.

Primary lifecycle:

`reserved -> funded -> delivered -> settled`

Unfunded terminal alternatives:

`reserved -> cancelled`

`reserved -> expired` (only when the offer created a `fundingDueAt` deadline and that deadline has been reached)

At exactly `fundingDueAt`, the reservation is no longer fundable. Expiry may then be triggered by any authenticated actor because the condition is objective; authorization does not depend on the caller being buyer or seller. The transition records who triggered it for auditability and atomically returns capacity to the offer.

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

The expiry transition is exposed as `POST /v1/orders/{orderId}/expire`. Deployments may call it from an event-driven scheduler, durable workflow engine, or other authenticated process after the materialized funding deadline.

The contract is defined in [`openapi.yaml`](../openapi.yaml).

## Storage port

The kernel accepts an asynchronous snapshot store with two operations:

```text
await load() -> snapshot | null
await save(snapshot, { expectedRevision })
```

`MemorySnapshotStore` and `JsonFileSnapshotStore` are reference adapters. The JSON adapter is single-writer local infrastructure; production deployments should use a transactional database adapter that enforces the expected revision atomically in the same transaction as the snapshot write.

The public clearinghouse API is therefore asynchronous. `Clearinghouse.open(options)` eagerly loads and validates persisted state and is the preferred construction path for services. Commands and reads return promises even when backed by the in-memory adapter so switching to a networked database does not change the domain API.

Within one clearinghouse process, commands are queued in invocation order. A read waits for commands that were already enqueued when the read reached the kernel. If a save fails, the mutation is rolled back before queued reads proceed. If compare-and-swap fails because another process committed first, the instance reloads the winning snapshot before surfacing `STORE_CONFLICT`.

Persisted state uses schema version 2 for reservation-expiry fields. `Clearinghouse.open()` wraps the configured store in the migration layer: v1 snapshots receive `reservationTtlSeconds: null` on offers and `fundingDueAt: null` / `expiration: null` on orders in memory. Historical ledger events are not rewritten. The migrated v2 snapshot becomes durable only through the next successful normal CAS-backed mutation.

See [`MIGRATIONS.md`](MIGRATIONS.md) for migration and rollback policy.

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
