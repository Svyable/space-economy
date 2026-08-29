# RFQ market

`RfqMarket` adds a buyer-demand side to the space-economy clearinghouse without moving procurement intent into the transaction kernel.

The core clearinghouse answers:

> What capacity exists, can it be reserved now, and what economic state transition is valid?

The RFQ market answers:

> What capability does a buyer want, and which existing seller offers are willing and able to satisfy it?

Those are related but different responsibilities.

## Package entry point

```text
space-economy-clearinghouse/rfq-market
```

```js
import { Clearinghouse } from 'space-economy-clearinghouse';
import { RfqMarket } from 'space-economy-clearinghouse/rfq-market';

const market = await Clearinghouse.open();
const rfqs = await RfqMarket.open({ market });
```

The RFQ book reuses the same snapshot-store contract as the clearinghouse. For durable deployments, inject a transactional store or use a separate `PostgresSnapshotStore` key. Do not make the RFQ book and clearinghouse share the same store key.

## Why RFQs are above the kernel

Posted offers are seller-led supply discovery. Many real procurement flows begin in the opposite direction: a buyer describes a need and asks providers to respond.

An RFQ is therefore **pre-trade intent**, not authoritative reserved capacity.

Keeping it above the kernel preserves several important boundaries:

- an RFQ does not reserve anything;
- a quote does not reserve anything;
- quotes cannot invent capacity that is absent from the clearinghouse;
- accepting a quote converts through the existing `Clearinghouse.createOrder()` path;
- the clearinghouse remains the only authority that decrements offer capacity;
- funding, delivery, settlement, expiry, and audit semantics remain unchanged.

## RFQ shape

A buyer creates an RFQ with:

```text
service
unit
quantity
expiresAt
```

and may additionally constrain:

```text
settlementAsset
maxUnitPrice
requiredCapabilities[]
serviceWindowStart + serviceWindowEnd
metadata
```

`maxUnitPrice` uses the same exact decimal representation as the clearinghouse:

```json
{
  "settlementAsset": "iso4217:USD",
  "amount": "25",
  "scale": 2
}
```

Comparisons are performed with integer arithmetic across decimal scales. Floating-point money is never introduced.

RFQ service windows are requirements, not reservations. A responding offer must cover the entire requested interval when the RFQ specifies one.

## Quote shape

A seller submits a quote by referencing an existing clearinghouse `offerId`.

The RFQ layer validates a stable clearinghouse read revision and requires:

- the seller owns the referenced offer;
- buyer and seller are different participants;
- offer service matches the RFQ service;
- offer unit matches the RFQ unit;
- current remaining capacity can cover the full RFQ quantity;
- the producing asset satisfies every required capability;
- the offer settlement asset matches when constrained;
- the offer unit price does not exceed the exact RFQ ceiling when constrained;
- the offer service window covers the requested service window when constrained.

V1 quotes always bind the full RFQ quantity and the referenced offer's existing unit price.

That is intentional. Supporting a quote-specific price while still referencing a shared offer would require a kernel-level commercial-term commitment primitive. V1 does not create a shadow price that the clearinghouse cannot enforce.

A quote records:

```text
rfqId
offerId
assetId
sellerId
quantity
unitPrice
total
offerVersionAtQuote
validUntil
status
```

`offerVersionAtQuote` is evidence of the market state observed when the quote was produced. Acceptance does **not** require that exact offer version because unrelated reservations may advance an offer version while leaving enough capacity for the quote.

## Quote acceptance

Accepting a quote is a recoverable three-stage saga:

```text
1. claim RFQ/quote in RFQ store
2. create authoritative clearinghouse order
3. finalize RFQ award
```

### 1. Claim

The RFQ book persists:

```text
RFQ:   open -> accepting
Quote: active -> accepting
```

and records the selected quote ID.

A different quote cannot claim the same RFQ after that state is committed.

### 2. Reserve through the clearinghouse

The RFQ book calls:

