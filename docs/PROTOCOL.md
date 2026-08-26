# Clearinghouse Protocol v0.1

The clearinghouse is intentionally small. It defines primitives that can sit underneath launch, communications, sensing, compute, docking, power, logistics, and eventually in-situ resource markets.

## Design principles

1. **Physical capacity is scarce.** Offers reserve measurable capacity and cannot be oversubscribed.
2. **Settlement follows delivery.** Funds move into escrow before service and are released after a delivery proof is accepted.
3. **Assets are first-class.** Every offer is anchored to a registered physical or orbital asset with an accountable owner.
4. **Proofs are protocol data.** Delivery proofs are opaque JSON at v0.1 so each market can evolve domain-specific verification independently.
5. **Auditability is built in.** Mutations append to a SHA-256 hash chain, creating tamper-evident receipts without requiring a blockchain.
6. **Money rails are pluggable.** `currency` is an identifier, not a payment implementation. Fiat, stablecoin, credits, or bilateral settlement can be integrated behind the escrow boundary.

## Core objects

### Asset

Represents an economically useful physical system: launch vehicle, satellite, ground station, tug, habitat, power plant, telescope, depot, rover, or manufacturing node.

Required fields: `owner`, `name`, `type`.

### Offer

Publishes sellable capacity from an asset. Examples include kilograms to orbit, GB relayed, kWh delivered, minutes of observation time, cubic meters of pressurized volume, or docking slots.

Required fields: `assetId`, `seller`, `service`, `unit`, `pricePerUnit`, `currency`, `capacity`.

### Order

Reserves a quantity from an offer. State progression:

`reserved -> funded -> delivered -> settled`

Orders may be cancelled while `reserved` or `funded`, returning capacity to the offer.

### Delivery proof

A domain-specific JSON object recorded by the seller. In production, proof verification should be delegated to service-specific verifiers (signed telemetry receipts, custody-transfer records, ranging data, ground-station logs, trusted oracles, etc.).

### Ledger entry

Each mutation emits an event with `sequence`, `timestamp`, `previousHash`, and `hash`. This provides local tamper evidence and a clean bridge to external transparency logs or distributed ledgers if required later.

## API surface

- `GET /health`
- `GET|POST /assets`
- `GET|POST /offers`
- `POST /orders`
- `GET /orders/:id`
- `POST /orders/:id/fund`
- `POST /orders/:id/deliver`
- `POST /orders/:id/settle`
- `POST /orders/:id/cancel`
- `GET /ledger`

## What v0.1 deliberately does not do

Authentication, KYC/KYB, sanctions screening, legal contract generation, custody of real funds, cryptographic asset identity, telemetry verification, dispute resolution, multi-currency conversion, auctions, derivatives, and orbital-safety rules are intentionally outside this first slice.

Those belong in separate modules around the narrow coordination kernel rather than being hard-coded into it.

## Suggested next protocol modules

1. DID/public-key based participant and asset identity.
2. Signed offer/order envelopes for offline and cross-network operation.
3. Verifier interface for telemetry-backed delivery proofs.
4. Payment adapter interface for ACH/wire/stablecoin/internal credits.
5. Time-bounded reservations and automatic expiry.
6. Auction and RFQ market mechanisms.
7. Insurance hooks and dispute windows.
8. Orbital conjunction / regulatory policy gates before reservation.
