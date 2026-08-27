# Delivery proof verification

The clearinghouse records delivery evidence without pretending to understand every space service. Verification is a separate, typed adapter boundary.

This separation is intentional. A relay receipt, launch insertion result, propellant custody transfer, docking event, surface delivery, and observation product have different evidence and trust models. The transaction kernel should not encode all of them.

## Proof envelope

Orders may carry a proof envelope:

```json
{
  "type": "quantity-receipt/v1",
  "data": {
    "deliveredQuantity": 20000,
    "unit": "MB"
  }
}
```

`type` selects a versioned verification profile. `data` is profile-specific JSON. The canonical proof hash is computed over exactly `{ type, data }` using the same RFC 8785-compatible canonicalization as the clearinghouse ledger.

A type name is a protocol identifier, not merely a display label. Changing verification semantics requires a new type/profile version rather than silently replacing the existing verifier.

## Verifier registry

`ProofVerifierRegistry` maps a proof type to an async verifier function:

```js
registry.register('operator.example/data-relay-receipt/v1', async ({
  order,
  proof,
  proofHash,
  context,
  verifiedAt,
}) => ({
  status: 'verified',
  verifierId: 'operator.example:relay-verifier',
  profileVersion: '1.2.0',
  claims: { deliveredQuantity: 20000, unit: 'MB' },
  evidence: [{ digest: 'sha256:...', mediaType: 'application/octet-stream' }],
}));
```

A verifier result MUST declare:

- `status`: `verified`, `rejected`, or `indeterminate`;
- `verifierId`: the attributable verifier identity;
- `profileVersion`: the implementation/profile version used for the decision.

It MAY include:

- `claims`: machine-readable verified claims;
- `evidence`: references or digests for evidence artifacts;
- `reason`: a human-readable decision reason.

The registry adds `proofHash`, `verifiedAt`, and a canonical `attestationHash` over the normalized result.

## Status semantics

- **verified** — the configured verifier concluded the evidence satisfies the profile.
- **rejected** — the evidence was understood and failed the profile.
- **indeterminate** — the verifier could not reach a reliable yes/no result, for example because required external evidence was unavailable.

Unknown proof types fail closed with `UNSUPPORTED_PROOF_TYPE`.

## Trust is deployment policy

A cryptographically stable attestation is not automatically a trustworthy attestation. Deployments decide which verifier identities and profile versions are acceptable for a service.

Examples:

- one market may trust a ground-network operator's signed receipt;
- another may require independent ranging or multiple telemetry sources;
- an insured contract may require an approved third-party verifier;
- automated settlement may require `verified` from one exact profile while a manual workflow may tolerate `indeterminate`.

Those policies sit above the verifier registry.

## Space-data profiles

Where standardized evidence formats already exist, proof profiles should reference them rather than inventing proprietary orbital data structures. Orbit/navigation evidence may reference CCSDS Orbit Data Messages; conjunction-related policy may consume CCSDS Conjunction Data Messages.

The verifier should generally store or expose evidence digests/references rather than embedding large telemetry artifacts in clearinghouse state.

## Reference verifier

`createExactQuantityReceiptVerifier()` demonstrates the contract by comparing a receipt's claimed `deliveredQuantity` and `unit` with the order. It is deterministic and useful in tests, but it provides **no independent evidence of delivery**. Production services should replace it with evidence-backed verifier profiles.

## Future integration

The initial registry is intentionally decoupled from order persistence. A later policy layer can:

1. retrieve a recorded order proof;
2. run the configured verifier;
3. persist or externally anchor the attestation;
4. authorize settlement only when the market's verification policy is satisfied.

This avoids changing the persisted v0.1 order schema before migration infrastructure exists while still fixing the verifier contract early.
