# Multi-award procurement

`MultiAwardProcurementCoordinator` lets a buyer source one requirement from several providers without changing the single-award semantics of `RfqMarket` or duplicating clearinghouse capacity state.

## Why lots first

The first RFQ protocol deliberately makes one RFQ single-award. Retrofitting arbitrary partial quotes into that state machine would introduce new quote quantities, pending-award accounting, cancellation semantics, and cross-instance over-award races all at once.

V1 multi-award procurement takes the safer procurement pattern: the buyer partitions the requirement into explicit lots before sellers quote.

Example:

```text
60 MB demand
  -> primary lot   30 MB
  -> secondary lot 20 MB
  -> reserve lot   10 MB
```

Each lot becomes an ordinary RFQ with the same service/capability/window/price constraints. Different sellers can win different lots.

The maximum possible awarded quantity is therefore structurally bounded by the lot partition:

```text
sum(lot quantities) == totalQuantity
```

No mutable shared `remainingAwardQuantity` counter is required.

## State ownership

Three persistence domains remain explicit:

```text
procurement program store
  owns: partition plan + child RFQ ids

RFQ market
  owns: child RFQs + quotes + single-lot awards

clearinghouse
  owns: capacity reservations/orders
```

The procurement coordinator does not copy accepted orders or quote state into its own authoritative store. Program award totals are derived from child RFQs under one stable RFQ-book revision.

## Public module

```js
import { MultiAwardProcurementCoordinator } from 'space-economy-clearinghouse/multi-award-procurement';
```

The coordinator accepts an existing `RfqMarket`-compatible instance:

```js
const procurement = await MultiAwardProcurementCoordinator.open({ rfqMarket });
```

A file or custom snapshot store may be supplied through the same `load()` / `save(snapshot, { expectedRevision })` contract used by other orchestration modules.

## Create a program

```js
const program = await procurement.createProgram({
  name: 'Resilient relay procurement',
  service: 'data-relay',
  unit: 'MB',
  settlementAsset: 'iso4217:USD',
  maxUnitPrice: {
    settlementAsset: 'iso4217:USD',
    amount: '30',
    scale: 2,
  },
  requiredCapabilities: ['data-relay'],
  serviceWindowStart: '2026-09-02T06:00:00Z',
  serviceWindowEnd: '2026-09-02T12:00:00Z',
  expiresAt: '2026-09-01T01:00:00Z',
  lots: [
    { lotId: 'primary', quantity: 30 },
    { lotId: 'secondary', quantity: 20 },
    { lotId: 'reserve', quantity: 10 },
  ],
}, {
  actorId: 'buyer-a',
  idempotencyKey: 'relay-procurement-1',
});
```

At least two lots are required and at most 32 are allowed. Lot IDs must be unique and every quantity is a positive safe integer.

The sum is checked with integer arithmetic and must remain inside the JavaScript safe-integer domain used by clearinghouse quantities.

## Open child RFQs

Creating a program does not publish buyer demand yet.

The buyer explicitly opens it:

```js
const opened = await procurement.openProgram(program.id, {
  actorId: 'buyer-a',
});
```

For every lot, the coordinator creates one ordinary child RFQ carrying the common program constraints and the lot quantity.

Child RFQ metadata includes:

```text
procurementProgramId
procurementLotId
procurementLotMetadata
```

### Crash/retry behavior

Opening is a recoverable cross-store saga.

Every child RFQ uses a deterministic idempotency key derived from:

```text
program id + lot id + open-rfq action
```

If an RFQ commits but the coordinator loses the response or fails before persisting its child ID, retrying `openProgram()` replays the same RFQ rather than publishing duplicate demand.

The coordinator persists progress after each lot. A temporary failure on lot 2 does not recreate lot 1 on retry.

The program deadline is checked before creating new child RFQs. An expired program cannot publish additional demand.

## Seller competition

Sellers interact with each child RFQ through the ordinary RFQ protocol:

```js
const quote = await rfqMarket.submitQuote(
  opened.lots[0].rfqId,
  { offerId },
  { actorId: 'seller-a' },
);
```

All existing RFQ constraints remain authoritative:

- seller ownership of the referenced offer;
- buyer/seller separation;
- service and unit compatibility;
- sufficient real remaining capacity;
- required asset capabilities;
- settlement-asset compatibility;
- exact decimal maximum price;
- requested service-window coverage;
- RFQ and quote deadlines.

No procurement-program code weakens those checks.

## Award a lot

The buyer may award a quote only through the lot it belongs to:

```js
const result = await procurement.acceptLotQuote(
  program.id,
  'primary',
  quote.id,
  { actorId: 'buyer-a' },
);
```

The coordinator verifies that the quote belongs to that lot's child RFQ and delegates acceptance to `RfqMarket.acceptQuote()`.

The RFQ market then performs its existing recoverable:

```text
claim quote -> create clearinghouse order -> finalize award
```

saga with deterministic clearinghouse idempotency.

The procurement coordinator does not reserve capacity itself.

## Program view

`getProgram()` returns derived award state under one stable RFQ revision:

```text
awardStatus: none | partial | complete
awardedQuantity
remainingQuantity
rfqRevision
```

Each lot includes its child RFQ and, when awarded, attributable award details:

```text
quoteId
sellerId
offerId
orderId
unitPrice
total
```

Program `status` is derived as:

- `planned` before opening starts;
- `opening` while child creation is incomplete;
- `open` while live unawarded lots remain;
- `awarded` when every lot has an award;
- `expired` when the common RFQ deadline passes before complete award.

`awardStatus` remains independent, so an expired program can still truthfully show that some lots were already awarded.

## What this protocol guarantees

- Total possible award quantity cannot exceed the buyer-declared program total.
- Every lot is an ordinary RFQ; every award is an ordinary RFQ acceptance.
- Every awarded lot produces an ordinary clearinghouse order.
- RFQ and clearinghouse idempotency remain authoritative.
- Program creation is durably idempotent.
- Child RFQ creation is deterministic and restart-safe.
- Program read state is assembled from one stable RFQ-book revision.
- A quote from one lot cannot be accepted through another lot.
- No provider ranking or automatic award logic is introduced.

## Intentional v1 limits

This is **lot-based multi-award**, not arbitrary partial-quote allocation inside one RFQ.

V1 does not provide:

- seller-selected arbitrary quote quantities;
- a minimum/maximum award quantity inside one RFQ;
- distinct-provider requirements;
- per-seller award caps;
- combinatorial auctions;
- optimization across lots;
- quote-specific negotiated prices beyond the existing RFQ model;
- automatic lot cancellation after a partial procurement decision;
- one distributed transaction spanning program, RFQ, and clearinghouse stores.

Those features should be added only with explicit race, cancellation, and recovery semantics.

## Why this boundary is useful

Buyer-defined lots already cover important real procurement patterns:

- primary and backup providers;
- geographic/orbital diversity;
- phased deliveries;
- capacity diversification;
- multiple launch or logistics providers;
- splitting one communications/observation requirement across independent operators.

It creates multi-provider sourcing value immediately while leaving the proven single-RFQ protocol backwards compatible.
