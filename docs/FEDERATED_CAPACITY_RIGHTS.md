# Federated capacity-right admission

A capacity right issued by another clearinghouse is **not** copied into local inventory.

`src/extensions/federated-capacity-rights.js` creates a local admission artifact proving that a remote, issuer-authoritative right was live and held at a signed federation checkpoint and that local policy allowed reliance on it.

This is evidence portability, not asset duplication.

## Why admission instead of wrapping

A local wrapper that behaves like another capacity right would create two independently spendable representations of one physical entitlement. That breaks the conservation invariant the capacity-right kernel exists to protect.

Federated admission therefore never accepts a local market object and never changes local offers, orders, or capacity-right state.

There remains exactly one authoritative right: the issuer's.

## Initial admission

`admitFederatedCapacityRight()` requires:

- a previously trusted issuer checkpoint;
- the issuer's directly chained signed successor checkpoint;
- every ledger event connecting those checkpoints;
- the remote capacity-right ID;
- the right's complete immutable terms;
- a trusted issuer-key resolver;
- a local policy engine;
- the local relying actor;
- freshness limits.

The existing federation verifier first validates the checkpoint signature, clearinghouse identity, predecessor link, revision/sequence monotonicity, fork rules, event count, event sequence, hash chain, canonical event hashes, and terminal head hash.

V1 then requires the verified extension to contain the requested right's creation event. That makes initial admission self-contained from issuance through the admitted checkpoint.

## Full terms without trusting an API snapshot

The capacity-right creation ledger event contains the immutable `termsHash` but intentionally does not duplicate every term field.

The relying party therefore supplies the complete immutable terms:

```text
offerId
assetId
sellerId
service
unit
quantity
exerciseUnitPrice
reservationTtlSeconds
expiresAt
metadata
```

Those values are not trusted. The admission module canonicalizes the full object and recomputes the same SHA-256 terms hash used by the issuer kernel. The result must equal the hash committed by the verified creation event.

Selected fields duplicated in the event—offer, asset, seller, quantity, price and expiry—must also match directly.

This lets service/unit/TTL/metadata travel outside the ledger while remaining cryptographically bound to issuer history.

## Lifecycle reconstruction

After creation, every event for the capacity-right subject in the verified extension is replayed in sequence.

Supported lifecycle events are:

- `spaceeconomy.capacity-right.transferred.v1`
- `spaceeconomy.capacity-right.released.v1`
- `spaceeconomy.capacity-right.expired.v1`
- `spaceeconomy.capacity-right.exercised.v1`

Transfers must form a contiguous holder and transfer-sequence chain. Every event must preserve the original terms hash, offer and seller where present.

A terminal release, expiry or exercise makes the right non-spendable for admission.

Unknown capacity-right lifecycle events fail closed rather than being ignored.

## Freshness

A valid historical signature is not proof that a right remains spendable indefinitely.

Admission therefore applies a caller-owned maximum checkpoint age and a bounded future-clock skew. The right's own exercise deadline is also checked against local observation time.

These are reliance rules, not changes to issuer state.

## Local policy

After cryptographic and lifecycle validation, the module calls a deployment-owned `policyEngine.requireAllowed()` operation named:

`federated-capacity-right.admit`

The policy request includes issuer identity, right ID, holder, immutable terms/hash, checkpoint hash and checkpoint sequence.

A denial or review remains a local decision even when issuer evidence is cryptographically valid.

The resulting attributable policy evaluation is included in the hashed admission artifact.

## Admission artifact

A successful admission contains:

- issuer clearinghouse identity;
- reconstructed current right state;
- full immutable terms and terms hash;
- the full verified issuer checkpoint;
- extension sequence boundaries and event digest;
- local policy evaluation;
- admission time;
- optional previous admission hash;
- canonical admission hash.

The artifact claims only that the right was accepted for local reliance under the stated evidence and policy.

## Refresh

`refreshFederatedCapacityRightAdmission()` verifies the issuer's next directly chained signed checkpoint and only the new intervening ledger events.

It starts from the prior admission's hash-verified right state, applies new lifecycle events, rechecks freshness/spendability/expected holder, reruns local policy, and emits a new admission linked to the prior admission hash.

This allows a relying system to discover that a previously admitted holder transferred the right away or that the issuer released, expired, or exercised it.

## Remote exercise boundary

Admission itself never exercises remote capacity.

A future remote exercise protocol must:

1. refresh issuer evidence;
2. send an idempotent, authenticated exercise request to the **issuer**;
3. obtain issuer-side order/ledger evidence;
4. verify a newer signed checkpoint/extension containing that result;
5. update local routing/portfolio state from that evidence.

Creating a local order first and hoping the issuer honors it later is explicitly unsafe.

## Mission portfolios

A future cross-clearinghouse mission portfolio can treat a fresh admission as externally attested contingent inventory. It still cannot claim distributed ACID: local and remote acquisitions/exercises remain a recoverable saga across independent authorities.

## Non-goals

This module does not add:

- a bridge token or blockchain wrapper;
- local capacity for a remote right;
- global consensus;
- automatic trust of foreign operators;
- custody;
- remote settlement finality;
- cross-clearinghouse atomic transactions.
