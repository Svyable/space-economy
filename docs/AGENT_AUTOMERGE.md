# Agent auto-merge lane

Feature agents that are intended to land without human intervention should work on a same-repository branch whose name starts with `agent/` and open a non-draft pull request to `main`.

The repository will only merge such a pull request automatically after the `ci` workflow succeeds for the exact current head SHA. A changes-requested review blocks the merge. Changes to workflow files, `LICENSE`, or `SECURITY.md` are excluded from unattended merge.

For optional public modules outside the transaction kernel, prefer `src/extensions/<name>.js`. These modules are exported through `space-economy-clearinghouse/extensions/<name>`, which avoids repeated edits to the shared package export map.
