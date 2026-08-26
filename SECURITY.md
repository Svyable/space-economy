# Security policy and trust model

This repository is an early reference implementation of market coordination primitives. It is **not** production financial infrastructure and must not be deployed directly on the public internet without replacing the development trust adapters described below.

## Security boundaries

- `x-participant-id` is a local-development identity shim. Any client can spoof it. Production transports must derive `actorId` from authenticated credentials and authorization policy.
- Funding and settlement `reference` values are evidence recorded by the clearinghouse, not proof that money moved. Real deployments need a custody/payment adapter with replay protection and independent verification.
- Delivery proofs are stored with `verification.status: unverified`. Automated release of value should require a trusted verifier policy.
- The hash chain is tamper-evident. It is not immutable against an attacker who can rewrite all state and recompute the chain. External anchoring or transparency logs may be added where stronger guarantees are required.
- `JsonFileSnapshotStore` is a single-writer development adapter. Use a transactional store with atomic compare-and-swap semantics for production concurrency.
- Asset catalog identifiers do not prove ownership, operational control, licensing, or regulatory status.

## Reporting vulnerabilities

Please use GitHub's private security advisory workflow for sensitive reports rather than filing a public issue with exploit details.

## Deployment checklist

Before production use, replace or add:

1. authenticated actor derivation and authorization policy;
2. secrets/key management and rotation;
3. transactional database storage;
4. payment/custody verification;
5. telemetry/proof verification;
6. audit-log export or external anchoring;
7. rate limits, request authentication, network controls, and abuse monitoring;
8. jurisdiction-specific compliance and mission-safety policy.
