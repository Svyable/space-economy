# Authentication and signed-request boundary

The clearinghouse kernel accepts an `actorId` in trusted command context. It does **not** authenticate network callers itself. Transport adapters are responsible for deriving that actor from authenticated state before invoking a domain command.

The reference HTTP server therefore exposes an injectable async `authenticate(req)` function. Its default implementation trusts `x-participant-id` only for local development and marks that assurance method as unauthenticated.

## Required production property

A production authenticator MUST derive `actorId` from evidence the caller cannot freely rewrite. Suitable deployments include:

- mutual TLS with a certificate-to-participant mapping;
- OIDC/OAuth access tokens validated for issuer, audience, expiry, and required claims;
- HTTP Message Signatures with a trusted key resolver;
- a gateway that performs equivalent authentication and forwards an integrity-protected principal to the clearinghouse.

Authorization remains a separate policy concern. Authenticating an operator proves who is making a command; it does not by itself prove that the operator is licensed, insured, controls a specific asset, or may perform a regulated action.

## Recommended HTTP Message Signature profile

For deployments using signed HTTP commands, build on RFC 9421 rather than creating a clearinghouse-specific signature syntax.

For state-changing requests, a deployment profile SHOULD cover at least:

- `@method`;
- `@target-uri` (or the equivalent covered target components required by the deployment);
- `content-digest` for requests with content;
- `content-type`;
- `idempotency-key` when present;
- `if-match` when present.

The content bytes SHOULD be protected with `Content-Digest` from RFC 9530 and the digest field SHOULD itself be covered by the HTTP Message Signature. This prevents a valid signature from being detached from the body it authorized.

Profiles SHOULD use `created` and `expires` signature parameters and SHOULD define replay handling. RFC 9421 also provides a `nonce` signature parameter for deployments that maintain verifier-side replay state.

Ed25519 is a good default asymmetric algorithm when supported by the deployment; RFC 9421 defines its use by reference to RFC 8032. Algorithm and key policy remain deployment configuration rather than persisted clearinghouse protocol fields.

## Replay and idempotency

Authentication replay defense and business-command idempotency solve related but different problems:

- signature timestamps/nonces limit reuse of captured authenticated HTTP messages;
- the clearinghouse `Idempotency-Key` prevents a legitimate retry from applying the same mutation twice;
- optimistic concurrency (`If-Match`) prevents a valid but stale actor from overwriting a newer resource version.

A production adapter should preserve all three controls rather than treating one as a replacement for the others.

## Credentials and portable authority

The kernel intentionally stores opaque participant identifiers. W3C Verifiable Credentials can later carry portable claims such as operator identity, asset-control authority, licensing, insurance, or proof-verifier authority. DID resolution is likewise an adapter concern. Neither VC nor any DID method is required by the transaction kernel.

## Trust rule

Never copy a caller-provided identity field into `actorId` merely because the request arrived over TLS. TLS authenticates the server by default, not the client. The development `x-participant-id` adapter exists only to make the reference implementation easy to exercise locally.
