# Commercial term commitments

`Clearinghouse` supports seller-authorized, buyer-specific commercial commitments for negotiated capacity pricing without turning RFQ metadata or an external marketplace into transaction authority.

A commitment is a time-bounded promise from the seller that a designated buyer may attempt to reserve a stated quantity from one authoritative offer at stated commercial terms.

It is **not a capacity hold**. Creating a commitment does not reduce offer capacity.

## Why this belongs in the kernel

A quote-specific price is economically meaningful only if the transaction path actually enforces it.

Storing a negotiated price in RFQ metadata while `createOrder()` continues to use the public offer price would create two conflicting economic truths:

- procurement would say one amount was agreed;
- the clearinghouse, funding path, settlement record, and market history would say another.

Commercial commitments move only the enforceable bilateral terms into the clearinghouse. Discovery, negotiation, RFQ strategy, and winner selection can remain above it.

## State

A commitment binds immutable terms:

- `offerId`
- `assetId`
- `sellerId`
- `buyerId`
- `service`
- `unit`
- `quantity`
- exact `unitPrice`
- `reservationTtlSeconds`
- `expiresAt`
- canonical JSON `metadata`

Those fields are hashed into `termsHash` using the repository's canonical SHA-256 representation.

Lifecycle fields are separate:

- `status`: `active`, `revoked`, or `exercised` in persisted state;
- `expired` is a derived read status for an active commitment whose deadline has passed;
- `orderId` after exercise;
- `revocation` after seller revocation;
- `exercisedAt` after exercise;
- optimistic `version`.

Changing lifecycle state does not change `termsHash`.

## Issue terms

Only the current seller of the referenced offer may issue a commitment.

```js
const terms = await market.createCommercialCommitment({
  offerId,
  buyerId: 'buyer-a',
  quantity: 20,
  unitPrice: {
    settlementAsset: 'iso4217:EUR',
    amount: '900',
    scale: 2,
  },
  reservationTtlSeconds: 120,
  expiresAt: '2026-09-01T00:30:00Z',
  metadata: {
    procurementRef: 'rfq-123',
  },
}, {
  actorId: 'seller-a',
  idempotencyKey: 'terms-rfq-123',
});
```

The buyer identity in the payload is an eligibility target, not the authenticated actor. Seller authority comes from trusted command context.

The seller may negotiate a settlement asset different from the public listing's settlement asset. The public offer is not mutated. Future RFQ integration must still enforce any RFQ currency constraint before accepting such terms.

### Quantity check at issuance

The commitment quantity must fit current remaining capacity when it is issued. That rejects obviously impossible terms.

However, capacity is not held. Several active commitments may overlap the same remaining capacity.

This is deliberate. A non-reserving commercial quote must not be presented as an option or inventory lock.

## Reservation TTL

If `reservationTtlSeconds` is omitted, the commitment freezes the offer's current reservation TTL.

If it is supplied as a positive integer, that negotiated TTL is used for the resulting order.

If it is explicitly `null`, the resulting reservation has no funding deadline.

The value is part of `termsHash`.

## Exercise

Only the designated buyer may exercise the commitment:

```js
const order = await market.exerciseCommercialCommitment(terms.id, {
  actorId: 'buyer-a',
  idempotencyKey: 'exercise-rfq-123',
  expectedVersion: terms.version,
});
```

Exercise rechecks, in the authoritative clearinghouse transaction:

- commitment ownership and status;
- commitment deadline;
- current referenced offer existence and seller binding;
- current offer status;
- service-window end;
- current remaining capacity.

Only then does it decrement offer capacity and create the order.

The order's `unitPrice` and `total` come from the immutable commitment, not from the public offer price.

The order carries:

```json
{
  "commercialCommitment": {
    "id": "...",
    "termsHash": "sha256:..."
  }
}
```

Funding, delivery, cancellation/expiry, settlement, ledger integrity, and downstream settled-price history remain ordinary clearinghouse behavior.

## Capacity conservation

Outstanding commitments do not contribute to reserved capacity.

Two overlapping commitments may therefore both be valid before exercise. If only one can still fit, concurrent exercise is resolved by the clearinghouse's existing snapshot CAS boundary:

1. both workers may begin from the same revision;
2. one transaction commits the capacity reservation;
3. the other receives `STORE_CONFLICT` and reloads the winner;
4. retry observes current offer state/capacity and fails if the quantity is no longer available.

There is no oversubscription and no distributed lock hidden in the commitment layer.

## Revocation and expiry

The seller may revoke an active, unexpired commitment before exercise:

```js
await market.revokeCommercialCommitment(terms.id, {
  actorId: 'seller-a',
  expectedVersion: terms.version,
});
```

A revoked or expired commitment cannot create a new order.

Expiry is derived at read time and does not require a background mutation job because no capacity is held and therefore no capacity restoration is needed.

## Idempotency

Commitment creation and exercise use the clearinghouse's existing persisted idempotency boundary.

A retry with the same actor, operation, key, and input returns the original result. Exercise also recognizes an already-exercised commitment and returns its existing order rather than reserving capacity again.

## Events

The hash-chained ledger records:

- `spaceeconomy.commercial-commitment.created.v1`
- `spaceeconomy.commercial-commitment.revoked.v1`
- `spaceeconomy.commercial-commitment.exercised.v1`

A negotiated reservation remains an ordinary `spaceeconomy.order.reserved.v1` event and additionally identifies the commitment and `termsHash` that authorized its price.

Historical events are never rewritten during schema migration.

## Schema migration

Clearinghouse persisted state schema v3 adds only the top-level `commercialCommitments` collection.

The v2 → v3 migration initializes it to an empty array. Existing assets, offers, orders, idempotency records, and historical hash-chained ledger events remain unchanged.

## RFQ integration boundary

This change intentionally does not make RFQ quotes themselves authoritative for money.

A later RFQ protocol can allow a seller quote to reference a commitment ID. RFQ acceptance can then exercise that commitment through the clearinghouse after validating:

- quote/RFQ ownership;
- service and unit compatibility;
- RFQ quantity;
- required capabilities;
- RFQ maximum price;
- RFQ settlement asset;
- quote and commitment deadlines.

That keeps negotiation and procurement orchestration above the kernel while making the final economic terms enforceable by the same component that conserves capacity.

## Not an option contract

V1 does not reserve capacity when terms are issued and therefore must not be described as an option, hold, or guaranteed inventory allocation.

A future true option protocol would need distinct economics and state:

- held quantity;
- exercise deadline;
- capacity restoration on expiry;
- option premium/payment evidence when applicable;
- explicit funded-option cancellation/refund rules.

Those semantics are intentionally outside this commitment primitive.