```js
market.createOrder({ offerId, quantity }, {
  actorId: buyerId,
  idempotencyKey: 'rfq-accept:<sha256>'
});
```

The idempotency key is deterministically derived from `{ rfqId, quoteId }`.

The clearinghouse rechecks the current offer status, remaining capacity, service-window expiry, buyer/seller distinction, reservation TTL, and all normal order invariants.

The quote is a candidate commitment—not permission to bypass the kernel.

### 3. Finalize

After an order is returned, the RFQ book persists:

```text
RFQ:   accepting -> awarded
Quote: accepting -> accepted
```

and records the clearinghouse `orderId` on both resources.

Other still-active quotes for the RFQ become `closed` with reason `not-selected`.

## Why acceptance is a saga instead of one transaction

The RFQ store and clearinghouse store may be different databases, tables, services, or operators.

The library deliberately does not claim they share ACID.

If the process fails after the clearinghouse order commits but before RFQ finalization, the RFQ remains `accepting`. Retrying the same quote calls `createOrder()` with the same deterministic idempotency key, receives the already-committed order, and can finish finalization without reserving capacity twice.

If clearinghouse persistence fails before the order commits, the RFQ claim remains recoverable and the same acceptance may be retried.

This is the same pattern a production workflow engine can later externalize without changing the economic transition.

## Capacity disappearing before award

A quote is not a reservation.

Another buyer may consume the referenced offer between quote submission and acceptance.

If the clearinghouse rejects acceptance because the offer is gone, closed, outside its window, or lacks capacity, the RFQ book records:

```text
Quote: unavailable
RFQ:   open
```

The buyer can then choose another quote or wait for additional supply.

This prevents stale procurement intent from becoming a false capacity commitment.

## Expiry

RFQs and quotes have explicit deadlines.

Expiry is derived on reads and enforced on mutations; it does not require a timer inside the library.

A raw persisted RFQ may still have `status: open` after its deadline, while public reads expose it as `expired`. The same applies to an active quote after `validUntil`.

This keeps the reference implementation deterministic and avoids hidden background work. A future indexed RFQ projection or cleanup worker may materialize expiry operationally without changing acceptance validity rules.

## Idempotency and concurrency

Ordinary RFQ mutations support the same `context.idempotencyKey` pattern as the clearinghouse.

The RFQ snapshot store uses revision compare-and-swap. Production adapters should enforce that CAS atomically.

The acceptance path additionally has semantic idempotency through its selected quote and deterministic clearinghouse order key.

For multi-process deployments, a transactional store is required if operators expect competing writers.

## Persistence

The RFQ book snapshot schema is independent from the clearinghouse schema:

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "rfqs": [],
  "quotes": [],
  "idempotency": []
}
```

This lets procurement intent evolve without forcing every RFQ field into the economic kernel's persisted state or migration history.

## What v1 deliberately does not do

The RFQ market does not yet provide:

- quote-specific prices different from the referenced offer;
- partial-quantity awards;
- multi-round negotiation;
- sealed bids;
- automatic ranking or winner selection;
- auctions;
- multi-offer atomic bundles;
- buyer credit checks;
- seller reputation scoring;
- regulatory or mission-safety approval;
- payment escrow.

Those should be added as explicit protocols rather than inferred from metadata.

## Natural next extensions

The cleanest next layers are:

1. **commercial-term commitments** — a kernel-enforceable quote/option price independent of public offer price;
2. **partial and multi-award RFQs** — satisfy one demand from multiple providers without oversubscription;
3. **atomic service bundles** — reserve launch, transport, relay, ground, storage, or servicing legs without orphan partial bookings;
4. **RFQ indexing / agent discovery** — bounded PostgreSQL demand search using the same projection pattern as capacity discovery;
5. **signed RFQ operations** — expose buyer/seller mutations through the existing verified command boundary;
6. **procurement evidence** — attributable award records and policy decisions without pretending they are payment or regulatory proof.

The clearinghouse should remain neutral underneath all of them.
