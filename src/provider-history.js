const clone = (value) => structuredClone(value);

export class ProviderHistoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProviderHistoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new ProviderHistoryError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function positiveInteger(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= max, 'INVALID_REQUEST', `${field} must be a positive safe integer no greater than ${max}`);
  return value;
}

function addExactMoney(bucket, money) {
  const existing = bucket.get(money.settlementAsset) ?? { amount: 0n, scale: money.scale };
  const scale = Math.max(existing.scale, money.scale);
  const left = existing.amount * (10n ** BigInt(scale - existing.scale));
  const right = BigInt(money.amount) * (10n ** BigInt(scale - money.scale));
  bucket.set(money.settlementAsset, { amount: left + right, scale });
}

function moneyBuckets(bucket) {
  return [...bucket.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([settlementAsset, value]) => ({
      settlementAsset,
      amount: value.amount.toString(),
      scale: value.scale,
    }));
}

function emptyLatency() {
  return { count: 0, totalMs: 0, minMs: null, maxMs: null };
}

function addLatency(bucket, from, to) {
  if (!from || !to) return;
  const milliseconds = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  bucket.count += 1;
  bucket.totalMs += milliseconds;
  bucket.minMs = bucket.minMs === null ? milliseconds : Math.min(bucket.minMs, milliseconds);
  bucket.maxMs = bucket.maxMs === null ? milliseconds : Math.max(bucket.maxMs, milliseconds);
}

function publicLatency(bucket) {
  return {
    count: bucket.count,
    averageMs: bucket.count === 0 ? null : Math.round(bucket.totalMs / bucket.count),
    minMs: bucket.minMs,
    maxMs: bucket.maxMs,
  };
}

function emptyAggregate(sellerId, service) {
  return {
    sellerId,
    service,
    orders: {
      total: 0,
      reserved: 0,
      funded: 0,
      delivered: 0,
      settled: 0,
      cancelled: 0,
      expired: 0,
    },
    quantities: {
      contracted: 0,
      settled: 0,
      cancelled: 0,
      expired: 0,
    },
    contractedTotals: new Map(),
    settledTotals: new Map(),
    timing: {
      funding: emptyLatency(),
      delivery: emptyLatency(),
      settlement: emptyLatency(),
    },
    firstOrderAt: null,
    lastOrderAt: null,
    lastSettledAt: null,
    lastTerminalAt: null,
  };
}

function terminalTimestamp(order) {
  if (order.status === 'settled') return order.settlement?.settledAt ?? order.updatedAt;
  if (order.status === 'cancelled' || order.status === 'expired') return order.updatedAt;
  return null;
}

function addOrder(aggregate, order) {
  aggregate.orders.total += 1;
  aggregate.orders[order.status] = (aggregate.orders[order.status] ?? 0) + 1;
  aggregate.quantities.contracted += order.quantity;
  if (order.status === 'settled') aggregate.quantities.settled += order.quantity;
  if (order.status === 'cancelled') aggregate.quantities.cancelled += order.quantity;
  if (order.status === 'expired') aggregate.quantities.expired += order.quantity;
  addExactMoney(aggregate.contractedTotals, order.total);
  if (order.status === 'settled') addExactMoney(aggregate.settledTotals, order.total);

  aggregate.firstOrderAt = aggregate.firstOrderAt === null || order.createdAt < aggregate.firstOrderAt
    ? order.createdAt
    : aggregate.firstOrderAt;
  aggregate.lastOrderAt = aggregate.lastOrderAt === null || order.createdAt > aggregate.lastOrderAt
    ? order.createdAt
    : aggregate.lastOrderAt;
  if (order.status === 'settled') {
    const settledAt = order.settlement?.settledAt ?? order.updatedAt;
    aggregate.lastSettledAt = aggregate.lastSettledAt === null || settledAt > aggregate.lastSettledAt
      ? settledAt
      : aggregate.lastSettledAt;
  }
  const terminalAt = terminalTimestamp(order);
  if (terminalAt !== null) {
    aggregate.lastTerminalAt = aggregate.lastTerminalAt === null || terminalAt > aggregate.lastTerminalAt
      ? terminalAt
      : aggregate.lastTerminalAt;
  }

  addLatency(aggregate.timing.funding, order.createdAt, order.funding?.recordedAt);
  addLatency(aggregate.timing.delivery, order.createdAt, order.deliveryProof?.recordedAt);
  addLatency(aggregate.timing.settlement, order.createdAt, order.settlement?.settledAt);
}

