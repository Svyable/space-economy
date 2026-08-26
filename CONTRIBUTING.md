# Contributing

The clearinghouse should remain a small protocol kernel with explicit adapters at trust and infrastructure boundaries.

## Design rules

- Protect capacity-conservation, exact-money, idempotency, authorization, and state-transition invariants with tests.
- Prefer extensible identifiers and adapters over hard-coded vendor, chain, payment, identity, or spacecraft-provider assumptions.
- Reuse mature standards when they solve the interoperability problem; document the exact version and avoid untested conformance claims.
- Keep real custody, KYC/KYB, telemetry interpretation, conjunction assessment, insurance, and legal policy outside the core domain model.
- Treat persisted schema and public HTTP shapes as compatibility surfaces. Breaking changes before `1.0` must still be deliberate and documented.
- Add a migration before incrementing `schemaVersion`; never silently reinterpret persisted state.

## Development

Requires a supported Node.js LTS release (22 or 24 at the time this file was written).

```bash
npm test
npm run demo
npm start
```

Every bug fix should include a regression test. Every new state transition should include authorization, idempotency, and failure-path coverage.
