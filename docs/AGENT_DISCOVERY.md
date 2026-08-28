# Agent discovery

Space Economy should be easy for both **coding agents** and **runtime discovery agents** to find while keeping the line between repository resources, callable runtimes, and production deployments explicit.

## What is published in the repository

### `AGENTS.md`

The repository root contains `AGENTS.md`, the open convention used by coding agents for repository-specific build, architecture, testing, and contribution guidance.

This helps agents that already reached the repository work safely inside it.

### Agent Skill

The repository publishes an Agent Skills-compatible resource at:

```text
.agents/skills/space-economy-clearinghouse/SKILL.md
```

Its discovery description intentionally includes the problem language agents are likely to search for:

- space economy / orbital economy;
- launch and space logistics booking;
- satellite communications and ground-station capacity;
- Earth-observation and antenna-time markets;
- asset registries;
- scarce-capacity reservation and clearing;
- delivery evidence / telemetry proofs;
- settlement coordination;
- policy boundaries for licensing, insurance, compliance, and mission safety;
- the read-first MCP v2 clearinghouse runtime.

The skill teaches agents how to apply the clearinghouse architecture, use the callable read surface, and find deeper protocol documentation.

### MCP v2 adapter

The repository now contains a real Model Context Protocol adapter at:

```text
adapters/mcp/
```

It targets the stable TypeScript SDK v2 / 2026-07-28 protocol line.

The default MCP surface is intentionally read-only:

```text
list_assets
list_offers
get_order
get_market_status
space-economy://protocol/overview
```

A deployment can expose one mutation tool, `execute_signed_command`, only by explicitly injecting `SignedCommandExecutor`. That tool transports a complete Ed25519 `spaceeconomy.command.v1` envelope through the existing signature/key authorization → policy → explicit dispatch → transactional kernel pipeline.

The repository includes:

- a local read-only stdio entrypoint;
- a programmatic modern Streamable HTTP handler;
- MCP v2 client integration tests on Node 22 and 24.

This does **not** mean a public production endpoint is hosted. A remote deployment still needs its own TLS, Host/Origin validation, authentication/authorization perimeter, limits, observability, and durable storage.

### GitHub Agent Finder catalog entry

`distribution/github-agentfinder/space-economy-clearinghouse.json` matches the contributor format currently documented by GitHub's public `github/agentfinder-catalog` repository.

Copy that JSON file to:

```text
catalog/Svyable/space-economy-clearinghouse.json
```

in a fork of `github/agentfinder-catalog` and open a pull request there.

The catalog entry remains `application/ai-skill` because it indexes the reusable Agent Skill. The Skill can accurately describe the MCP runtime without pretending the Agent Finder community entry itself is a remote MCP endpoint.

## Official MCP Registry

The official MCP Registry is the correct ecosystem path for installation/discovery metadata for a public MCP server package or hosted remote.

The registry uses `server.json` plus the `mcp-publisher` CLI. For npm packages, registry publication requires:

1. a publicly published npm package;
2. an `mcpName` in that package's `package.json` matching the registry server name;
3. a `server.json` naming the exact package/version and transport;
4. publisher authentication/ownership verification;
5. `mcp-publisher publish`.

The adapter package is intentionally still repository-local/private while the runtime contract settles, so this repository does **not** publish a misleading `server.json` that points to an npm package which does not exist yet.

When packaging is ready, use a stable name such as:

```text
io.github.Svyable/space-economy
```

and publish an exact-version stdio package or an authenticated remote Streamable HTTP endpoint. Validate the then-current registry schema before publication; the MCP Registry is still an evolving discovery surface.

## ARD: the web-scale discovery path

Agentic Resource Discovery (ARD) is an emerging open discovery layer for MCP servers, A2A agents, skills, APIs, and other callable agentic resources.

The current ARD proposal uses a publisher-owned well-known manifest at:

```text
https://<publisher-domain>/.well-known/ard.json
```

