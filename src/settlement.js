import { sha256Canonical } from './canonical-json.js';

const clone = (value) => structuredClone(value);
const RECEIPT_STATUS = new Set(['confirmed', 'pending', 'rejected']);

export class SettlementAdapterError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SettlementAdapterError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new SettlementAdapterError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_SETTLEMENT_REQUEST', `${field} is required`);
  return value.trim();
}

function normalizeAmount(value, field = 'amount') {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_SETTLEMENT_REQUEST', `${field} is required`);
  const settlementAsset = nonEmptyString(value.settlementAsset, `${field}.settlementAsset`);
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_SETTLEMENT_REQUEST', `${field}.amount must be an unsigned integer string`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_SETTLEMENT_REQUEST', `${field}.scale must be an integer from 0 to 18`);
  return { settlementAsset, amount: value.amount, scale: value.scale };
}

function normalizeAdapter(settlementAsset, adapter) {
  invariant(adapter && typeof adapter === 'object' && !Array.isArray(adapter), 'INVALID_ADAPTER', 'adapter must be an object');
  const adapterId = nonEmptyString(adapter.adapterId, 'adapter.adapterId');
  const adapterVersion = nonEmptyString(adapter.adapterVersion, 'adapter.adapterVersion');
  invariant(typeof adapter.fund === 'function', 'INVALID_ADAPTER', 'adapter.fund must be a function');
  invariant(typeof adapter.settle === 'function', 'INVALID_ADAPTER', 'adapter.settle must be a function');
  if (adapter.refund !== undefined) invariant(typeof adapter.refund === 'function', 'INVALID_ADAPTER', 'adapter.refund must be a function when provided');
  return {
    settlementAsset,
    adapterId,
    adapterVersion,
    fund: adapter.fund,
    settle: adapter.settle,
    refund: adapter.refund ?? null,
  };
}

function normalizeReceipt(raw, descriptor, operation, amount, occurredAt) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_ADAPTER_RESULT', 'settlement adapter must return a receipt object');
  invariant(RECEIPT_STATUS.has(raw.status), 'INVALID_ADAPTER_RESULT', 'receipt status must be confirmed, pending, or rejected');
  const reference = nonEmptyString(raw.reference, 'receipt.reference');
  const receipt = {
    operation,
    status: raw.status,
    reference,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    amount: clone(amount),
    occurredAt,
  };
  if (raw.reason !== undefined) receipt.reason = nonEmptyString(raw.reason, 'receipt.reason');
  if (raw.metadata !== undefined) {
    invariant(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata), 'INVALID_ADAPTER_RESULT', 'receipt.metadata must be an object');
    receipt.metadata = clone(raw.metadata);
  }
  receipt.receiptHash = `sha256:${sha256Canonical(receipt)}`;
  return receipt;
}

/**
 * Registry for external funding/settlement rails.
 *
 * The registry deliberately does not mutate clearinghouse orders. External rail
 * side effects and clearinghouse state commits cannot generally share one ACID
 * transaction, so callers must use stable idempotency keys and reconcile the
 * resulting receipt into the clearinghouse separately.
 */
export class SettlementAdapterRegistry {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.adapters = new Map();
  }

  register(settlementAsset, adapter) {
    const asset = nonEmptyString(settlementAsset, 'settlementAsset');
    invariant(!this.adapters.has(asset), 'ADAPTER_EXISTS', `settlement adapter already registered for ${asset}`);
    this.adapters.set(asset, normalizeAdapter(asset, adapter));
    return this;
  }

  has(settlementAsset) {
    return this.adapters.has(settlementAsset);
  }

  listSettlementAssets() {
    return [...this.adapters.keys()].sort();
  }

  async fund({ order, idempotencyKey, context = {} }) {
    const { descriptor, amount } = this.#resolve(order);
    const key = nonEmptyString(idempotencyKey, 'idempotencyKey');
    const occurredAt = this.#now();
    const raw = await descriptor.fund({
      order: clone(order),
      amount: clone(amount),
      idempotencyKey: key,
      context: clone(context),
    });
    return normalizeReceipt(raw, descriptor, 'fund', amount, occurredAt);
  }

  async settle({ order, fundingReference, idempotencyKey, context = {} }) {
    const { descriptor, amount } = this.#resolve(order);
    const key = nonEmptyString(idempotencyKey, 'idempotencyKey');
    const funding = nonEmptyString(fundingReference, 'fundingReference');
    const occurredAt = this.#now();
    const raw = await descriptor.settle({
      order: clone(order),
      amount: clone(amount),
      fundingReference: funding,
      idempotencyKey: key,
      context: clone(context),
    });
    return normalizeReceipt(raw, descriptor, 'settle', amount, occurredAt);
  }

  async refund({ order, settlementReference, idempotencyKey, context = {} }) {
    const { descriptor, amount } = this.#resolve(order);
    invariant(descriptor.refund, 'REFUND_UNSUPPORTED', `settlement adapter for ${amount.settlementAsset} does not support refunds`);
    const key = nonEmptyString(idempotencyKey, 'idempotencyKey');
    const settlement = nonEmptyString(settlementReference, 'settlementReference');
    const occurredAt = this.#now();
    const raw = await descriptor.refund({
      order: clone(order),
      amount: clone(amount),
      settlementReference: settlement,
      idempotencyKey: key,
      context: clone(context),
    });
    return normalizeReceipt(raw, descriptor, 'refund', amount, occurredAt);
  }

  #resolve(order) {
    invariant(order && typeof order === 'object' && !Array.isArray(order), 'INVALID_SETTLEMENT_REQUEST', 'order is required');
    const amount = normalizeAmount(order.total, 'order.total');
    const descriptor = this.adapters.get(amount.settlementAsset);
    invariant(descriptor, 'UNSUPPORTED_SETTLEMENT_ASSET', `no settlement adapter registered for ${amount.settlementAsset}`);
    return { descriptor, amount };
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}
