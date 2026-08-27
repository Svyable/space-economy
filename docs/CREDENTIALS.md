# Portable authority credentials

The clearinghouse kernel intentionally stores opaque participant identifiers. It should not hard-code one identity system, DID method, certificate hierarchy, regulator registry, or verifiable-credential proof suite.

`CredentialVerifierRegistry` is the boundary where a deployment turns an external credential into attributable authority claims that policy can use.

## Verification profiles

A profile is a deployment-defined verification contract, for example:

```text
operator-license/v1
asset-control/v1
insurance-coverage/v2
mission-approval/v1
```

The profile selects a trusted verifier implementation. Credential fields supplied by the caller do **not** select executable verifier code.

A profile may wrap systems such as:

- W3C Verifiable Credentials Data Model 2.0 plus a supported proof/presentation mechanism;
- X.509 or mTLS-backed organizational credentials;
- a regulator or licensing registry;
- an insurer API or signed coverage document;
- an internal enterprise authority service;
- another independently authenticated credential system.

The registry itself does not claim conformance to any of those technologies.

## Normalized attestation

A verifier returns one status:

- `valid` — the configured verifier concluded the credential is valid for its profile;
- `invalid` — the credential was understood and failed verification or subject binding;
- `indeterminate` — the verifier could not reach a reliable result.

Normalized results contain attributable metadata:

- `verifierId`;
- `profileVersion`;
- `subjectId` and `issuerId` when known;
- credential `types`;
- verified `claims`;
- optional evidence references;
- optional validity timestamps;
- canonical `credentialHash` and `attestationHash`;
- verification timestamp.

A `valid` result must identify both subject and issuer.

## Subject binding

Cryptographic validity is not enough. A perfectly valid credential belonging to participant A must not authorize participant B.

Callers may pass `expectedSubjectId`. When a verifier returns `valid` for a different subject, the registry converts the normalized result to `invalid` and records the subject mismatch.

For authenticated clearinghouse traffic, the expected subject should normally come from the already-authenticated `actorId`, never from an untrusted payload field.

## Policy bridge

`createCredentialPolicyGate()` converts a credential verification profile into a mandatory `PolicyGateEngine` gate:

```text
valid         -> allow
invalid       -> deny
indeterminate -> review
missing       -> deny by default
```

Missing credentials may instead be configured as `review` when a deployment supports a manual evidence workflow.

The policy result carries the credential attestation hash and verified claims so an audit record can link the transaction decision to the exact verification artifact.

## Asset-control credentials

A useful future profile is `asset-control/v1`. Its claims might establish that an authenticated participant may publish capacity for a specific asset identifier during a defined validity period.

That claim should be checked by policy before `asset.register` or `offer.create`; the clearinghouse should not treat a catalog identifier such as COSPAR or NORAD ID as proof of ownership/control by itself.

## W3C VC and DID posture

W3C Verifiable Credentials Data Model 2.0 is a suitable portable container for claims such as operator licensing, insurance, or asset-control authority. DID identifiers can be useful issuer/subject/key identifiers.

They remain optional adapter technologies:

- the registry does not resolve DIDs by itself;
- it does not implement VC proof suites;
- it does not trust a DID method merely because an identifier begins with `did:`;
- it does not infer authority from a credential's self-declared `type`;
- revocation/status-list policy belongs to the selected verifier profile.

This lets deployments evolve credential technology without changing the transaction kernel.

## Credential hashing

The registry computes an RFC 8785-compatible SHA-256 digest of the supplied JSON credential as an audit/reference digest. This digest is **not** a substitute for the credential format's own cryptographic verification rules.

For formats whose native representation is not JSON, a profile should verify the native object externally and provide an appropriate JSON evidence/claim representation to this layer rather than pretending JCS is the format's signature algorithm.

## Time and revocation

`validFrom` / `validUntil` in the normalized attestation are informational verified claims from the selected profile. The profile remains responsible for applying its format's precise validity, revocation, suspension, status-list, trust-anchor, and clock policy before returning `valid`.

A high-assurance deployment should record enough verifier/profile version and evidence metadata to reproduce why a credential was accepted at the time of a transaction.

## Failure posture

Unknown profiles fail closed. Malformed verifier results fail closed. Duplicate profile registration is rejected so a running process cannot silently swap verification semantics under an existing profile identifier.

Changes to verification behavior should use an explicit profile/profile-version change and normal deployment review.
