import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Clearinghouse } from '../../../src/clearinghouse.js';
import { SignedCommandExecutor } from '../../../src/command-executor.js';
import { signCommand } from '../../../src/signed-command.js';
import { createSpaceEconomyMcpHandler } from '../src/server.js';

async function connect(options) {
  const handler = createSpaceEconomyMcpHandler(options);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'space-economy-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function close(client, transport) {
  await client.close();
  await transport.close?.();
}

function structured(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent;
}

test('read-first server advertises only inspection tools by default', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({ market });
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['get_market_status', 'get_order', 'list_assets', 'list_offers']);
    assert.ok(!names.includes('execute_signed_command'));
    assert.ok(!names.includes('register_asset'));

    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.openWorldHint, false);
    }
  } finally {
    await close(client, transport);
  }
});

test('modern Streamable HTTP client can inspect assets, offers, orders, and ledger status', async () => {
  const market = await Clearinghouse.open();
  const asset = await market.registerAsset({ name: 'Relay A', type: 'communications-satellite' }, { actorId: 'relay-one' });
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '15', scale: 2 },
    capacity: 100,
  }, { actorId: 'relay-one' });
  const order = await market.createOrder({ offerId: offer.id, quantity: 20 }, { actorId: 'buyer-one' });

  const { client, transport } = await connect({ market });
  try {
    const assets = structured(await client.callTool({ name: 'list_assets', arguments: {} }));
    assert.equal(assets.assets.length, 1);
    assert.equal(assets.assets[0].id, asset.id);

    const offers = structured(await client.callTool({ name: 'list_offers', arguments: { service: 'data-relay' } }));
    assert.equal(offers.offers.length, 1);
    assert.equal(offers.offers[0].id, offer.id);
    assert.equal(offers.offers[0].remaining, 80);

    const fetched = structured(await client.callTool({ name: 'get_order', arguments: { orderId: order.id } }));
    assert.equal(fetched.order.id, order.id);
    assert.equal(fetched.order.status, 'reserved');

    const status = structured(await client.callTool({ name: 'get_market_status', arguments: {} }));
    assert.equal(status.revision, 3);
    assert.equal(status.ledger.valid, true);
    assert.equal(status.ledger.eventCount, 3);
    assert.match(status.ledger.headHash, /^sha256:/);
  } finally {
    await close(client, transport);
  }
});

test('protocol overview is exposed as an MCP resource', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({ market });
  try {
    const listed = await client.listResources();
    assert.ok(listed.resources.some((resource) => resource.uri === 'space-economy://protocol/overview'));

    const resource = await client.readResource({ uri: 'space-economy://protocol/overview' });
    assert.equal(resource.contents.length, 1);
    assert.match(resource.contents[0].text, /capacity is conserved/i);
    assert.match(resource.contents[0].text, /read-only unless a SignedCommandExecutor is explicitly injected/i);
  } finally {
    await close(client, transport);
  }
});

test('domain failures are returned as attributable MCP tool errors', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({ market });
  try {
    const missing = await client.callTool({ name: 'get_order', arguments: { orderId: 'missing' } });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, 'NOT_FOUND');
    assert.match(missing.structuredContent.error.detail, /order not found/);
  } finally {
    await close(client, transport);
  }
});

test('write surface appears only with a verified signed-command executor and remains idempotent', async () => {
  const market = await Clearinghouse.open();
  const keys = generateKeyPairSync('ed25519');
  const audience = 'urn:space-economy:mcp:test';
  const verificationClock = () => new Date('2026-08-27T22:00:30.000Z');
  const commandExecutor = new SignedCommandExecutor({
    market,
    audience,
    clock: verificationClock,
    maxClockSkewSeconds: 0,
    resolvePublicKey: async ({ actorId, keyId }) => (
      actorId === 'relay-one' && keyId === 'participant:relay-one#key-1' ? keys.publicKey : null
    ),
  });

  const envelope = signCommand({
    keyId: 'participant:relay-one#key-1',
    actorId: 'relay-one',
    audience,
    operation: 'asset.register',
    nonce: 'mcp-register-001',
    idempotencyKey: 'mcp-register-001',
    expectedVersion: null,
    createdAt: '2026-08-27T22:00:00Z',
    expiresAt: '2026-08-27T22:01:00Z',
    payload: { name: 'Agent Relay', type: 'communications-satellite' },
  }, { privateKey: keys.privateKey });

  const { client, transport } = await connect({ market, commandExecutor });
  try {
    const listed = await client.listTools();
    const writeTool = listed.tools.find((tool) => tool.name === 'execute_signed_command');
    assert.ok(writeTool);
    assert.equal(writeTool.annotations?.readOnlyHint, false);
    assert.equal(writeTool.annotations?.destructiveHint, true);
    assert.equal(writeTool.annotations?.idempotentHint, true);

    const first = structured(await client.callTool({
      name: 'execute_signed_command',
      arguments: { envelope },
    }));
    const second = structured(await client.callTool({
      name: 'execute_signed_command',
      arguments: { envelope },
    }));

    assert.equal(first.execution.result.id, second.execution.result.id);
    assert.equal(first.execution.result.ownerId, 'relay-one');
    assert.equal((await market.listAssets()).length, 1);
    assert.equal(await market.getRevision(), 1);
  } finally {
    await close(client, transport);
  }
});
