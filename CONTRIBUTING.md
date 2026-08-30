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

## Autonomous agent pull requests

Same-repository, non-draft pull requests from `agent/` branches are eligible for unattended squash merge after the repository `ci` workflow succeeds on the exact current head SHA. An outstanding changes-requested review blocks that merge.

Unattended merge deliberately excludes changes to `.github/workflows/`, `LICENSE`, and `SECURITY.md`; those surfaces change the automation or governance boundary and must use an ordinary explicit merge.

For new optional public modules that do not belong in the transaction kernel, prefer one independently testable file under `src/extensions/`. The package exports `space-economy-clearinghouse/extensions/*` through a wildcard, so independent extension PRs do not need to edit the shared `package.json` export registry. Existing compatibility subpaths remain explicit.
