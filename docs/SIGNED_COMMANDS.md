# Signed command envelopes

The HTTP adapter can authenticate requests at the transport boundary, but some space-economy workflows will cross queues, relays, intermittent links, offline approval systems, or organizations that cannot preserve one HTTP request end to end.

`spaceeconomy.command.v1` is a transport-neutral signed command envelope for those cases. It complements RFC 9421 HTTP Message Signatures; it does not replace them for ordinary HTTP deployments.

## Envelope

```json
{
  "schema": "spaceeconomy.command.v1",
  "algorithm": "Ed25519",
  "keyId": "did:example:relay-one#key-1",
  "actorId": "relay-one",
  "audience": "urn:space-economy:clearinghouse:example",
  "operation": "order.reserve",
  "nonce": "nonce-001",
  "idempotencyKey": "reserve-001",
  "expectedVersion": 3,
  "createdAt": "2026-08-26T21:00:00.000Z",
  "expiresAt": "2026-08-26T21:01:00.000Z",
  "payload": {
    "offerId": "offer-1",
    "quantity": 8
  },
  "signature": "...base64url..."
}
```

The signature covers every field except `signature` itself.

## Signing bytes

The unsigned envelope is serialized with the repository's RFC 8785-compatible canonical JSON implementation and prefixed with a protocol domain separator:

```text
space-economy.command.v1\n<canonical-json>
```

The bytes are signed with Ed25519. Domain separation prevents a valid signature over some other canonical JSON protocol from being accidentally interpreted as a clearinghouse command.

## Bound semantics

The signature binds:

- `actorId` — the participant making the command;
- `keyId` — the signing key identifier;
- `audience` — the clearinghouse/deployment intended to execute it;
- `operation` and `payload` — the requested domain action;
- `idempotencyKey` — the retry identity of the logical mutation;
- `expectedVersion` — optional optimistic-concurrency expectation;
- `nonce` — a replay identifier for verifier-side replay policy;
- `createdAt` / `expiresAt` — the validity window;
- algorithm and schema identifiers.

Verification rejects unknown top-level extension fields. Extensions therefore require a new envelope schema/version instead of creating unsigned semantics beside a valid signature.

## Key resolution is authorization

A signature only proves possession of the private key. The verifier's `resolvePublicKey({ keyId, actorId, algorithm })` function MUST establish that the resolved key is authorized for the claimed actor.

Unsafe behavior would be to accept a public key supplied alongside the command and then treat successful signature verification as participant authentication. That proves only that the sender controls the supplied key, not that the key belongs to `actorId`.

Key authorization may come from:

- a deployment-owned participant/key registry;
- a validated certificate or HSM-backed key inventory;
- a DID resolver plus deployment policy;
- verifiable credentials proving key/participant authority;
- another authenticated organizational identity system.

Key rotation and revocation policy belong in that resolver layer.

## Time policy

Verification enforces:

- strict RFC 3339 timestamps;
- `expiresAt > createdAt`;
- deployment-configurable maximum lifetime;
- deployment-configurable clock skew;
- rejection of commands too far in the future or already expired.

Short lifetimes are preferable for online command relays. Intermittent/offline mission workflows may intentionally configure longer windows, but should pair them with stronger replay state and operational approval controls.

## Replay and idempotency are different

A valid signature can be copied and replayed until it expires. The verifier therefore returns:

```json
{
  "actorId": "relay-one",
  "keyId": "...",
  "nonce": "nonce-001",
  "expiresAt": "..."
}
```

A deployment can use that tuple in a durable replay cache if its threat model requires single-use envelopes.

Separately, the signed `idempotencyKey` flows into clearinghouse command context. Persisted clearinghouse idempotency prevents a legitimate retry of the same logical mutation from applying twice.

Do not treat either control as a substitute for the other:

- nonce/replay policy limits reuse of captured signed envelopes;
- clearinghouse idempotency makes intended retries economically safe.

## HTTP versus signed commands

For normal authenticated HTTP API calls, prefer the HTTP-native profile in [`AUTHENTICATION.md`](AUTHENTICATION.md), including RFC 9421 and RFC 9530 where message signatures are required.

Use this envelope when the command must survive beyond one HTTP request or cross a transport that cannot preserve HTTP Message Signature semantics.

An HTTP gateway may verify a signed command envelope and then invoke the same clearinghouse domain method using the returned trusted command context. It should never copy `actorId` from the unverified envelope before signature/key authorization succeeds.

## Deliberate omissions

The helper does not provide:

- private-key custody;
- DID resolution;
- certificate validation;
- replay-cache persistence;
- authorization policy beyond key-to-actor resolution;
- human approval workflows;
- automatic mapping from arbitrary `operation` strings to executable code.

Those are deployment responsibilities. Keeping them explicit avoids turning one identity technology or key-management provider into a protocol requirement.
