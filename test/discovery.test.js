import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = path.join(root, '.agents/skills/space-economy-clearinghouse/SKILL.md');
const catalogPath = path.join(root, 'distribution/github-agentfinder/space-economy-clearinghouse.json');
const mcpPackagePath = path.join(root, 'adapters/mcp/package.json');
const mcpRegistryTemplatePath = path.join(root, 'distribution/mcp-registry/server.npm.template.json');
const workspaceMcpPath = path.join(root, '.mcp.json');

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter');
  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-zA-Z0-9-]+):\s*(.*)$/);
    if (field) fields.set(field[1], field[2].trim());
  }
  return fields;
}

test('agent skill exposes stable discovery metadata', async () => {
  const markdown = await fs.readFile(skillPath, 'utf8');
  const fields = frontmatter(markdown);
  assert.equal(fields.get('name'), 'space-economy-clearinghouse');
  const description = fields.get('description');
  assert.ok(description);
  assert.ok(description.length <= 1024);
  for (const keyword of ['space economy', 'orbital capacity', 'space logistics', 'settlement', 'mcp']) {
    assert.match(description.toLowerCase(), new RegExp(keyword.replace(' ', '\\s+')));
  }
  assert.match(markdown, /Capacity is conserved\./);
  assert.match(markdown, /Money is exact and decimal-safe\./);
  assert.match(markdown, /Unpaid reservation expiry requires an explicit due deadline/);
  assert.match(markdown, /adapters\/mcp\/src\/server\.js/);
  assert.match(markdown, /MCP is a transport boundary, not an authorization shortcut\./);
});

test('GitHub Agent Finder entry points at the published skill on main', async () => {
  const entry = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  assert.equal(entry.identifier, 'urn:ai:github.com:Svyable:space-economy:space-economy-clearinghouse');
  assert.equal(entry.mediaType, 'application/ai-skill');
  assert.equal(entry.url, 'https://github.com/Svyable/space-economy/blob/main/.agents/skills/space-economy-clearinghouse/SKILL.md');
  assert.equal(entry.metadata.sourceSet, 'space-economy');
  assert.equal(entry.metadata.repoPath, '.agents/skills/space-economy-clearinghouse/SKILL.md');
  for (const tag of ['space-economy', 'space-logistics', 'mcp', 'model-context-protocol']) {
    assert.ok(entry.tags.includes(tag), `missing Agent Finder tag: ${tag}`);
  }
  assert.match(entry.description.toLowerCase(), /mcp/);
});

test('MCP Registry template matches adapter package identity but package remains publication-locked', async () => {
  const pkg = JSON.parse(await fs.readFile(mcpPackagePath, 'utf8'));
  const registry = JSON.parse(await fs.readFile(mcpRegistryTemplatePath, 'utf8'));
  assert.equal(pkg.private, true, 'adapter must remain protected from accidental npm publication');
  assert.equal(pkg.mcpName, registry.name);
  assert.equal(pkg.name, registry.packages[0].identifier);
  assert.equal(pkg.version, registry.version);
  assert.equal(pkg.version, registry.packages[0].version);
  assert.equal(registry.packages[0].transport.type, 'stdio');
  assert.equal(pkg.bin['space-economy-mcp'], './src/stdio.js');
});

test('workspace MCP discovery exposes only the read-only local tool allowlist', async () => {
  const config = JSON.parse(await fs.readFile(workspaceMcpPath, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['space-economy']);
  const server = config.mcpServers['space-economy'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'npm');
  assert.deepEqual(server.args, ['--prefix', 'adapters/mcp', 'start']);
  assert.equal(server.timeout, 30000);
  assert.deepEqual(server.tools, [
    'list_assets',
    'list_offers',
    'get_order',
    'get_market_status',
  ]);
  assert.ok(!server.tools.includes('*'));
  assert.ok(!server.tools.includes('execute_signed_command'));
  assert.equal(server.env, undefined, 'workspace config must not inject ambient credentials or actor identity');
});

test('coding-agent instructions preserve core economic and trust boundaries', async () => {
  const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  for (const rule of [
    'Money never uses floating-point arithmetic',
    'Funded reservations are not silently cancelled or expired',
    'Historical hash-chained events are not rewritten',
  ]) {
    assert.ok(agents.includes(rule), `missing AGENTS.md rule: ${rule}`);
  }
  assert.match(agents, /expiry restores capacity atomically/);
});

test('supported package subpath exports are importable without deep src imports', async () => {
  for (const specifier of [
    'space-economy-clearinghouse',
    'space-economy-clearinghouse/canonical-json',
    'space-economy-clearinghouse/store',
    'space-economy-clearinghouse/postgres-store',
    'space-economy-clearinghouse/migrations',
    'space-economy-clearinghouse/policy',
    'space-economy-clearinghouse/proofs',
    'space-economy-clearinghouse/settlement',
    'space-economy-clearinghouse/credentials',
    'space-economy-clearinghouse/signed-command',
    'space-economy-clearinghouse/command-executor',
  ]) {
    const module = await import(specifier);
    assert.ok(module && typeof module === 'object', `expected ${specifier} to resolve`);
  }
});
