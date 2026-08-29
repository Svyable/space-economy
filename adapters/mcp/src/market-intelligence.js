import { createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createSpaceEconomyMcpServer } from './server.js';

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const RfqOpportunityInput = z.object({
  sellerId: z.string().min(1).describe('Seller participant identifier whose real offers should be matched against open RFQs.'),
  service: z.string().min(1).optional().describe('Optional exact RFQ service filter.'),
  settlementAsset: z.string().min(1).optional().describe('Optional exact RFQ settlement asset filter.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum actionable RFQ/offer pairs to return. Defaults to the directory setting.'),
}).strict();

const MarketLiquidityInput = z.object({
  service: z.string().min(1).optional().describe('Optional exact service market filter.'),
  settlementAsset: z.string().min(1).optional().describe('Optional exact settlement-asset market filter.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum settlement-asset market rows to return.'),
}).strict();

function assertOpportunityDirectory(directory) {
  if (directory === null) return;
  if (!directory || typeof directory.listOpportunities !== 'function') {
    throw new TypeError('rfqOpportunityDirectory must provide listOpportunities()');
  }
}

function assertLiquidityDirectory(directory) {
  if (directory === null) return;
  if (!directory || typeof directory.snapshot !== 'function') {
    throw new TypeError('marketLiquidityDirectory must provide snapshot()');
  }
}

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(error) {
  const payload = {
    error: {
      code: typeof error?.code === 'string' ? error.code : 'MCP_MARKET_INTELLIGENCE_ERROR',
      detail: error instanceof Error ? error.message : String(error),
    },
  };
  if (error?.details !== undefined) payload.error.details = structuredClone(error.details);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function guarded(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * Optional read-only MCP extension for buyer-demand and market-liquidity evidence.
 *
 * The base MCP server remains unchanged. Tools are registered only when the
 * corresponding read capability is explicitly injected by the deployment.
 */
export function createSpaceEconomyMarketIntelligenceMcpServer({
  rfqOpportunityDirectory = null,
  marketLiquidityDirectory = null,
  ...baseOptions
} = {}) {
  assertOpportunityDirectory(rfqOpportunityDirectory);
  assertLiquidityDirectory(marketLiquidityDirectory);

  const server = createSpaceEconomyMcpServer(baseOptions);

  if (rfqOpportunityDirectory !== null) {
    server.registerTool(
      'find_rfq_opportunities',
      {
        title: 'Find Quoteable RFQ Opportunities',
        description: 'Find open buyer RFQs that the specified seller can currently quote with its real authoritative offers. Results are compatibility evidence ordered operationally by RFQ expiry, not buyer ranking. The tool never submits a quote or reserves capacity.',
        inputSchema: RfqOpportunityInput,
        annotations: READ_ONLY,
      },
      guarded(async (query) => result(await rfqOpportunityDirectory.listOpportunities(query))),
    );
  }

  if (marketLiquidityDirectory !== null) {
    server.registerTool(
      'get_market_liquidity',
      {
        title: 'Get Space Economy Liquidity Evidence',
        description: 'Read revision-stable open supply and RFQ-demand evidence by service/unit/settlement asset. RFQ maximum prices remain labeled as ceilings, not executable bids; the tool exposes no spread, fair value, ranking, or recommended price.',
        inputSchema: MarketLiquidityInput,
        annotations: READ_ONLY,
      },
      guarded(async (query) => result(await marketLiquidityDirectory.snapshot(query))),
    );
  }

  return server;
}

export function createSpaceEconomyMarketIntelligenceMcpHandler(options) {
  return createMcpHandler(() => createSpaceEconomyMarketIntelligenceMcpServer(options));
}
