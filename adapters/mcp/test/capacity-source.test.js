import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Clearinghouse } from '../../../src/clearinghouse.js';
import { createSpaceEconomyMcpHandler } from '../src/server.js';

async function connect(options) {
  const handler = createSpaceEconomyMcpHandler(options);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'capacity-source-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('MCP find_capacity can use an injected projection without changing other read tools', async () => {
  const market = await Clearinghouse.open();
  const source = {
    async search({ filters }) {
      assert.equal(filters.service, 'projected-relay');
      return {
        revision: 23,
        items: [{
          offer: { id: 'projected-offer', service: 'projected-relay' },
          asset: { id: 'projected-asset', type: 'relay' },
        }],
        hasMore: false,
      };
    },
  };

  const { client, transport } = await connect({ market, capacitySource: source });
  try {
    const capacity = await client.callTool({
      name: 'find_capacity',
      arguments: { service: 'projected-relay' },
    });
    assert.equal(capacity.isError, undefined);
    assert.equal(capacity.structuredContent.revision, 23);
    assert.equal(capacity.structuredContent.capacity[0].offer.id, 'projected-offer');

    const assets = await client.callTool({ name: 'list_assets', arguments: {} });
    assert.deepEqual(assets.structuredContent.assets, []);
  } finally {
    await client.close();
    await transport.close?.();
  }
});
