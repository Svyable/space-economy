# RFQ commercial term integration

The RFQ market can reference clearinghouse-native commercial commitments so negotiated procurement terms become executable without making RFQ metadata a second source of economic truth.

## Two quote modes

`RfqMarket.submitQuote()` supports two pricing sources.

### Public-offer quote

With only `offerId`, behavior is unchanged:

- the quote snapshots the current public `offer.unitPrice`;
- RFQ settlement-asset and maximum-price constraints are evaluated against the public price;
- acceptance calls `Clearinghouse.createOrder()`;
- the resulting order is an ordinary public-offer reservation.

### Commercial-commitment quote

A seller may additionally provide `commercialCommitmentId`.

The commitment remains authoritative for its negotiated economic terms. The RFQ book verifies that the reference is compatible with the RFQ and then snapshots:

- `commercialCommitmentId`;
- immutable `commercialTermsHash`;
- `pricingSource: "commercial-commitment"`;
- committed `unitPrice` and derived total.

Acceptance calls `Clearinghouse.exerciseCommercialCommitment()` instead of manufacturing custom order pricing itself.

## Validation boundary

At quote submission, the RFQ book reads the authoritative offer/asset and the seller-visible commercial commitment and requires:

- the commitment is active;
- `offerId` matches the quoted offer;
- `assetId` matches the authoritative offer asset;
- the authenticated seller owns both offer and commitment;
- the commitment is designated for the RFQ buyer;
- service and unit match the RFQ;
- commitment quantity equals the single-award RFQ quantity;
- `termsHash` has the expected canonical SHA-256 form;
- current offer capacity is sufficient;
- required asset capabilities are satisfied;
- requested service window fits the offer window;
- committed settlement asset satisfies the RFQ;
- committed unit price is at or below the RFQ maximum using exact decimal comparison.

The public listing price may be above the RFQ ceiling or use a different settlement asset. That does not matter when a valid bilateral commitment authorizes compliant terms. The public offer itself is not mutated.

## Quote lifetime

A commitment-backed quote may never outlive its authority.

If no explicit `validUntil` is supplied, the quote expires at the earlier of:

- RFQ expiry; or
- commercial commitment expiry.

A caller cannot set `validUntil` after either deadline.

This means an already-expired commitment does not remain discoverable as an apparently executable quote.

## Acceptance saga

RFQ state and clearinghouse state remain separate persistence boundaries.

Acceptance keeps the existing recoverable sequence:

1. claim the RFQ/quote in the RFQ store;
2. create the clearinghouse reservation;
3. finalize the RFQ award.

For a public quote, step 2 calls `createOrder()`.

For a commitment-backed quote, step 2 calls `exerciseCommercialCommitment()` using a deterministic RFQ acceptance idempotency key.

The clearinghouse remains responsible for:

- rechecking current commitment state;
- rechecking current offer capacity and service-window end;
- decrementing capacity exactly once;
- materializing the negotiated price into the order;
- preserving the commitment ID and terms hash in order/ledger evidence.

The RFQ book does not pre-reserve capacity and does not claim cross-store ACID.

## Failure semantics

If the clearinghouse reports that quoted commercial authority is no longer executable—for example because terms were revoked or capacity disappeared—the quote becomes `unavailable` and the RFQ reopens.

Transient clearinghouse store conflicts are not converted into quote invalidation. The acceptance claim remains recoverable so a retry can reconcile rather than incorrectly declaring valid terms dead.

## Idempotency

The RFQ acceptance idempotency key is derived from `{rfqId, quoteId}` and is reused for either reservation path.

After an award, replaying `acceptQuote()` returns the existing order. A restart of the RFQ book does not reserve capacity again.

The commercial commitment itself is also one-shot: repeated exercise resolves to the order already linked to the exercised commitment.

## Persisted RFQ compatibility

The RFQ store remains schema version 1 because the new quote fields are additive and nullable.

Historical quotes missing the fields are read as:

```json
{
  "commercialCommitmentId": null,
  "commercialTermsHash": null,
  "pricingSource": "public-offer"
}
```

No persisted RFQ rewrite is required.

## Multi-award composition

`MultiAwardProcurementCoordinator` needs no negotiated-pricing branch.

Each lot is already an ordinary single-award RFQ. A seller can issue a buyer-specific commercial commitment for a lot quantity, submit it to that child RFQ, and the coordinator delegates award to `RfqMarket.acceptQuote()`.

This preserves one pricing authority and one capacity authority while allowing different lots to clear at different bilateral prices.

## Intentional limits

This integration does not add:

- bargaining algorithms;
- automatic bid generation;
- capacity holds or options;
- transferable rights;
- RFQ HTTP routes;
- MCP write tools;
- payment custody;
- derivatives or secondary-market settlement.

A commercial commitment is still non-reserving. If inventory must be guaranteed before exercise, that must be modeled as a distinct capacity-right/hold primitive that actually moves physical availability when the right is created.
