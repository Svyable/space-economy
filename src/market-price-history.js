const clone = (value) => structuredClone(value);

export class MarketPriceHistoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MarketPriceHistoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MarketPriceHistoryError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function positiveInteger(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= max, 'INVALID_REQUEST', `${field} must be a positive safe integer no greater than ${max}`);
  return value;
}

function optionalTimestamp(value, field) {
  if (value === null || value === undefined) return null;
  invariant(typeof value === 'string' || value instanceof Date, 'INVALID_REQUEST', `${field} must be a timestamp`);
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_REQUEST', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function settledAt(order) {
  return order.settlement?.settledAt ?? order.updatedAt;
}

function scaleAmount(money, scale) {
  return BigInt(money.amount) * (10n ** BigInt(scale - money.scale));
}

function normalizedMoney(settlementAsset, amount, scale) {
  return { settlementAsset, amount: amount.toString(), scale };
}

function medianRational(values, settlementAsset, scale) {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return {
      settlementAsset,
      amountNumerator: sorted[middle].toString(),
      amountDenominator: '1',
      scale,
    };
  }
  return {
    settlementAsset,
    amountNumerator: (sorted[middle - 1] + sorted[middle]).toString(),
    amountDenominator: '2',
    scale,
  };
}

function benchmarkFromOrders(orders, revision, ledgerValid) {
  const first = orders[0];
  const scale = Math.max(...orders.map((order) => order.unitPrice.scale));
  const prices = orders.map((order) => scaleAmount(order.unitPrice, scale));
  let settledQuantity = 0;
  let notional = 0n;
  let firstSettledAt = null;
  let lastSettledAt = null;

  for (const order of orders) {
    settledQuantity += order.quantity;
    notional += scaleAmount(order.total, scale);
    const timestamp = settledAt(order);
    firstSettledAt = firstSettledAt === null || timestamp < firstSettledAt ? timestamp : firstSettledAt;
    lastSettledAt = lastSettledAt === null || timestamp > lastSettledAt ? timestamp : lastSettledAt;
  }

  const low = prices.reduce((left, right) => (left < right ? left : right));
  const high = prices.reduce((left, right) => (left > right ? left : right));

  return {
    service: first.service,
    unit: first.unit,
    settlementAsset: first.unitPrice.settlementAsset,
    revision,
    ledgerValid,
    observations: orders.length,
    settledQuantity,
    unitPrice: {
      low: normalizedMoney(first.unitPrice.settlementAsset, low, scale),
      high: normalizedMoney(first.unitPrice.settlementAsset, high, scale),
      median: medianRational(prices, first.unitPrice.settlementAsset, scale),
    },
    settledNotional: normalizedMoney(first.unitPrice.settlementAsset, notional, scale),
    firstSettledAt,
    lastSettledAt,
  };
}

/**
 * Revision-stable settled price evidence by service/unit/settlement asset.
 *
 * Only orders that actually reached `settled` are observations. The directory
 * reports exact historical evidence and deliberately does not publish a fair
 * value, forecast, provider ranking, or executable price oracle.
 */
