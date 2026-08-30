# Clearinghouse federation checkpoints

A real space economy will not run on one database or one operator. `space-economy` therefore treats federation as exchange of attributable, verifiable state commitments rather than as a hidden distributed transaction.

The federation module turns the clearinghouse's existing hash-chained ledger into compact signed checkpoints and verifies incremental ledger segments between those checkpoints.

## What a checkpoint proves

A checkpoint states that one named clearinghouse observed a verified local ledger at a stable clearinghouse revision with a specific ledger head.

It contains:

```json
{
  "schema": "spaceeconomy.federation-checkpoint.v1",
  "clearinghouseId": "urn:space-economy:clearinghouse:alpha",
  "revision": 42,
  "sequence": 57,
  "headHash": "sha256:...",
  "generatedAt": "2026-09-01T00:00:00.000Z",
  "previousCheckpointHash": "sha256:...",
  "checkpointHash": "sha256:..."
}
```

`headHash` is `GENESIS` when the ledger is empty.

Because every clearinghouse event already includes its predecessor hash, the ledger head commits to the complete prior event chain. V1 does not add a second Merkle tree.

## Stable checkpoint construction

`createFederationCheckpoint()` refuses torn reads.

It performs:

1. `getRevision()`;
2. `verifyLedger()`;
3. `getLedger()`;
4. `getRevision()` again.

If the revision changed, it retries within a bounded policy. If the ledger fails integrity verification, checkpoint construction fails closed.

A checkpoint can optionally link to a previously trusted checkpoint. The link requires the same clearinghouse identity and non-regressing revision/sequence.

## Signing

`signFederationCheckpoint()` wraps a validated checkpoint in:

```json
{
  "schema": "spaceeconomy.federation-checkpoint-envelope.v1",
  "algorithm": "Ed25519",
  "keyId": "did:key:...#federation-1",
  "checkpoint": {},
  "signature": "..."
}
```

Signing bytes are domain separated and canonicalized using the repository's RFC 8785-compatible JSON canonicalizer.

The signature is canonical unpadded base64url.

The envelope does **not** carry a public key. A verifier must resolve `keyId` through a trusted mapping that authorizes that key for the claimed `clearinghouseId`.

DID, PKI, HSM, certificate, registry, or governance choices remain deployment concerns.

## Verification

`verifyFederationCheckpoint()` validates:

- exact envelope/checkpoint schemas;
- no unsupported unsigned envelope fields;
- canonical checkpoint hash;
- Ed25519 signature;
- expected clearinghouse identity when supplied;
- trusted key resolution;
- direct predecessor linkage when supplied;
- non-regressing revision and ledger sequence;
- no same-sequence head equivocation.

A valid signature proves attribution to an authorized key. It does not prove the economic truth of every event the clearinghouse recorded.

## Incremental ledger extension

A peer that already trusts checkpoint A does not need to replay the clearinghouse from genesis to evaluate checkpoint B.

`verifyFederationExtension()` takes:

- trusted checkpoint A;
- directly chained checkpoint B;
- the events after A through B.

It verifies:

- exact event count for the sequence delta;
- contiguous event sequences;
- first `previoushash` equals A's head;
- every event's canonical SHA-256 hash;
- every predecessor link;
- final event hash equals B's head.

Missing, duplicated, reordered, or tampered events fail closed.

An empty extension is valid only if sequence/head are unchanged and B directly links to A.

## Example

```js
import {
  createFederationCheckpoint,
  signFederationCheckpoint,
  verifyFederationCheckpoint,
  verifyFederationExtension,
} from 'space-economy-clearinghouse/federation';

const checkpoint = await createFederationCheckpoint({
  market,
  clearinghouseId: 'urn:space-economy:clearinghouse:alpha',
  previousCheckpoint,
});

const envelope = signFederationCheckpoint(checkpoint, {
  keyId: 'operator-key-2026-09',
  privateKey,
});

const trusted = await verifyFederationCheckpoint(envelope, {
  expectedClearinghouseId: 'urn:space-economy:clearinghouse:alpha',
  previousCheckpoint,
  resolvePublicKey: async ({ keyId, clearinghouseId }) => {
    return authorizedKeyRegistry.resolve({ keyId, clearinghouseId });
  },
});

verifyFederationExtension({
  fromCheckpoint: previousCheckpoint,
  toCheckpoint: trusted.checkpoint,
  events: incrementalEvents,
});
```

## Federation is not global consensus

This protocol deliberately does not claim:

- cross-clearinghouse ACID;
- Byzantine consensus;
- global total ordering;
- shared participant identity;
- asset/capacity portability;
- settlement finality across payment rails;
- truth of delivery evidence;
- automatic trust in a remote operator.

Each clearinghouse remains authoritative for its own local state. Federation makes its claims compact, attributable, chainable, and incrementally auditable.

## Operational use

Useful deployment patterns include:

- regulator or insurer mirrors that archive signed checkpoints;
- peer clearinghouses that consume incremental event feeds;
- public transparency anchors;
- disaster-recovery audit replicas;
- marketplace discovery systems that show which operator attested to which freshness point;
- settlement reconciliation systems that bind remote references to a signed ledger head.

## Key rotation

Key rotation is intentionally external to checkpoint state.

Each envelope identifies `keyId`; verification resolves that key according to deployment policy. Historical checkpoints remain attributable to the key that signed them.

A future federation governance layer can publish signed key-authorization transitions without changing the checkpoint format.

## Future layers

Signed checkpoints are the base for more ambitious interoperability:

- portable capacity-right provenance;
- cross-clearinghouse discovery snapshots;
- witnessed checkpoint anchoring;
- bilateral settlement reconciliation;
- route discovery across service operators;
- proof-carrying cross-market transfers;
- federated clearing without a single central market database.
