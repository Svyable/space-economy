# Standards alignment

The project should interoperate with existing standards instead of creating space-specific replacements for solved infrastructure problems.

## Adopt now

### RFC 8785 — JSON Canonicalization Scheme

Ledger events and delivery-proof digests need deterministic bytes before hashing or signing. The reference implementation canonicalizes its I-JSON domain objects before SHA-256 hashing and rejects malformed Unicode, Unicode noncharacters, and negative zero rather than allowing ambiguous canonical inputs.

Reference: <https://www.rfc-editor.org/rfc/rfc8785.html>

### RFC 9457 — Problem Details for HTTP APIs

HTTP errors use `application/problem+json` with stable machine-readable problem identifiers.

Reference: <https://www.rfc-editor.org/rfc/rfc9457.html>

### CloudEvents 1.0.2

Mutation events use the CloudEvents core attributes so the ledger can later be bridged into common event buses and observability systems without inventing another envelope. Hash-chain fields are extension attributes.

Reference: <https://github.com/cloudevents/spec/tree/v1.0.2>

### OpenAPI 3.2.0

The HTTP contract is versioned and machine-readable in `openapi.yaml`.

Reference: <https://spec.openapis.org/oas/v3.2.0.html>

### ISO 4217 naming for fiat settlement assets

Fiat prices should use namespaced settlement asset identifiers such as `iso4217:USD`. The clearinghouse deliberately keeps the namespace extensible for non-fiat rails.

Reference: <https://www.iso.org/standard/64758.html>

## Integrate at protocol boundaries

### RFC 9421 — HTTP Message Signatures

Production HTTP deployments that use request signing should implement RFC 9421 rather than inventing a clearinghouse-specific signature header. The reference server exposes an injectable authenticator so signature verification, mTLS, OIDC, or gateway authentication can all derive the same trusted `actorId` without changing domain commands.

A signed mutation profile should cover the request target, method, body integrity field, and concurrency/idempotency fields needed by the deployment. See [`AUTHENTICATION.md`](AUTHENTICATION.md).

Reference: <https://www.rfc-editor.org/rfc/rfc9421.html>

### RFC 9530 — Digest Fields

Signed requests with content should use `Content-Digest` to bind the actual HTTP content bytes and cover that digest field with the message signature.

Reference: <https://www.rfc-editor.org/rfc/rfc9530.html>

### CCSDS 502.0-B-3 — Orbit Data Messages

CCSDS ODM defines OPM, OMM, OEM, and OCM formats for exchanging spacecraft orbit information. The clearinghouse should reference or attach ODM artifacts when orbit state matters instead of inventing its own orbital-state schema.

Reference: <https://ccsds.org/Pubs/502x0b3e1.pdf>

### CCSDS 508.0-B-1 — Conjunction Data Message

Conjunction policy modules should consume standardized CDM data for collision-risk gates rather than embedding proprietary conjunction structures in orders.

Reference: <https://ccsds.org/publications/bluebooks/>

## Keep pluggable

### W3C Decentralized Identifiers

DID Core 1.0 is a W3C Recommendation and DID Core 1.1 is still on the Recommendation track as of 2026. The kernel therefore accepts opaque participant identifiers and should integrate DID resolution through an identity adapter rather than making one DID method a protocol dependency.

Reference: <https://www.w3.org/TR/did-core/>

### W3C Verifiable Credentials 2.0

VC Data Model 2.0 became a W3C Recommendation in May 2025. It is a strong candidate for portable operator, asset-control, licensing, insurance, or verifier credentials, but credential policy belongs outside the capacity ledger.

Reference: <https://www.w3.org/TR/vc-data-model-2.0/>

## Compatibility rule

Standards references in this document describe integration targets, not blanket compliance claims. A module should claim conformance only when it is accompanied by conformance tests or validation against the relevant specification.
