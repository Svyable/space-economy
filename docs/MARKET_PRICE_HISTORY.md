# Settled market price history

Autonomous buyers need historical price evidence when deciding whether an available offer or RFQ quote is economically plausible. `MarketPriceHistoryDirectory` derives that evidence only from orders that actually reached `settled`.

It is a historical observation surface, **not a pricing oracle**.

## Market key

A benchmark is scoped to:

```text
service + unit + settlementAsset
```

For example:

```text
data-relay + MB + iso4217:USD
```

Different services, billable units, or settlement assets are never silently combined.

## Reported evidence

A benchmark contains:

- clearinghouse revision represented by the read;
- ledger integrity result;
- number of settled order observations;
- total settled quantity;
- observed unit-price low;
- observed unit-price high;
- exact median unit price;
- exact settled notional;
- first and last settlement timestamps in the sample.

No seller identity is included in the benchmark output.

## Settled-only rule

Quotes, open offers, reserved orders, funded orders, delivered-but-unsettled orders, cancelled orders, and expired reservations are **not** price observations.

This is intentionally conservative. A posted offer is an asking price. A quote is proposed commercial intent. A settled order is evidence that a buyer and seller completed the clearinghouse lifecycle at that contracted price.

The benchmark still does not prove external cash finality beyond the selected settlement rail's own guarantees. It reports the clearinghouse's settled contract history.

## Exact money and median

All arithmetic is integer based.

Historical orders may use different decimal scales for the same settlement asset. The directory first aligns values at the maximum observed scale using integer multiplication.

Low/high values use the normal money representation:

```json
{
  "settlementAsset": "iso4217:USD",
  "amount": "1250",
  "scale": 3
}
```

The median is represented as an exact rational over the aligned decimal scale:

```json
{
  "settlementAsset": "iso4217:USD",
  "amountNumerator": "225",
  "amountDenominator": "2",
  "scale": 2
}
```

That example represents USD 1.125 exactly. Returning a denominator avoids rounding an even-sized sample and remains exact even when input prices already use the maximum supported monetary scale.

## Time windows

Queries may define `since` and/or `until`.

Semantics are:

```text
since <= settledAt < until
```

This makes adjacent windows composable without double-counting boundary observations.

## No fair-value claim

The directory deliberately does not publish:

- `fairValue`;
- a forecast;
- expected future price;
- recommended bid/ask;
- liquidity-adjusted value;
- provider ranking;
- inflation or risk adjustment.

Space-service contracts are heterogeneous. Price may depend on orbit, geometry, scheduling flexibility, mission criticality, service quality, regulatory constraints, insurance, volume, lead time, or negotiated terms that are not captured by one service/unit label.

Agents and marketplaces may use this benchmark as one input to a documented procurement model, but should not treat it as an executable oracle.

## Stable reads

Like provider history, price history is built from one revision-stable clearinghouse view:

1. capture clearinghouse revision;
2. verify ledger integrity;
3. discover order IDs from the ledger;
4. load current orders and retain only `settled` orders;
5. re-read revision;
6. retry if the market changed during assembly.

A failed ledger verification returns `LEDGER_INTEGRITY_FAILED`. Repeated revision churn returns `HISTORY_CHANGED` rather than combining inconsistent observations.

## Privacy and minimum samples

`listBenchmarks()` supports a `minObservations` threshold. Deployments that consider sparse transaction history commercially sensitive can require a larger minimum sample before exposing aggregate market data.

This reference module does not claim that a threshold alone provides statistical disclosure control or anonymity. Production deployments should apply their own access-control and privacy policy.

## Scaling

The reference implementation is intentionally simple and auditable: it discovers orders from the ledger and loads current order state. That is O(history).

At scale, preserve the same benchmark contract behind a derived PostgreSQL projection with:

- service/unit/settlement-asset keys;
- source clearinghouse revision;
- settled quantity/notional aggregates;
- an exact price distribution structure sufficient for median calculation;
- explicit projection lag;
- rebuildability from authoritative state.

The projection must remain derived data. It must never become the authority for settlement or order state.

## Future extensions

Possible higher-level market-data products include:

- rolling-window price histories;
- volume buckets;
- transparent buyer-defined risk adjustments using provider history;
- quote-vs-settlement spread analysis once negotiated commitments exist;
- route/bundle cost histories;
- privacy-preserving aggregate publication.

Those should compose above this settled-evidence primitive rather than changing the meaning of historical clearinghouse prices.
