# Seller RFQ opportunity discovery

`RfqOpportunityDirectory` is a read-only discovery layer that closes the supply/demand loop around `RfqMarket`.

Buyers publish RFQs. Sellers publish authoritative clearinghouse offers. The opportunity directory answers one narrow question:

> Which currently open buyer RFQs can this seller quote with its real, currently available offers?

It does not rank buyers, auto-submit quotes, reserve capacity, negotiate price, or award work.

## Contract

```js
import { RfqOpportunityDirectory } from 'space-economy-clearinghouse/rfq-opportunities';

const directory = new RfqOpportunityDirectory({
  rfqMarket,
  market,
});

const page = await directory.listOpportunities({
  sellerId: 'provider-a',
  service: 'data-relay',
  settlementAsset: 'iso4217:USD',
  limit: 100,
});
```

The result contains:

- `sellerId`
- `rfqRevision`
- `marketRevision`
- `generatedAt`
- `total`
- `hasMore`
- `opportunities[]`

Each opportunity is one exact `RFQ × offer` pair and includes the buyer, offer/asset IDs, source resource versions, requested quantity, current remaining capacity, exact public offer price/total, RFQ price ceiling, capability requirements, service window, and RFQ expiry.

## Quoteability, not fuzzy similarity

An opportunity is returned only when the seller's offer satisfies the same fit rules enforced by `RfqMarket.submitQuote()`:

1. RFQ is open and not expired at discovery time;
2. offer is open;
3. offer belongs to the requested seller;
4. buyer and seller are different participants;
5. service matches;
6. billable unit matches;
7. remaining offer capacity covers the full RFQ quantity;
8. offer asset is active;
9. asset satisfies every required RFQ capability;
10. requested settlement asset matches, when constrained;
11. exact offer unit price is at or below the RFQ ceiling, when constrained;
12. the offer service window fully covers the requested RFQ service window, when constrained.

An exact seller/offer/RFQ pair is also omitted while it already has an active quote. Discovery should not invite a duplicate quote that the RFQ market will reject.

The test suite cross-checks returned opportunities by submitting them through the real `RfqMarket.submitQuote()` path. This is deliberate: discovery semantics should not drift into a looser definition of tradability.

## Cross-store consistency

RFQ demand and clearinghouse capacity are separate persistence domains. The directory therefore does not pretend it has a distributed transaction.

For each read attempt it captures:

- RFQ-book revision before the scan;
- clearinghouse revision before the scan;
- open RFQs;
- offers and assets;
- active quotes for the candidate RFQs;
- both revisions again after the scan.

If either source changed, the whole attempt is discarded and retried.

After repeated churn it returns `OPPORTUNITIES_CHANGED` instead of combining facts from incompatible moments.

This produces a consistency-stamped discovery view without making RFQ intent part of clearinghouse transaction state.

## Expiry behavior

RFQ expiry is filtered at read time with:

```text
generatedAt < expiresAt
```

The opportunity directory does not mutate an expired RFQ's stored status. RFQ lifecycle mutation remains the responsibility of the RFQ market or an explicit expiry workflow if one is added later.

## Ordering and bounds

The reference directory deliberately does not rank opportunities by buyer, price, RFQ size, or commercial attractiveness.

Results are ordered deterministically by:

1. earliest RFQ expiry;
2. RFQ ID;
3. offer ID.

This is operational ordering, not economic ranking.

`limit` is bounded to 500. `total` reports the full compatible-pair count for the stable snapshot and `hasMore` signals truncation.

A production-scale implementation can move this contract onto indexed RFQ/capacity projections later without changing seller-facing semantics.

## Trust boundary

The directory is decision support only.

A safe seller flow is:

```text
seller capacity
  -> compatible RFQ opportunities
  -> seller commercial policy
  -> optional human/agent decision
  -> submitQuote()
  -> buyer evaluation/award
  -> clearinghouse reservation
```

An opportunity is not a guarantee that the quote will still succeed later. Capacity, RFQ state, offer versions, and time may change after discovery. `submitQuote()` remains authoritative and revalidates the pair.

## Deliberate non-goals

V1 does not provide:

- buyer reputation or credit scoring;
- seller-side opportunity ranking;
- automated bid pricing;
- negotiated price overrides;
- partial/multi-award RFQ matching;
- provider substitution;
- push notifications;
- RFQ expiry mutation;
- guaranteed quote acceptance;
- distributed locks across RFQ and clearinghouse stores.

Those concerns can be layered above this exact compatibility surface without weakening clearinghouse capacity conservation or RFQ ownership rules.
