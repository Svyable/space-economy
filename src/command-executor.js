import { verifyCommand } from './signed-command.js';

const HANDLERS = new Map([
  ['asset.register', async (market, payload, context) => market.registerAsset(payload, context)],
  ['offer.create', async (market, payload, context) => market.createOffer(payload, context)],
  ['order.reserve', async (market, payload, context) => market.createOrder(payload, context)],
  ['order.fund', async (market, payload, context) => {
    const { orderId, ...input } = payload;
    return market.fundOrder(requiredString(orderId, 'payload.orderId'), input, context);
  }],
  ['order.deliver', async (market, payload, context) => {
    const { orderId, ...input } = payload;
    return market.recordDelivery(requiredString(orderId, 'payload.orderId'), input, context);
  }],
  ['order.settle', async (market, payload, context) => {
    const { orderId, ...input } = payload;
    return market.settleOrder(requiredString(orderId, 'payload.orderId'), input, context);
  }],
  ['order.cancel', async (market, payload, context) => (
    market.cancelOrder(requiredString(payload.orderId, 'payload.orderId'), context)
  )],
  ['order.expire', async (market, payload, context) => (
    market.expireOrder(requiredString(payload.orderId, 'payload.orderId'), context)
  )],
]);

export class CommandExecutionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CommandExecutionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new CommandExecutionError(code, message, details);
}

function requiredString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_COMMAND_PAYLOAD', `${field} is required`);
  return value.trim();
}

function plainObject(value, field) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_COMMAND_PAYLOAD', `${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, 'INVALID_COMMAND_PAYLOAD', `${field} must be a plain object`);
  return structuredClone(value);
}

/**
 * Executes transport-neutral signed commands through an explicit operation map.
 *
 * Verification happens inside the executor so callers cannot accidentally pass
 * an unverified envelope to the clearinghouse. Policy gates, when configured,
 * run after cryptographic identity verification and before the domain mutation.
 */
export class SignedCommandExecutor {
  constructor({
    market,
    resolvePublicKey,
    audience,
    policyEngine = null,
    clock = () => new Date(),
    maxClockSkewSeconds = 60,
    maxLifetimeSeconds = 300,
  }) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    invariant(typeof resolvePublicKey === 'function', 'INVALID_CONFIGURATION', 'resolvePublicKey must be a function');
    invariant(typeof audience === 'string' && audience.trim().length > 0, 'INVALID_CONFIGURATION', 'audience is required');
    if (policyEngine !== null) {
      invariant(typeof policyEngine.requireAllowed === 'function', 'INVALID_CONFIGURATION', 'policyEngine must provide requireAllowed()');
    }

    this.market = market;
    this.policyEngine = policyEngine;
    this.verificationOptions = {
      resolvePublicKey,
      audience: audience.trim(),
      clock,
      maxClockSkewSeconds,
      maxLifetimeSeconds,
    };
  }

  listOperations() {
    return [...HANDLERS.keys()].sort();
  }

  async execute(envelope, { policyContext = {} } = {}) {
    const verified = await verifyCommand(envelope, this.verificationOptions);
    const operation = verified.command.operation;
    const handler = HANDLERS.get(operation);
    invariant(handler, 'UNSUPPORTED_OPERATION', `unsupported signed command operation: ${operation}`, {
      operation,
    });

    const payload = plainObject(verified.command.payload, 'payload');
    let policy = null;
    if (this.policyEngine) {
      policy = await this.policyEngine.requireAllowed({
        operation,
        actor: {
          actorId: verified.command.actorId,
          keyId: verified.command.keyId,
          commandHash: verified.commandHash,
        },
        resource: { payload: structuredClone(payload) },
        context: plainObject(policyContext, 'policyContext'),
      });
    }

    const result = await handler(this.market, payload, verified.context);
    return {
      result,
      commandHash: verified.commandHash,
      replay: verified.replay,
      policy,
    };
  }
}
