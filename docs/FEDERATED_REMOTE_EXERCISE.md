# Federated remote exercise intent and proof

A remote capacity-right admission proves that another clearinghouse currently reports a physically backed entitlement as held. It does not authorize the relying clearinghouse to create a local order for that remote capacity.

Remote exercise remains issuer-authoritative.

`src/extensions/federated-remote-exercise.js` defines two pure artifacts around that boundary:

- a deterministic remote exercise **intent**;
- a verified issuer **completion proof**.

It intentionally does not implement network transport or impersonate the remote holder.

## Intent

`createFederatedRemoteExerciseIntent()` accepts a hash-verified, held federated capacity-right admission and binds:

- issuer clearinghouse identity;
- remote capacity-right ID;
- immutable terms hash;
- current admitted holder;
- admission hash;
- admitted issuer checkpoint hash;
- caller-owned economic idempotency key;
- creation and expiry timestamps.

The admission checkpoint must satisfy a caller-owned freshness window when the intent is created. The intent cannot outlive the capacity right itself.

The result has a canonical `intentHash`.

The intent is not itself a signature. A deployment can embed the intent or its hash in the existing signed-command model, an issuer-specific API envelope, or another authorized holder workflow.

## Why the idempotency key is economic identity

A network timeout after issuer mutation is ambiguous, not evidence of failure.

The same remote exercise attempt must therefore retain the same economic idempotency key across retries. The issuer's ordinary `exerciseCapacityRight()` path can then replay the same order rather than exercising twice.

A caller must not invent a new idempotency identity merely because an HTTP request timed out.

## Completion proof

`verifyFederatedRemoteExerciseProof()` starts from the admission's issuer checkpoint and verifies a directly chained signed successor checkpoint plus the complete intervening ledger extension.

The extension must contain exactly one matching pair emitted by the issuer's ordinary atomic capacity-right exercise command:

```text
spaceeconomy.order.reserved.v1
spaceeconomy.capacity-right.exercised.v1
```

The order event must immediately precede the right exercise event in ledger sequence, matching current kernel emission order.

The verifier checks that both events bind the admitted:

- right ID;
- terms hash;
- offer;
- seller;
- holder/buyer;
- quantity.

It also recomputes the expected order total from the admitted exact exercise price and quantity and requires the issuer event to match it exactly.

An optional expected issuer order ID can be supplied by a transport response. The proof then becomes a reconciliation check between transport metadata and signed ledger evidence.

## Changes after intent

A capacity-right transfer between the admitted state and claimed exercise invalidates the proof path. The relying party must refresh admission and obtain a new intent from the new holder.

Release or expiry before exercise is terminal and non-spendable.

The verifier does not allow a stale holder authorization to become valid merely because ownership later cycles back.

## Semantic proof above cryptographic proof

A valid federation hash chain is necessary but not sufficient.

For example, a cryptographically valid extension that claims a right exercise but lacks the paired order reservation is rejected. Likewise, a signed extension whose order total does not equal the admitted exercise terms is rejected.

This separates two questions:

1. did the issuer sign this exact history?;
2. does that history prove the economic transition the relying system expects?

Both must be true.

## Output

A valid proof binds:

- intent hash;
- admission hash;
- issuer and holder identities;
- right ID / terms hash;
- issuer order ID and exact order economics;
- verified successor checkpoint;
- extension range and digest;
- exact order/exercise ledger sequences;
- verification timestamp.

It explicitly reports:

- `localOrderCreated: false`;
- `issuerAuthoritative: true`.

## Local state boundary

The verifier never accepts a local clearinghouse market and never creates local capacity, rights, or orders.

A mission coordinator may persist this proof as a remote leg outcome. It should not manufacture a local order as a mirror of the issuer order.

## Transport remains separate

A later transport adapter can implement:

```text
fresh admission
  -> create intent
  -> holder-authorized request to issuer
  -> ambiguous/submitted response
  -> obtain newer issuer checkpoint + extension
  -> verify completion proof
  -> reconcile local orchestration state
```

If the request times out after mutation, the workflow stays proof-pending and retries/reconciles under the same idempotency identity.

## Non-goals

This module does not provide:

- remote command transport;
- signatures on behalf of holders;
- a distributed transaction manager;
- local mirrored orders;
- settlement or custody;
- global consensus;
- network-delivery finality.