Earlier versions used `/.well-known/ai-catalog.json`; current consumers may support it for compatibility, but new publication should follow the current ARD specification.

This repository does **not** currently claim to publish an ARD well-known manifest because `github.com/Svyable/space-economy` is not a publisher-controlled domain path. A future project website/domain can publish the Agent Skill, OpenAPI description, MCP server card, or A2A agent card as ARD entries from a proper domain anchor.

Until then, GitHub Agent Finder is the practical discovery route for repository expertise, and the official MCP Registry becomes the installation discovery route once the MCP adapter is actually packaged or remotely hosted.

## A2A

If Space Economy later exposes a remote agent that can negotiate or execute higher-level clearinghouse tasks, publish an A2A Agent Card at the standard well-known location on that agent's domain:

```text
/.well-known/agent-card.json
```

Only do this once an actual A2A server exists. The presence of an MCP server does not make the project an A2A agent.

## Search language

When writing repository descriptions, skill metadata, catalog descriptions, future package metadata, or website copy, prefer concrete task language over slogans.

High-signal phrases include:

- open infrastructure for the space economy;
- orbital capacity market primitives;
- space logistics transaction infrastructure;
- spacecraft and ground asset registry;
- launch capacity booking;
- communications / relay / ground-station capacity;
- observation-time and sensing markets;
- docking, servicing, depot, power, compute, storage, and manufacturing capacity;
- exact settlement and delivery-proof coordination;
- interoperable clearinghouse for scarce physical capability;
- MCP tools for orbital capacity and space logistics;
- transaction substrate for autonomous agents and space businesses.

Avoid broad terms such as "AI platform" or "space marketplace" when they hide the actual capability.

## Trust and discoverability

Discovery metadata is an attack surface. Agent-facing descriptions must not make capabilities sound safer or more complete than they are.

In particular:

- distinguish reference adapters from production trust systems;
- distinguish a repository-local MCP runtime from a remotely hosted production service;
- never derive economic actor identity from arbitrary MCP tool arguments;
- never claim a payment reference proves final funds movement unless the selected rail provides that guarantee;
- never claim a delivery receipt is verified unless an attributable verifier did so;
- never claim a catalog identifier proves ownership/control;
- keep security and compliance boundaries visible in agent-facing copy;
- prefer publisher-controlled HTTPS domains for future well-known discovery manifests.

## GitHub repository metadata

GitHub repository description and topics materially affect repository search and browsing. Recommended settings after the MCP adapter lands:

**Description**

```text
Open transaction infrastructure and MCP tools for orbital capacity, space logistics, asset registries, delivery proofs, and settlement across the space economy.
```

**Topics**

```text
space-economy
orbital-economy
space-logistics
space-infrastructure
clearinghouse
capacity-market
asset-registry
satellite
settlement
openapi
agent-skill
ai-agents
mcp
model-context-protocol
```

Keep topics accurate: `mcp` becomes appropriate once the callable adapter is on `main`; do not add `a2a` until an actual A2A runtime exists.

## Publication checklist

After the MCP adapter reaches `main`:

1. update GitHub repository description/topics with the MCP search terms above;
2. submit/update the Agent Skill in GitHub Agent Finder;
3. decide whether the MCP adapter should be distributed as npm, MCPB, OCI, or a hosted authenticated remote;
4. add `mcpName` and a validated `server.json` only when that installation target is real;
5. publish through the official MCP Registry using the then-current `mcp-publisher` flow;
6. keep the default MCP runtime read-first and preserve signed write semantics.

When a publisher-controlled project domain exists:

1. publish the project landing/documentation site;
2. expose the Agent Skill and any public API descriptions at stable HTTPS URLs;
3. publish `/.well-known/ard.json` using the then-current ARD schema;
4. include the OpenAPI resource if the HTTP API is publicly callable;
5. include the actual MCP remote/package metadata;
6. add an A2A entry only after that runtime exists;
7. run the relevant conformance tooling;
8. keep identifiers and URLs stable across releases.
