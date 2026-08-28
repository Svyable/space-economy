import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const SIGNED_MUTATION = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

const PROTOCOL_OVERVIEW = `# Space Economy Clearinghouse

A neutral transaction kernel for scarce physical space capability.

Core path:

asset -> capacity offer -> reservation/order -> funding reference -> delivery evidence -> settlement reference

Non-negotiable invariants:

- capacity is conserved;
- quantities are positive integral quanta;
- money uses exact integer arithmetic, never floating point;
- actor identity comes from trusted context, never command payload fields;
- mutations are durably idempotent and use optimistic concurrency;
- funded reservations are not silently cancelled or expired;
- historical hash-chained ledger events are not rewritten by ordinary migrations;
- external payment, credential, proof, compliance, and mission-safety systems remain explicit trust boundaries.

The MCP adapter is read-only unless a SignedCommandExecutor is explicitly injected. When enabled, the only mutation tool accepts a fully signed spaceeconomy.command.v1 envelope and routes it through signature/key verification, policy gates, and the executor's closed operation map.
`;

const EmptyInput = z.object({}).strict();
const ListOffersInput = z.object({
  service: z.string().min(1).optional().describe('Optional exact service identifier to filter offers.'),
  status: z.enum(['open', 'filled']).nullable().optional()
    .describe('Offer status filter. Omit for open offers; pass null to include every status.'),
}).strict();
const OrderInput = z.object({
  orderId: z.string().min(1).describe('Clearinghouse order identifier.'),
}).strict();

const SignedEnvelope = z.object({
  schema: z.literal('spaceeconomy.command.v1'),
  algorithm: z.literal('Ed25519'),
  keyId: z.string().min(1),
  actorId: z.string().min(1),
  audience: z.string().min(1),
  operation: z.string().min(1),
  nonce: z.string().min(1),
  idempotencyKey: z.string().min(1),
  expectedVersion: z.number().int().positive().nullable(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string().min(1),
}).strict();

const ExecuteSignedCommandInput = z.object({
  envelope: SignedEnvelope.describe('Ed25519-signed spaceeconomy.command.v1 intent envelope.'),
  policyContext: z.record(z.string(), z.unknown()).optional()
    .describe('Deployment-supplied context forwarded to configured policy gates.'),
}).strict();

function assertMarket(market) {
  const methods = ['listAssets', 'listOffers', 'getOrder', 'getLedger', 'getRevision', 'verifyLedger'];
  if (!market || typeof market !== 'object') throw new TypeError('market is required');
  for (const method of methods) {
    if (typeof market[method] !== 'function') throw new TypeError(`market must provide ${method}()`);
  }
}

function assertCommandExecutor(commandExecutor) {
  if (commandExecutor === null) return;
  if (!commandExecutor || typeof commandExecutor.execute !== 'function' || typeof commandExecutor.listOperations !== 'function') {
    throw new TypeError('commandExecutor must provide execute() and listOperations()');
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
      code: typeof error?.code === 'string' ? error.code : 'MCP_ADAPTER_ERROR',
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

export function createSpaceEconomyMcpServer({
  market,
  commandExecutor = null,
  name = 'space-economy-clearinghouse',
  version = '0.1.0',
} = {}) {
  assertMarket(market);
  assertCommandExecutor(commandExecutor);

  const server = new McpServer({ name, version });

  server.registerResource(
    'space-economy-protocol',
    'space-economy://protocol/overview',
    {
      title: 'Space Economy Clearinghouse Protocol Overview',
      description: 'Economic invariants and trust boundaries for the clearinghouse transaction substrate.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PROTOCOL_OVERVIEW }],
    }),
  );

  server.registerTool(
    'list_assets',
    {
      title: 'List Space Economy Assets',
      description: 'List registered economic assets such as spacecraft, ground infrastructure, vehicles, depots, or other service-producing systems.',
      inputSchema: EmptyInput,
      annotations: READ_ONLY,
    },
    guarded(async () => result({ assets: await market.listAssets() })),
  );

  server.registerTool(
    'list_offers',
    {
      title: 'List Capacity Offers',
      description: 'List measurable capacity offers, optionally filtered by service and status. Omit status for currently open offers; use null for every status.',
      inputSchema: ListOffersInput,
      annotations: READ_ONLY,
    },
    guarded(async ({ service, status }) => result({
      offers: await market.listOffers({ service, status }),
    })),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get Clearinghouse Order',
      description: 'Read one reservation/order including lifecycle state, exact amount, funding reference, delivery proof record, settlement reference, and expiry data when present.',
      inputSchema: OrderInput,
      annotations: READ_ONLY,
    },
    guarded(async ({ orderId }) => result({ order: await market.getOrder(orderId) })),
  );

  server.registerTool(
    'get_market_status',
    {
      title: 'Get Market Integrity Status',
      description: 'Read clearinghouse revision and tamper-evident ledger integrity/head metadata without returning the full event history.',
      inputSchema: EmptyInput,
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const [revision, valid, ledger] = await Promise.all([
        market.getRevision(),
        market.verifyLedger(),
        market.getLedger(),
      ]);
      const head = ledger.at(-1) ?? null;
      return result({
        revision,
        ledger: {
          valid,
          eventCount: ledger.length,
          headSequence: head?.sequence ?? null,
          headHash: head?.hash ?? null,
          headType: head?.type ?? null,
          headTime: head?.time ?? null,
        },
      });
    }),
  );

  if (commandExecutor !== null) {
    server.registerTool(
      'execute_signed_command',
      {
        title: 'Execute Verified Signed Command',
        description: 'Execute an already-signed spaceeconomy.command.v1 intent. The adapter never accepts raw actor identity for mutations: the injected executor verifies Ed25519 signature/key authorization, applies configured policy, and dispatches only its explicit operation allowlist.',
        inputSchema: ExecuteSignedCommandInput,
        annotations: SIGNED_MUTATION,
      },
      guarded(async ({ envelope, policyContext = {} }) => result({
        execution: await commandExecutor.execute(envelope, { policyContext }),
      })),
    );
  }

  return server;
}

export function createSpaceEconomyMcpHandler(options) {
  return createMcpHandler(() => createSpaceEconomyMcpServer(options));
}
