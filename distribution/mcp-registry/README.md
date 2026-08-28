# Official MCP Registry publication

`server.npm.template.json` is a publication template, **not a claim that the package is currently published**.

The MCP Registry hosts metadata, not server artifacts. For an npm-backed entry it verifies that the referenced public npm package exists and contains an `mcpName` matching the registry server name.

The repository currently keeps `adapters/mcp/package.json` as:

```json
{
  "name": "@svyable/space-economy-mcp",
  "mcpName": "io.github.Svyable/space-economy",
  "private": true
}
```

`private: true` is intentional protection against accidental publication while the distribution/runtime contract is still being established.

## Before publishing

1. Confirm ownership/availability of the intended npm scope/package name.
2. Review the adapter's dependency/security posture and run all MCP + root + PostgreSQL CI.
3. Decide whether `0.1.0` is the release version; update both `package.json` and the registry template together if not.
4. Remove `private: true` intentionally and add any required npm publication metadata.
5. Publish the exact package version to the public npm registry.
6. Verify the published package metadata contains the expected `mcpName` and stdio bin.
7. Copy `server.npm.template.json` to `adapters/mcp/server.json` or the working directory used by `mcp-publisher`.
8. Validate against the then-current official Registry schema/CLI; update `$schema` if the registry format has advanced.
9. Authenticate with `mcp-publisher login github` (or the appropriate GitHub OIDC workflow) as the `Svyable` account.
10. Run `mcp-publisher publish` and verify the registry API returns `io.github.Svyable/space-economy`.

Do not publish registry metadata before the underlying npm package exists: that creates an installation record clients cannot resolve.

## Remote alternative

If a production Streamable HTTP endpoint is hosted instead of—or in addition to—the npm stdio package, create registry metadata for the real HTTPS URL only after:

- TLS is live;
- Host/Origin validation is configured;
- authentication/authorization is enforced;
- rate/body limits and observability exist;
- production storage is durable;
- the endpoint is tested with current MCP conformance/client tooling.

The repository's `createSpaceEconomyMcpHandler()` is a protocol handler, not that entire production perimeter.
