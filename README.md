# Space Economy

A small, open **orbital clearinghouse** for coordinating economically useful space assets, scarce service capacity, delivery proofs, and settlement.

The thesis is simple: the space economy will need shared transaction infrastructure before it needs another vertically integrated marketplace. Launch providers, satellite operators, ground networks, tugs, depots, power systems, habitats, observatories, manufacturers, and lunar operators all need a common way to describe assets, sell measurable capacity, reserve it without oversubscription, prove delivery, and settle.

This repository is a zero-dependency Node.js reference implementation of those primitives.

## What exists today

- Asset registry for economically useful physical systems.
- Capacity offers with units, price, currency, availability windows, and remaining inventory.
- Capacity-backed orders that cannot oversubscribe an offer.
- Escrow lifecycle: `reserved -> funded -> delivered -> settled`.
- Domain-agnostic delivery proofs.
- Cancellation before delivery with capacity restoration.
- Append-only SHA-256 hash-chained audit ledger.
- JSON persistence for local development.
- REST API, executable demo, tests, and GitHub Actions CI.

## Why this layer

Most space markets are really markets for scarce physical capability:

- kilograms to a destination orbit;
- minutes of observation time;
- gigabytes relayed;
- kilowatt-hours delivered;
- docking windows;
- maneuver delta-v;
- pressurized volume;
- storage, compute, manufacturing, or surface logistics.

If those capabilities can share a minimal contract and settlement model, higher-level products can interoperate instead of rebuilding bilateral coordination from scratch.

## Run it

Requires Node.js 20+.

```bash
npm test
npm run demo
npm start
```

The API listens on `http://localhost:8787` by default and persists state to `./data/state.json`.

Environment variables:

```bash
PORT=8787
STATE_PATH=./data/state.json
```

## API

```text
GET  /health
GET  /assets
POST /assets
GET  /offers?service=data-relay
POST /offers
POST /orders
GET  /orders/:id
POST /orders/:id/fund
POST /orders/:id/deliver
POST /orders/:id/settle
POST /orders/:id/cancel
GET  /ledger
```

### Example asset

```json
{
  "owner": "relay-one",
  "name": "Relay One A",
  "type": "communications-satellite",
  "capabilities": ["data-relay"],
  "location": { "orbit": "LEO" }
}
```

### Example offer

```json
{
  "assetId": "<asset-id>",
  "seller": "relay-one",
  "service": "data-relay",
  "unit": "GB",
  "pricePerUnit": 15,
  "currency": "USD",
  "capacity": 500
}
```

### Example order lifecycle

```bash
# reserve capacity
curl -X POST http://localhost:8787/orders \
  -H 'content-type: application/json' \
  -d '{"offerId":"<offer-id>","buyer":"lunar-mapper","quantity":20}'

# fund the exact contract value
curl -X POST http://localhost:8787/orders/<order-id>/fund \
  -H 'content-type: application/json' \
  -d '{"buyer":"lunar-mapper","amount":300}'

# seller records a service-specific proof
curl -X POST http://localhost:8787/orders/<order-id>/deliver \
  -H 'content-type: application/json' \
  -d '{"seller":"relay-one","proof":{"receipt":"telemetry-receipt-001","deliveredQuantity":20}}'

# buyer approves settlement
curl -X POST http://localhost:8787/orders/<order-id>/settle \
  -H 'content-type: application/json' \
  -d '{"buyer":"lunar-mapper"}'
```

## Architecture

```text
participants / applications
          |
          v
      REST API
          |
          v
  Clearinghouse kernel
   /      |       \
registry market  settlement
   \      |       /
    hash-chained ledger
          |
          v
   JSON state adapter
```

The kernel deliberately does **not** custody real funds or decide what constitutes a valid telemetry proof. Those should be adapters with explicit trust, regulatory, and domain boundaries.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the protocol model and extension path.

## Roadmap

The next useful layers are participant/asset cryptographic identity, signed orders, telemetry proof verifiers, real payment adapters, reservation expiry, auctions/RFQs, dispute windows, insurance hooks, and orbital-safety/regulatory policy gates.

The goal is not to predict every future space business. It is to make their transactions composable.
