# Transparent procurement evaluation

Capacity discovery, provider history, and settled market-price evidence become much more useful when an agent can combine them into an explicit procurement decision.

`TransparentProcurementEvaluator` provides that decision-support layer without making the protocol a universal ranking authority.

It is pure and side-effect free. It never reserves capacity, accepts an RFQ, signs a command, or mutates clearinghouse state.

## Core rule: the buyer owns the policy

The evaluator does not publish a hidden score or model weights.

A caller provides explicit hard gates and an ordered list of tie-breaking preferences. The returned result contains the normalized policy, every rejection reason, and the evidence used for each eligible candidate.

That makes a procurement decision reproducible and reviewable.

## Market scope

One evaluation compares offers in one market:

```json
{
  "service": "data-relay",
  "unit": "MB",
  "settlementAsset": "iso4217:USD"
}
```

Candidates with a mismatched service, unit, or settlement asset fail validation instead of being silently compared.

## Hard gates

A buyer policy may set:

- `maxUnitPrice` — exact monetary ceiling;
- `minProviderOrders` — minimum observed history depth;
- `minSettledOutcomeBasisPoints` — minimum `settled / terminal` outcome ratio;
- `maxAverageDeliveryMs` — maximum observed average delivery latency;
- `maxPremiumOverMedianBasisPoints` — maximum offer premium over an exact settled-market median.

The evaluator always also rejects:

- offers that are not `open`;
- offers whose current `remaining` capacity is below requested quantity.

These reads are decision evidence only. A later reservation must still recheck authoritative capacity and versioning inside the clearinghouse.

## Exact price comparisons

`maxUnitPrice` comparisons align decimal scales using integer arithmetic.

When comparing an offer against `MarketPriceHistoryDirectory`'s rational median, the evaluator keeps the comparison exact:

```text
offer <= median × (1 + premiumBasisPoints / 10,000)
```

The calculation is performed by cross-multiplying integers, including the median denominator. No floating-point conversion or rounded benchmark is used.

## Settled-outcome rate

Provider settlement evidence is also compared as a rational value:

```text
settledOutcomes / terminalOutcomes >= minimumBasisPoints / 10,000
```

This is an observed clearinghouse outcome rate, not a claim that every cancellation/expiry is the provider's fault.

A buyer can decide whether that metric is relevant for its own procurement context.

## Missing evidence

Missing optional evidence is never fabricated.

If a hard gate requires provider history and none was supplied, the candidate is rejected with `PROVIDER_HISTORY_REQUIRED`.

If a settled-market premium gate requires a benchmark and none was supplied, the candidate is rejected with `PRICE_BENCHMARK_REQUIRED`.

When evidence is only used as a ranking preference, missing evidence sorts behind known evidence rather than being assigned a made-up score.

## Preference order

Eligible offers are ordered lexicographically using caller-selected priorities:

```text
unit-price-asc
provider-settled-rate-desc
provider-orders-desc
delivery-latency-asc
seller-id-asc
```

Example:

```json
{
  "priorities": [
    "provider-settled-rate-desc",
    "unit-price-asc"
  ]
}
```

will prefer stronger observed settlement history before price.

Reversing those entries produces a price-first policy. The protocol does not decide which is correct.

If all declared priorities tie, `offerId` is the deterministic final tie-breaker.

## Evidence input

A candidate may include:

- the current capacity offer;
- provider/service evidence shaped like `ProviderHistoryDirectory` output;
- market evidence shaped like `MarketPriceHistoryDirectory` output.

The evaluator validates that supplied evidence belongs to the same seller/service/market before using it.

A deployment may later supply these shapes from PostgreSQL projections rather than the reference O(history) directories, as long as revision/lag semantics remain explicit.

## Output

The result separates:

- `eligible` — policy-compliant offers in declared preference order;
- `rejected` — offers with explicit reason codes;
- `preferredOfferId` — the first eligible candidate under this specific buyer policy;
- normalized policy and market context;
- attributable evidence used for each candidate.

There is deliberately no `score` field.

## Decision support versus execution

`preferredOfferId` is not an execution authorization.

A safe agent workflow is:

```text
find capacity
    |
    v
load provider / market evidence
    |
    v
apply buyer-owned procurement policy
    |
    v
explain / approve selection as required
    |
    v
sign economic intent
    |
    v
policy gates + clearinghouse reservation
```

The last step revalidates capacity, identity, versioning, idempotency, and any deployment policy. The evaluator cannot bypass those controls.

## Why lexicographic policy instead of weighted scoring

Weighted scores often hide assumptions about normalization and trade-offs. A price difference of 1% and a delivery-latency difference of 1% do not have a universal exchange rate.

Lexicographic preferences are intentionally simpler and easier to audit:

1. hard constraints remove unacceptable candidates;
2. the buyer declares what matters first;
3. ties fall through to the next stated priority.

A marketplace that wants a sophisticated optimization model can build one above the same evidence. It should publish/attribute that model rather than presenting it as clearinghouse truth.

## Future extensions

Useful explicit extensions could include:

- buyer-defined service-window risk gates;
- insurance/licensing credential requirements;
- proof-verification history;
- mission-bundle feasibility evidence;
- RFQ-specific commercial commitments;
- diversity/resilience constraints for multi-award procurement;
- policy hashes attached to signed procurement decisions.

The design rule remains the same: make the buyer's decision policy inspectable and keep execution authority in the signed, policy-gated clearinghouse path.
