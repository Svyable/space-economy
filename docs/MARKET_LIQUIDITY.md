# Market liquidity evidence

`MarketLiquidityDirectory` provides a revision-stable snapshot of current open clearinghouse supply and open RFQ demand.

It is designed for agents, operators, and marketplaces that need to answer questions such as:

- where is current open supply thin or abundant?
- which service/unit markets show demand without corresponding posted capacity?
- how much currently open RFQ demand is constrained to a settlement asset?
- how much buyer demand remains settlement-asset agnostic?
- what public offer price range and RFQ price-ceiling range are visible right now?

The module is evidence, not a matching engine or price oracle.

## Contract

```js
import { MarketLiquidityDirectory } from 'space-economy-clearinghouse/market-liquidity';

const directory = new MarketLiquidityDirectory({ market, rfqMarket });
const snapshot = await directory.snapshot({
  service: 'data-relay',
  settlementAsset: 'iso4217:USD',
  limit: 100,
});
```

The top-level response includes:

- `marketRevision`
- `rfqRevision`
- `generatedAt`
- `totalMarkets`
- `hasMore`
- `markets[]`
- `unconstrainedDemand[]`

Each settlement-asset market is keyed conceptually by:

```text
service + unit + settlementAsset
```

and contains:

```text
supply.offerCount
supply.remainingQuantity
supply.unitPriceRange

constrainedDemand.rfqCount
constrainedDemand.quantity
constrainedDemand.pricedRfqCount
constrainedDemand.pricedQuantity
constrainedDemand.maxUnitPriceCeilingRange

constrainedBalance
```

Quantities and balances are decimal integer strings so aggregation does not overflow JavaScript safe-integer arithmetic as the market grows.

`constrainedBalance` is:

```text
open remaining supply - settlement-asset-constrained RFQ quantity
```

A positive value means the visible open supply quantity is larger than the visible currency-constrained demand quantity. A negative value means the opposite.

It is not a forecast, utilization ratio, reservation guarantee, or proof that the two sides are otherwise compatible.

## RFQ ceilings are not bids

An RFQ `maxUnitPrice` is a buyer constraint. It is not an executable bid and may never transact.

Therefore this module deliberately does not expose:

- bid/ask spread;
- midpoint;
- fair value;
- executable market price;
- recommended seller price;
- recommended buyer bid;
- liquidity score.

The supply price range is the range of current public offer unit prices.

The demand ceiling range is the range of explicit current RFQ maximum unit prices for that settlement-asset market.

Those are different kinds of evidence and remain labeled separately.

## Exact price comparisons

Price ranges use the existing exact-money representation:

```json
{
  "settlementAsset": "iso4217:USD",
  "amount": "125",
  "scale": 2
}
```

When prices use different decimal scales, comparisons align them with integer arithmetic. No floating-point conversion is introduced.

The selected low/high values retain their original representation.

## Settlement-asset-constrained vs unconstrained demand

An RFQ may constrain its settlement asset, or it may leave settlement open.

Constrained RFQ demand participates in one exact `service + unit + settlementAsset` row.

Asset-neutral RFQ demand is returned separately under `unconstrainedDemand`, keyed only by `service + unit`.

It is not copied into every currency market because doing so would double-count the same demand and create a false impression of market depth.

When a caller filters by one settlement asset, unconstrained demand is still returned separately because it may remain commercially addressable under that asset.

## Demand-only markets

A settlement-asset market can appear even when current supply is zero.

Example:

```json
{
  "service": "orbital-compute",
  "unit": "compute-second",
  "settlementAsset": "iso4217:USD",
  "supply": {
    "offerCount": 0,
    "remainingQuantity": "0",
    "unitPriceRange": null
  },
  "constrainedDemand": {
    "rfqCount": 3,
    "quantity": "1200"
  },
  "constrainedBalance": "-1200"
}
```

That is useful evidence for providers considering where new commercial capacity may be valuable.

It is still not a guarantee of addressable revenue: RFQs may contain capabilities, timing, policy, jurisdiction, or other constraints not represented in this aggregate.

## Cross-store consistency

Supply and RFQ demand are separate persistence domains.

For each read attempt the directory captures:

1. clearinghouse revision;
2. RFQ-book revision;
3. current offers;
4. current open RFQs;
5. both revisions again.

If either source moved, the attempt is discarded and retried.

Repeated churn returns `LIQUIDITY_CHANGED` rather than combining incompatible moments.

The snapshot therefore describes one observed pair of source revisions without pretending the two stores share a distributed transaction.

## Lifecycle filtering

Supply includes only offers whose current status is `open` and whose `remaining` quantity is positive.

Demand includes only RFQs whose public status is `open` and whose expiry has not been reached at `generatedAt`.

Cancelled, awarded, or expired RFQs are not counted.

Filled/closed capacity is not counted as open supply.

## Deterministic ordering and limits

Market rows sort deterministically by:

1. service;
2. unit;
3. settlement asset.

Unconstrained-demand rows sort by service and unit.

`limit` bounds settlement-asset market rows to at most 500. `totalMarkets` reports the full stable-snapshot market count and `hasMore` signals truncation.

## Scaling path

The reference implementation reads the two authoritative stores directly because that is the clearest way to establish semantics.

A production-scale implementation can later serve the same contract from derived indexed supply/demand projections with explicit source revisions and lag metadata.

Those projections must remain rebuildable evidence. They must not become order, offer, or RFQ authority.

## Safe agent usage

A useful agent workflow is:

```text
liquidity snapshot
  -> identify thin / demand-heavy service markets
  -> inspect exact RFQs or capacity
  -> inspect provider and settled-price evidence
  -> apply explicit buyer/seller policy
  -> separately submit a quote or signed reservation intent
```

The aggregate should help an agent decide what to inspect next, not authorize an economic action by itself.
