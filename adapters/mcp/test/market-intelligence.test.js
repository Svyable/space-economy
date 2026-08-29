import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Clearinghouse } from '../../../src/clearinghouse.js';
import {
  createSpaceEconomyMarketIntelligenceMcpHandler,
  createSpaceEconomyMarketIntelligenceMcpServer,
} from '../src/market-intelligence.js';

async function connect(options) {
  const handler = createSpaceEconomyMarketIntelligenceMcpHandler(options);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'space-economy-market-intelligence-test', version: '1.0.0' });
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

test('extension adds no tools unless read capabilities are explicitly injected', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({ market });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['find_capacity', 'get_market_status', 'get_order', 'list_assets', 'list_offers']);
    assert.ok(!names.includes('find_rfq_opportunities'));
    assert.ok(!names.includes('get_market_liquidity'));
  } finally {
    await close(client, transport);
  }
});

test('RFQ opportunity tool is opt-in, read-only, and forwards bounded seller discovery', async () => {
  const market = await Clearinghouse.open();
  const calls = [];
  const rfqOpportunityDirectory = {
    listOpportunities: async (query) => {
      calls.push(structuredClone(query));
      return {
        sellerId: query.sellerId,
        rfqRevision: 8,
        marketRevision: 21,
        generatedAt: '2026-08-29T18:00:00.000Z',
        total: 1,
        hasMore: false,
        opportunities: [{ rfqId: 'rfq-1', offerId: 'offer-1', sellerId: query.sellerId }],
      };
    },
  };

  const { client, transport } = await connect({ market, rfqOpportunityDirectory });
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((item) => item.name === 'find_rfq_opportunities');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);

    const output = structured(await client.callTool({
      name: 'find_rfq_opportunities',
      arguments: {
        sellerId: 'seller-a',
        service: 'data-relay',
        settlementAsset: 'iso4217:USD',
        limit: 20,
      },
    }));
    assert.equal(output.total, 1);
    assert.equal(output.opportunities[0].rfqId, 'rfq-1');
    assert.deepEqual(calls, [{
      sellerId: 'seller-a',
      service: 'data-relay',
      settlementAsset: 'iso4217:USD',
      limit: 20,
    }]);
  } finally {
    await close(client, transport);
  }
});

test('liquidity tool is opt-in, read-only, and preserves evidence labels', async () => {
  const market = await Clearinghouse.open();
  const calls = [];
  const marketLiquidityDirectory = {
    snapshot: async (query) => {
      calls.push(structuredClone(query));
      return {
        marketRevision: 12,
        rfqRevision: 4,
        generatedAt: '2026-08-29T18:00:00.000Z',
        totalMarkets: 1,
        hasMore: false,
        markets: [{
          service: 'orbital-compute',
          unit: 'compute-second',
          settlementAsset: 'iso4217:USD',
          supply: { offerCount: 1, remainingQuantity: '10', unitPriceRange: null },
          constrainedDemand: {
            rfqCount: 2,
            quantity: '25',
            pricedRfqCount: 0,
            pricedQuantity: '0',
            maxUnitPriceCeilingRange: null,
          },
          constrainedBalance: '-15',
        }],
        unconstrainedDemand: [],
      };
    },
  };

  const { client, transport } = await connect({ market, marketLiquidityDirectory });
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((item) => item.name === 'get_market_liquidity');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.match(tool.description, /ceilings, not executable bids/i);

    const output = structured(await client.callTool({
      name: 'get_market_liquidity',
      arguments: { service: 'orbital-compute', limit: 10 },
    }));
    assert.equal(output.markets[0].constrainedBalance, '-15');
    assert.equal('spread' in output.markets[0], false);
    assert.equal('fairValue' in output.markets[0], false);
    assert.deepEqual(calls, [{ service: 'orbital-compute', limit: 10 }]);
  } finally {
    await close(client, transport);
  }
});

test('both market-intelligence tools can coexist without enabling signed mutation', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({
    market,
    rfqOpportunityDirectory: { listOpportunities: async () => ({ opportunities: [] }) },
    marketLiquidityDirectory: { snapshot: async () => ({ markets: [] }) },
  });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.ok(names.includes('find_rfq_opportunities'));
    assert.ok(names.includes('get_market_liquidity'));
    assert.ok(!names.includes('execute_signed_command'));
  } finally {
    await close(client, transport);
  }
});

test('directory failures become attributable MCP tool errors', async () => {
  const market = await Clearinghouse.open();
  const { client, transport } = await connect({
    market,
    rfqOpportunityDirectory: {
      listOpportunities: async () => {
        const error = new Error('sources kept changing');
        error.code = 'OPPORTUNITIES_CHANGED';
        error.details = { retries: 3 };
        throw error;
      },
    },
  });
  try {
    const failed = await client.callTool({
      name: 'find_rfq_opportunities',
      arguments: { sellerId: 'seller-a' },
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.error.code, 'OPPORTUNITIES_CHANGED');
    assert.deepEqual(failed.structuredContent.error.details, { retries: 3 });
  } finally {
    await close(client, transport);
  }
});

test('invalid injected capabilities fail at server construction', async () => {
  const market = await Clearinghouse.open();
  assert.throws(
    () => createSpaceEconomyMarketIntelligenceMcpServer({ market, rfqOpportunityDirectory: {} }),
    /listOpportunities/,
  );
  assert.throws(
    () => createSpaceEconomyMarketIntelligenceMcpServer({ market, marketLiquidityDirectory: {} }),
    /snapshot/,
  );
});
