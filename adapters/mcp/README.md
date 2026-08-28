# Space Economy MCP adapter

A read-first Model Context Protocol adapter for the Space Economy clearinghouse.

This adapter uses the stable MCP TypeScript SDK v2 line implementing the 2026-07-28 protocol revision. It is isolated under `adapters/mcp/` so MCP/Zod dependencies do not become runtime dependencies of the clearinghouse kernel.

## Default surface

Without any write executor, the server exposes:

```text
list_assets
list_offers
get_order
get_market_status
```

and the resource:

```text
space-economy://protocol/overview
```

All default tools are annotated read-only, idempotent, and closed-world.

`get_market_status` intentionally returns ledger integrity/head metadata rather than the entire append-only event history. Large event streams should eventually be served through dedicated projections/pagination instead of one unbounded model-context response.

## Local stdio

From this directory:

```bash
npm install
STATE_PATH=../../data/state.json npm start
```

`src/stdio.js` opens the clearinghouse state and serves MCP over stdio. This entrypoint is deliberately read-only.

An MCP host can launch the same command as a local subprocess. The host controls process isolation and filesystem access to `STATE_PATH`.

## Modern Streamable HTTP

`createSpaceEconomyMcpHandler(options)` returns the MCP SDK v2 web-standard handler:

```js
import { Clearinghouse } from '../../src/clearinghouse.js';
import { createSpaceEconomyMcpHandler } from './src/server.js';

const market = await Clearinghouse.open({ statePath: './data/state.json' });
const handler = createSpaceEconomyMcpHandler({ market });

// Framework/runtime-specific code should route POST/GET/DELETE /mcp to:
// handler.fetch(request)
```

The handler itself is not a production HTTP perimeter. Before exposing it publicly, a deployment must provide at least:

- TLS;
- Host and Origin validation appropriate to the framework/runtime;
- authentication/authorization in front of requests;
- request/body/rate limits;
- observability and abuse controls;
- durable production storage such as the PostgreSQL adapter rather than a shared local JSON file.

Do not derive clearinghouse `actorId` from an arbitrary MCP argument or bearer-token string.

## Optional signed mutation surface

A deployment may inject an existing `SignedCommandExecutor`:

```js
const handler = createSpaceEconomyMcpHandler({
  market,
  commandExecutor,
});
```

Only then does the server register:

```text
execute_signed_command
```

The tool accepts a complete `spaceeconomy.command.v1` Ed25519 envelope. It does **not** accept raw `actorId` plus an arbitrary domain mutation.

The executor remains responsible for:

1. signature verification;
2. trusted `keyId` → participant key authorization;
3. audience/time-window validation;
4. configured policy gates;
5. explicit operation allowlisting;
6. persisted clearinghouse idempotency and optimistic version checks.

The MCP tool is conservatively annotated as destructive because one signed-command endpoint spans additive and state-changing operations. It is annotated idempotent because replaying the exact same signed command uses the kernel's persisted idempotency semantics.

## Why one signed write tool

Registering tools such as `register_asset_as`, `reserve_as`, or `cancel_as` would tempt an MCP deployment to trust identity fields supplied by the model/caller.

Instead, agent intent becomes a signed protocol artifact that can survive queues, relays, intermittent links, or another transport without weakening the authentication boundary. MCP is the delivery surface; the signed command is the authenticated economic intent.

## Testing

```bash
npm install
npm test
```

The suite uses the official MCP v2 client and `StreamableHTTPClientTransport`, with requests delegated directly to `createMcpHandler().fetch`. This exercises the modern protocol in-process without binding a network port.

Tests prove:

- the default server has no mutation tool;
- read tools return current clearinghouse state;
- protocol overview is discoverable as a resource;
- domain errors remain attributable tool errors;
- injecting a verified command executor exposes the signed write surface;
- replaying the same signed command is economically idempotent.

## Dependencies

Pinned adapter dependencies:

```text
@modelcontextprotocol/server 2.0.0
@modelcontextprotocol/client 2.0.0 (tests only)
zod 4.4.3
```

These versions are adapter dependencies only. The root clearinghouse package remains independent of MCP.