function finalizeAggregate(aggregate, revision, ledgerValid) {
  const terminalCount = aggregate.orders.settled + aggregate.orders.cancelled + aggregate.orders.expired;
  return {
    sellerId: aggregate.sellerId,
    service: aggregate.service,
    revision,
    ledgerValid,
    orders: clone(aggregate.orders),
    terminalOutcomes: {
      total: terminalCount,
      settled: aggregate.orders.settled,
      cancelled: aggregate.orders.cancelled,
      expired: aggregate.orders.expired,
    },
    quantities: clone(aggregate.quantities),
    contractedTotals: moneyBuckets(aggregate.contractedTotals),
    settledTotals: moneyBuckets(aggregate.settledTotals),
    timing: {
      funding: publicLatency(aggregate.timing.funding),
      delivery: publicLatency(aggregate.timing.delivery),
      settlement: publicLatency(aggregate.timing.settlement),
    },
    firstOrderAt: aggregate.firstOrderAt,
    lastOrderAt: aggregate.lastOrderAt,
    lastSettledAt: aggregate.lastSettledAt,
    lastTerminalAt: aggregate.lastTerminalAt,
  };
}

/**
 * Read-only provider execution history derived from clearinghouse orders.
 *
 * This deliberately publishes attributable evidence/metrics instead of one
 * protocol-owned reputation score. Marketplaces and agents can apply their own
 * risk models without making the clearinghouse choose winners or encode hidden
 * ranking policy.
 */
export class ProviderHistoryDirectory {
  constructor({ market, maxRevisionRetries = 3 } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'getLedger', 'verifyLedger', 'getOrder']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(Number.isSafeInteger(maxRevisionRetries) && maxRevisionRetries >= 1 && maxRevisionRetries <= 20, 'INVALID_CONFIGURATION', 'maxRevisionRetries must be an integer from 1 to 20');
    this.market = market;
    this.maxRevisionRetries = maxRevisionRetries;
  }

  async getProviderHistory({ sellerId, service }) {
    const normalizedSellerId = nonEmptyString(sellerId, 'sellerId');
    const normalizedService = nonEmptyString(service, 'service');
    const snapshot = await this.#stableOrders();
    const orders = snapshot.orders.filter((order) => order.sellerId === normalizedSellerId && order.service === normalizedService);
    invariant(orders.length > 0, 'NOT_FOUND', 'no order history found for seller/service');
    const aggregate = emptyAggregate(normalizedSellerId, normalizedService);
    for (const order of orders) addOrder(aggregate, order);
    return finalizeAggregate(aggregate, snapshot.revision, snapshot.ledgerValid);
  }

  async listProviderHistories({ service = null, minOrders = 1, limit = 50 } = {}) {
    const normalizedService = service === null ? null : nonEmptyString(service, 'service');
    positiveInteger(minOrders, 'minOrders');
    positiveInteger(limit, 'limit', { max: 500 });
    const snapshot = await this.#stableOrders();
    const aggregates = new Map();
    for (const order of snapshot.orders) {
      if (normalizedService !== null && order.service !== normalizedService) continue;
      const key = `${order.sellerId}\u0000${order.service}`;
      const aggregate = aggregates.get(key) ?? emptyAggregate(order.sellerId, order.service);
      addOrder(aggregate, order);
      aggregates.set(key, aggregate);
    }
    return [...aggregates.values()]
      .filter((aggregate) => aggregate.orders.total >= minOrders)
      .sort((left, right) => left.sellerId.localeCompare(right.sellerId) || left.service.localeCompare(right.service))
      .slice(0, limit)
      .map((aggregate) => finalizeAggregate(aggregate, snapshot.revision, snapshot.ledgerValid));
  }

  async #stableOrders() {
    for (let attempt = 0; attempt < this.maxRevisionRetries; attempt += 1) {
      const before = await this.market.getRevision();
      const ledgerValid = await this.market.verifyLedger();
      invariant(ledgerValid, 'LEDGER_INTEGRITY_FAILED', 'clearinghouse ledger integrity verification failed');
      const ledger = await this.market.getLedger();
      const orderIds = [...new Set(ledger
        .map((event) => event?.data?.orderId)
        .filter((orderId) => typeof orderId === 'string' && orderId.length > 0))]
        .sort();
      const orders = await Promise.all(orderIds.map((orderId) => this.market.getOrder(orderId)));
      const after = await this.market.getRevision();
      if (before === after) return { revision: after, ledgerValid, orders };
    }
    throw new ProviderHistoryError('HISTORY_CHANGED', 'market changed repeatedly while provider history was being assembled');
  }
}
