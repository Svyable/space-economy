# Provider performance history

Autonomous buyers and marketplaces need more than a list of available capacity. They need evidence about how providers have actually executed prior orders.

`ProviderHistoryDirectory` derives a revision-stable, ledger-verified history from clearinghouse orders without turning the protocol into a reputation/ranking authority.

## What it reports

For each `(sellerId, service)` pair, the directory reports:

- current clearinghouse revision used for the read;
- ledger integrity result;
- order counts by current lifecycle status;
- terminal outcome counts (`settled`, `cancelled`, `expired`);
- contracted / settled / cancelled / expired quantity;
- exact contracted and settled monetary totals by settlement asset;
- observed funding, delivery, and settlement latency statistics;
- first/last observed order timestamps and latest terminal/settled timestamps.

It does **not** return one opaque provider score.

## Why no protocol-owned score

A universal reputation score would quietly encode marketplace policy into neutral infrastructure.

Different buyers care about different things:

- settlement completion rate;
- delivery speed;
- cancellation/expiry history;
- mission class or service type;
- counterparty/credit policy;
- proof quality;
- price;
- recency;
- jurisdiction, licensing, insurance, or safety constraints.

The clearinghouse should expose attributable evidence. Agents, insurers, exchanges, mission planners, or procurement systems can apply their own documented risk models above that evidence.

## Exact money

Money remains integer/scale based. When historical orders for the same settlement asset use different decimal scales, the directory aligns them using integer arithmetic before summing.

For example:

```text
USD 2.50  -> { amount: "250",  scale: 2 }
USD 1.250 -> { amount: "1250", scale: 3 }
```

aggregates to:

```json
{
  "settlementAsset": "iso4217:USD",
  "amount": "3750",
  "scale": 3
}
```

No floating-point monetary arithmetic is introduced.

## Timing evidence

Funding, delivery, and settlement latency are measured from the order's `createdAt` timestamp to the relevant recorded timestamp.

The directory reports:

```json
{
  "count": 12,
  "averageMs": 420000,
  "minMs": 30000,
  "maxMs": 1800000
}
```

These are observed workflow timings, not promised SLAs and not proof that delay was the seller's fault.

## Stable reads

History assembly is bounded by clearinghouse revision:

1. read revision;
2. verify ledger integrity;
3. read order IDs from the ledger;
4. load current order snapshots;
5. re-read revision;
6. retry if the market changed during assembly.

If the market changes on every configured attempt, the directory returns `HISTORY_CHANGED` instead of combining facts from inconsistent revisions.

If ledger verification fails, it returns `LEDGER_INTEGRITY_FAILED` and refuses to publish derived history.

## Privacy / disclosure boundary

The public aggregate does not enumerate buyers/counterparties. It groups execution evidence by seller and service.

Deployments may still need additional access-control, privacy, commercial-confidentiality, or data-retention rules. A public market may want broad provider transparency; a private bilateral market may expose history only to authorized participants.

Those disclosure choices belong at the API/policy boundary.

## Reference implementation scaling

The reference directory discovers order IDs from the append-only ledger and then reads the corresponding current orders. This is simple and auditable, but it is O(history) and can require many order reads.

For production scale, keep the **same output contract** but serve it from a derived read model such as PostgreSQL:

- project order lifecycle changes into provider/service aggregates;
- retain the source clearinghouse revision represented by the projection;
- make lag visible;
- rebuild from authoritative state when necessary;
- never let the projection become the authority for order/settlement transitions.

The existing PostgreSQL capacity and reservation-expiry projections demonstrate the intended derived-data pattern.

## Future extensions

Useful future evidence may include:

- proof-verification outcomes by profile;
- dispute/refund outcomes once those workflows exist;
- promised-vs-actual service-window performance where contract terms support it;
- external safety/insurance/licensing attestations;
- provider-signed service-level commitments;
- privacy-preserving or selectively disclosed market statistics.

Those should remain attributable evidence fields, not hidden inputs to a universal score.
