# Agent discovery

Space Economy should be easy for both **coding agents** and **runtime discovery agents** to find without pretending the project exposes protocols it does not yet implement.

## What is published now

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
- policy boundaries for licensing, insurance, compliance, and mission safety.

The skill teaches agents how to apply the clearinghouse architecture and where to read deeper protocol documentation.

### GitHub Agent Finder catalog entry

`distribution/github-agentfinder/space-economy-clearinghouse.json` matches the contributor format currently documented by GitHub's public `github/agentfinder-catalog` repository.

After the Agent Skill exists on `main`, copy that JSON file to:

```text
catalog/Svyable/space-economy-clearinghouse.json
```

in a fork of `github/agentfinder-catalog` and open a pull request there.

The catalog entry deliberately identifies this resource as `application/ai-skill`. The repository is not currently advertised as an MCP server or A2A server.

## ARD: the web-scale discovery path

Agentic Resource Discovery (ARD) is an emerging open discovery layer for MCP servers, A2A agents, skills, APIs, and other callable agentic resources.

The current ARD proposal uses a publisher-owned well-known manifest at:

```text
https://<publisher-domain>/.well-known/ard.json
```

Earlier versions used `/.well-known/ai-catalog.json`; current consumers may support it for compatibility, but new publication should follow the current ARD specification.

This repository does **not** currently claim to publish an ARD well-known manifest because `github.com/Svyable/space-economy` is not a publisher-controlled domain path. A future project website/domain can publish the Agent Skill, OpenAPI description, MCP server card, or A2A agent card as ARD entries from a proper domain anchor.

Until then, GitHub Agent Finder's community catalog is the practical discovery route for the public skill.

## A2A and MCP

These are execution/discovery-adjacent protocols, not labels to add for marketing.

### A2A

If Space Economy later exposes a remote agent that can negotiate or execute clearinghouse tasks, publish an A2A Agent Card at the standard well-known location on that agent's domain:

```text
/.well-known/agent-card.json
```

Only do this once an actual A2A server exists.

### MCP

If the project later publishes an MCP server wrapping clearinghouse operations, give it a narrow tool surface and publish it through the Official MCP Registry and/or ARD catalogs.

Do not expose reflective access to arbitrary clearinghouse methods. Tools should map to explicit operations such as asset registration, offer publication, reservation, funding-reference recording, delivery evidence, settlement-reference recording, objective unpaid-reservation expiry, and read-only inspection.

## Search language

When writing repository descriptions, skill metadata, catalog descriptions, or future website copy, prefer concrete task language over slogans.

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
- transaction substrate for autonomous agents and space businesses.

Avoid broad terms such as "AI platform" or "space marketplace" when they hide the actual capability.

## Trust and discoverability

Discovery metadata is an attack surface. Agent-facing descriptions must not make capabilities sound safer or more complete than they are.

In particular:

- distinguish reference adapters from production trust systems;
- never claim a payment reference proves final funds movement unless the selected rail provides that guarantee;
- never claim a delivery receipt is verified unless an attributable verifier did so;
- never claim a catalog identifier proves ownership/control;
- keep security and compliance boundaries visible in agent-facing copy;
- prefer publisher-controlled HTTPS domains for future well-known discovery manifests.

## GitHub repository metadata

GitHub repository description and topics materially affect repository search and browsing. Recommended settings:

**Description**

```text
Open transaction infrastructure for orbital capacity, space logistics, asset registries, delivery proofs, and settlement across the space economy.
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
```

Keep topics accurate: do not add `mcp` or `a2a` until an actual runtime implementing those protocols exists.

## Future checklist

When a publisher-controlled project domain exists:

1. publish the project landing/documentation site;
2. expose the Agent Skill at a stable HTTPS URL;
3. publish `/.well-known/ard.json` using the then-current ARD schema;
4. include the OpenAPI resource as an ARD entry if the API is publicly callable;
5. add A2A/MCP entries only after those runtimes actually exist;
6. run the official ARD conformance tooling;
7. submit/index the resources in relevant public registries;
8. keep identifiers and URLs stable across releases.
