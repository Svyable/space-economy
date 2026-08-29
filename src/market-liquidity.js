const clone = (value) => structuredClone(value);

export class MarketLiquidityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MarketLiquidityError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MarketLiquidityError(code, message, details);
}

function optionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function compareMoney(left, right) {
  invariant(left.settlementAsset === right.settlementAsset, 'INVALID_STATE', 'cannot compare prices in different settlement assets');
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = BigInt(left.amount) * (10n ** BigInt(scale - left.scale));
  const rightAmount = BigInt(right.amount) * (10n ** BigInt(scale - right.scale));
  return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}

function extendRange(range, price) {
  if (range === null) return { low: clone(price), high: clone(price) };
  if (compareMoney(price, range.low) < 0) range.low = clone(price);
  if (compareMoney(price, range.high) > 0) range.high = clone(price);
  return range;
}

function marketKey(service, unit, settlementAsset) {
  return JSON.stringify([service, unit, settlementAsset]);
}

function demandKey(service, unit) {
  return JSON.stringify([service, unit]);
}

function emptyMarket(service, unit, settlementAsset) {
  return {
    service,
    unit,
    settlementAsset,
    supply: {
      offerCount: 0,
      remainingQuantity: '0',
      unitPriceRange: null,
    },
    constrainedDemand: {
      rfqCount: 0,
      quantity: '0',
      pricedRfqCount: 0,
      pricedQuantity: '0',
      maxUnitPriceCeilingRange: null,
    },
    constrainedBalance: '0',
  };
}

/**
 * Revision-stable market liquidity evidence across current supply and RFQ demand.
 *
 * RFQ price ceilings are constraints, not executable bids. This directory does
 * not calculate a spread, midpoint, fair value, ranking, or recommended price.
 */
export class MarketLiquidityDirectory {
  constructor({
    market,
    rfqMarket,
    clock = () => new Date(),
    maxRevisionRetries = 3,
  } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    invariant(rfqMarket && typeof rfqMarket === 'object', 'INVALID_CONFIGURATION', 'rfqMarket is required');
    for (const method of ['getRevision', 'listOffers']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    for (const method of ['getRevision', 'listRfqs']) {
      invariant(typeof rfqMarket[method] === 'function', 'INVALID_CONFIGURATION', `rfqMarket must provide ${method}()`);
    }
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxRevisionRetries) && maxRevisionRetries >= 1 && maxRevisionRetries <= 20,
      'INVALID_CONFIGURATION', 'maxRevisionRetries must be an integer from 1 to 20');

    this.market = market;
    this.rfqMarket = rfqMarket;
    this.clock = clock;
    this.maxRevisionRetries = maxRevisionRetries;
  }

  async snapshot({ service = null, settlementAsset = null, limit = 100 } = {}) {
    const normalizedService = optionalString(service, 'service');
    const normalizedSettlementAsset = optionalString(settlementAsset, 'settlementAsset');
    const normalizedLimit = positiveInteger(limit, 'limit');
    invariant(normalizedLimit <= 500, 'INVALID_REQUEST', 'limit may not exceed 500');

    for (let attempt = 1; attempt <= this.maxRevisionRetries; attempt += 1) {
      const generatedAt = this.#now();
      const [marketRevisionBefore, rfqRevisionBefore] = await Promise.all([
        this.market.getRevision(),
        this.rfqMarket.getRevision(),
      ]);
      const [offers, rfqs] = await Promise.all([
        this.market.listOffers({ service: normalizedService ?? undefined, status: null }),
        this.rfqMarket.listRfqs({ service: normalizedService ?? undefined, status: 'open' }),
      ]);
      const [marketRevisionAfter, rfqRevisionAfter] = await Promise.all([
        this.market.getRevision(),
        this.rfqMarket.getRevision(),
      ]);
      if (marketRevisionBefore !== marketRevisionAfter || rfqRevisionBefore !== rfqRevisionAfter) continue;

      const markets = new Map();
      const unconstrained = new Map();

      for (const offer of offers) {
        if (offer.status !== 'open' || offer.remaining <= 0) continue;
        if (normalizedSettlementAsset !== null && offer.unitPrice?.settlementAsset !== normalizedSettlementAsset) continue;
        const key = marketKey(offer.service, offer.unit, offer.unitPrice.settlementAsset);
        const row = markets.get(key) ?? emptyMarket(offer.service, offer.unit, offer.unitPrice.settlementAsset);
        row.supply.offerCount += 1;
        row.supply.remainingQuantity = (BigInt(row.supply.remainingQuantity) + BigInt(offer.remaining)).toString();
        row.supply.unitPriceRange = extendRange(row.supply.unitPriceRange, offer.unitPrice);
        markets.set(key, row);
      }

      for (const rfq of rfqs) {
        if (rfq.status !== 'open' || Date.parse(generatedAt) >= Date.parse(rfq.expiresAt)) continue;
        if (rfq.settlementAsset === null) {
          const key = demandKey(rfq.service, rfq.unit);
          const row = unconstrained.get(key) ?? {
            service: rfq.service,
            unit: rfq.unit,
            rfqCount: 0,
            quantity: '0',
          };
          row.rfqCount += 1;
          row.quantity = (BigInt(row.quantity) + BigInt(rfq.quantity)).toString();
          unconstrained.set(key, row);
          continue;
        }
        if (normalizedSettlementAsset !== null && rfq.settlementAsset !== normalizedSettlementAsset) continue;
        const key = marketKey(rfq.service, rfq.unit, rfq.settlementAsset);
        const row = markets.get(key) ?? emptyMarket(rfq.service, rfq.unit, rfq.settlementAsset);
        row.constrainedDemand.rfqCount += 1;
        row.constrainedDemand.quantity = (BigInt(row.constrainedDemand.quantity) + BigInt(rfq.quantity)).toString();
        if (rfq.maxUnitPrice !== null) {
          row.constrainedDemand.pricedRfqCount += 1;
          row.constrainedDemand.pricedQuantity = (BigInt(row.constrainedDemand.pricedQuantity) + BigInt(rfq.quantity)).toString();
          row.constrainedDemand.maxUnitPriceCeilingRange = extendRange(
            row.constrainedDemand.maxUnitPriceCeilingRange,
            rfq.maxUnitPrice,
          );
        }
        markets.set(key, row);
      }

      const marketRows = [...markets.values()].map((row) => ({
        ...row,
        constrainedBalance: (
          BigInt(row.supply.remainingQuantity) - BigInt(row.constrainedDemand.quantity)
        ).toString(),
      })).sort((left, right) => (
        left.service.localeCompare(right.service)
        || left.unit.localeCompare(right.unit)
        || left.settlementAsset.localeCompare(right.settlementAsset)
      ));

      const unconstrainedRows = [...unconstrained.values()].sort((left, right) => (
        left.service.localeCompare(right.service) || left.unit.localeCompare(right.unit)
      ));

      return {
        marketRevision: marketRevisionBefore,
        rfqRevision: rfqRevisionBefore,
        generatedAt,
        totalMarkets: marketRows.length,
        hasMore: marketRows.length > normalizedLimit,
        markets: marketRows.slice(0, normalizedLimit),
        unconstrainedDemand: unconstrainedRows,
      };
    }

    throw new MarketLiquidityError('LIQUIDITY_CHANGED', 'supply or RFQ demand changed repeatedly while assembling liquidity; retry');
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}
