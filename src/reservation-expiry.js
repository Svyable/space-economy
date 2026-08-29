import { sha256Canonical } from './canonical-json.js';

const RESERVED_EVENT = 'spaceeconomy.order.reserved.v1';
const RACE_CODES = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'STALE_VERSION',
  'RESERVATION_NOT_EXPIRABLE',
  'RESERVATION_NOT_DUE',
]);

export class ReservationExpiryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReservationExpiryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new ReservationExpiryError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_CONFIGURATION', `${field} is required`);
  return value.trim();
}

function limit(value) {
  invariant(Number.isSafeInteger(value) && value >= 1 && value <= 1000, 'INVALID_CONFIGURATION', 'batchSize must be an integer from 1 to 1000');
  return value;
}

function instant(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_CONFIGURATION', `${field} must produce a valid date`);
  return date.toISOString();
}

function expiryIdempotencyKey(order) {
  const digest = sha256Canonical({ orderId: order.id, fundingDueAt: order.fundingDueAt });
  return `reservation-expiry:${digest}`;
}

/**
 * Reference due-reservation source using the public append-only ledger plus
 * getOrder(). It is deliberately simple and rebuildable; production deployments
 * can inject an indexed source without changing worker execution semantics.
 */
export class LedgerReservationExpirySource {
  constructor({ market } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    invariant(typeof market.getLedger === 'function', 'INVALID_CONFIGURATION', 'market must provide getLedger()');
    invariant(typeof market.getOrder === 'function', 'INVALID_CONFIGURATION', 'market must provide getOrder()');
    this.market = market;
  }

  async listDue({ now, limit: maxItems }) {
    const nowMillis = Date.parse(now);
    invariant(Number.isFinite(nowMillis), 'INVALID_REQUEST', 'now must be a valid timestamp');
    invariant(Number.isSafeInteger(maxItems) && maxItems >= 1, 'INVALID_REQUEST', 'limit must be a positive safe integer');

    const ledger = await this.market.getLedger();
    const orderIds = [];
    const seen = new Set();
    for (const event of ledger) {
      if (event.type !== RESERVED_EVENT) continue;
      const orderId = event.data?.orderId;
      if (typeof orderId !== 'string' || seen.has(orderId)) continue;
      seen.add(orderId);
      orderIds.push(orderId);
    }

    const due = [];
    for (const orderId of orderIds) {
      let order;
      try {
        order = await this.market.getOrder(orderId);
      } catch (error) {
        if (error?.code === 'NOT_FOUND') continue;
        throw error;
      }
      if (order.status !== 'reserved' || order.fundingDueAt === null) continue;
      if (Date.parse(order.fundingDueAt) > nowMillis) continue;
      due.push(order);
    }

    due.sort((left, right) => {
      const timeOrder = String(left.fundingDueAt).localeCompare(String(right.fundingDueAt));
      if (timeOrder !== 0) return timeOrder;
      return String(left.id).localeCompare(String(right.id));
    });
    return due.slice(0, maxItems).map((order) => structuredClone(order));
  }
}

/**
 * One-shot executor for objectively due unpaid reservation expiry.
 *
 * Scheduling is deliberately external: cron, a queue consumer, Kubernetes CronJob,
 * or another durable orchestrator should call runOnce(). The worker uses the
 * clearinghouse transition as the source of truth, including optimistic version
 * checks and persisted idempotency.
 */
export class ReservationExpiryWorker {
  constructor({
    market,
    source = null,
    actorId = 'system:reservation-expiry',
    batchSize = 100,
    clock = () => new Date(),
  } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    invariant(typeof market.expireOrder === 'function', 'INVALID_CONFIGURATION', 'market must provide expireOrder()');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    if (source !== null) invariant(typeof source.listDue === 'function', 'INVALID_CONFIGURATION', 'source must provide listDue()');

    this.market = market;
    this.source = source ?? new LedgerReservationExpirySource({ market });
    this.actorId = nonEmptyString(actorId, 'actorId');
    this.batchSize = limit(batchSize);
    this.clock = clock;
  }

  async runOnce() {
    const observedAt = instant(this.clock(), 'clock');
    const candidates = await this.source.listDue({ now: observedAt, limit: this.batchSize });
    invariant(Array.isArray(candidates), 'INVALID_EXPIRY_SOURCE', 'expiry source must return an array');
    invariant(candidates.length <= this.batchSize, 'INVALID_EXPIRY_SOURCE', 'expiry source returned more candidates than requested');

    const expired = [];
    const skipped = [];

    for (const candidate of candidates) {
      invariant(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'INVALID_EXPIRY_SOURCE', 'expiry candidate must be an order object');
      invariant(typeof candidate.id === 'string' && candidate.id.length > 0, 'INVALID_EXPIRY_SOURCE', 'expiry candidate id is required');
      invariant(typeof candidate.fundingDueAt === 'string' && candidate.fundingDueAt.length > 0, 'INVALID_EXPIRY_SOURCE', 'expiry candidate fundingDueAt is required');
      invariant(Number.isSafeInteger(candidate.version) && candidate.version > 0, 'INVALID_EXPIRY_SOURCE', 'expiry candidate version is required');

      try {
        const order = await this.market.expireOrder(candidate.id, {
          actorId: this.actorId,
          idempotencyKey: expiryIdempotencyKey(candidate),
          expectedVersion: candidate.version,
        });
        expired.push({ orderId: order.id, version: order.version, expiredAt: order.expiration?.expiredAt ?? null });
      } catch (error) {
        if (RACE_CODES.has(error?.code)) {
          skipped.push({ orderId: candidate.id, code: error.code });
          continue;
        }
        throw error;
      }
    }

    return {
      observedAt,
      scanned: candidates.length,
      expired,
      skipped,
    };
  }
}
