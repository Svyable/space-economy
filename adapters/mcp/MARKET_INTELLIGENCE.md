# Optional MCP market intelligence

The default Space Economy MCP server stays intentionally small and read-first.

`src/market-intelligence.js` is an opt-in extension that composes the proven base server with additional read-only market intelligence capabilities when a deployment explicitly injects them.

## Construction

```js
import {
  createSpaceEconomyMarketIntelligenceMcpHandler,
} from './src/market-intelligence.js';

const handler = createSpaceEconomyMarketIntelligenceMcpHandler({
  market,
  rfqOpportunityDirectory,
  marketLiquidityDirectory,
});
```

The base clearinghouse `market` is still required.

The two intelligence capabilities are optional and structurally injected:

```text
rfqOpportunityDirectory.listOpportunities(query)
marketLiquidityDirectory.snapshot(query)
```

The extension does not import or construct those directories itself. This keeps MCP transport separate from the persistence/read-model choices behind the market evidence.

## Conditional tools

With `rfqOpportunityDirectory`, the server additionally exposes:

```text
find_rfq_opportunities
```

Inputs:

```text
sellerId         required
service          optional
settlementAsset  optional
limit            optional, max 100 at MCP boundary
```

This is seller-side demand discovery. `sellerId` is a read filter, not authenticated mutation identity. A deployment that treats RFQ demand as confidential must enforce authorization before MCP requests reach this tool.

The tool never submits a quote or reserves capacity.

With `marketLiquidityDirectory`, the server additionally exposes:

```text
get_market_liquidity
```

Inputs:

```text
service          optional
settlementAsset  optional
limit            optional, max 100 at MCP boundary
```

This returns whatever revision-stable liquidity evidence the injected directory provides. The tool description explicitly preserves the distinction between public offer prices and RFQ maximum-price ceilings; it does not call ceilings bids or calculate spread/fair value.

## Security posture

Both tools use MCP read-only annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

Injecting these directories does **not** enable `execute_signed_command`.

Economic mutation remains available only when the base server is separately constructed with a verified `SignedCommandExecutor`.

The generic checked-in workspace `.mcp.json` continues to launch the base read-only stdio server and does not automatically inject RFQ or liquidity capabilities.

## Error behavior

Directory errors are converted into attributable MCP tool errors while preserving a stable `code`, message, and structured `details` when present.

For example, a cross-store snapshot conflict may surface as:

```json
{
  "error": {
    "code": "OPPORTUNITIES_CHANGED",
    "detail": "sources kept changing",
    "details": {
      "retries": 3
    }
  }
}
```

The MCP session remains alive.

## Why an extension instead of widening the base server

The base server is a stable transport around the authoritative clearinghouse and capacity directory.

RFQ opportunity discovery and aggregate liquidity are higher-level read models with their own consistency and confidentiality concerns. Keeping them in an opt-in extension means:

- the default tool list remains predictable;
- workspace trust never silently exposes buyer demand;
- deployments choose the persistence/read-model implementation;
- confidential RFQ policy can be enforced at the perimeter;
- future intelligence modules can compose without weakening transaction authority.