export class MarketPriceHistoryDirectory {
  constructor({ market, maxRevisionRetries = 3 } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'getLedger', 'verifyLedger', 'getOrder']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(Number.isSafeInteger(maxRevisionRetries) && maxRevisionRetries >= 1 && maxRevisionRetries <= 20, 'INVALID_CONFIGURATION', 'maxRevisionRetries must be an integer from 1 to 20');
    this.market = market;
    this.maxRevisionRetries = maxRevisionRetries;
  }

  async getBenchmark({ service, unit, settlementAsset, since = null, until = null }) {
    const normalized = this.#normalizeFilters({ service, unit, settlementAsset, since, until, requireAll: true });
    const snapshot = await this.#stableSettledOrders();
    const orders = this.#filter(snapshot.orders, normalized);
    invariant(orders.length > 0, 'NOT_FOUND', 'no settled price history found for requested market');
    return benchmarkFromOrders(orders, snapshot.revision, snapshot.ledgerValid);
  }

  async listBenchmarks({
    service = null,
    unit = null,
    settlementAsset = null,
    since = null,
    until = null,
    minObservations = 1,
    limit = 100,
  } = {}) {
    positiveInteger(minObservations, 'minObservations');
    positiveInteger(limit, 'limit', { max: 500 });
    const normalized = this.#normalizeFilters({ service, unit, settlementAsset, since, until, requireAll: false });
    const snapshot = await this.#stableSettledOrders();
    const filtered = this.#filter(snapshot.orders, normalized);
    const groups = new Map();
    for (const order of filtered) {
      const key = `${order.service}\u0000${order.unit}\u0000${order.unitPrice.settlementAsset}`;
      const group = groups.get(key) ?? [];
      group.push(order);
      groups.set(key, group);
    }
    return [...groups.values()]
      .filter((orders) => orders.length >= minObservations)
      .sort((left, right) => {
        const a = left[0];
        const b = right[0];
        return a.service.localeCompare(b.service)
          || a.unit.localeCompare(b.unit)
          || a.unitPrice.settlementAsset.localeCompare(b.unitPrice.settlementAsset);
      })
      .slice(0, limit)
      .map((orders) => benchmarkFromOrders(orders, snapshot.revision, snapshot.ledgerValid));
  }

  #normalizeFilters({ service, unit, settlementAsset, since, until, requireAll }) {
    const normalized = {
      service: service === null ? null : nonEmptyString(service, 'service'),
      unit: unit === null ? null : nonEmptyString(unit, 'unit'),
      settlementAsset: settlementAsset === null ? null : nonEmptyString(settlementAsset, 'settlementAsset'),
      since: optionalTimestamp(since, 'since'),
      until: optionalTimestamp(until, 'until'),
    };
    if (requireAll) {
      invariant(normalized.service !== null, 'INVALID_REQUEST', 'service is required');
      invariant(normalized.unit !== null, 'INVALID_REQUEST', 'unit is required');
      invariant(normalized.settlementAsset !== null, 'INVALID_REQUEST', 'settlementAsset is required');
    }
    if (normalized.since !== null && normalized.until !== null) {
      invariant(Date.parse(normalized.since) < Date.parse(normalized.until), 'INVALID_REQUEST', 'since must be earlier than until');
    }
    return normalized;
  }

  #filter(orders, filters) {
    return orders.filter((order) => {
      if (filters.service !== null && order.service !== filters.service) return false;
      if (filters.unit !== null && order.unit !== filters.unit) return false;
      if (filters.settlementAsset !== null && order.unitPrice.settlementAsset !== filters.settlementAsset) return false;
      const timestamp = settledAt(order);
      if (filters.since !== null && timestamp < filters.since) return false;
      if (filters.until !== null && timestamp >= filters.until) return false;
      return true;
    });
  }

  async #stableSettledOrders() {
    for (let attempt = 0; attempt < this.maxRevisionRetries; attempt += 1) {
      const before = await this.market.getRevision();
      const ledgerValid = await this.market.verifyLedger();
      invariant(ledgerValid, 'LEDGER_INTEGRITY_FAILED', 'clearinghouse ledger integrity verification failed');
      const ledger = await this.market.getLedger();
      const orderIds = [...new Set(ledger
        .map((event) => event?.data?.orderId)
        .filter((orderId) => typeof orderId === 'string' && orderId.length > 0))]
        .sort();
      const orders = (await Promise.all(orderIds.map((orderId) => this.market.getOrder(orderId))))
        .filter((order) => order.status === 'settled');
      const after = await this.market.getRevision();
      if (before === after) return { revision: after, ledgerValid, orders };
    }
    throw new MarketPriceHistoryError('HISTORY_CHANGED', 'market changed repeatedly while settled price history was being assembled');
  }
}
