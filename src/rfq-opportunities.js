const clone = (value) => structuredClone(value);

export class RfqOpportunityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RfqOpportunityError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new RfqOpportunityError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return nonEmptyString(value, field);
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function moneyLessThanOrEqual(left, right) {
  if (!left || !right || left.settlementAsset !== right.settlementAsset) return false;
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = BigInt(left.amount) * (10n ** BigInt(scale - left.scale));
  const rightAmount = BigInt(right.amount) * (10n ** BigInt(scale - right.scale));
  return leftAmount <= rightAmount;
}

function multiplyAmount(unitPrice, quantity) {
  return {
    ...unitPrice,
    amount: (BigInt(unitPrice.amount) * BigInt(quantity)).toString(),
  };
}

function matchesRfq({ rfq, offer, asset, sellerId }) {
  if (rfq.status !== 'open') return false;
  if (offer.status !== 'open') return false;
  if (offer.sellerId !== sellerId) return false;
  if (offer.sellerId === rfq.buyerId) return false;
  if (offer.service !== rfq.service || offer.unit !== rfq.unit) return false;
  if (offer.remaining < rfq.quantity) return false;
  if (asset?.status !== 'active') return false;
  if (!rfq.requiredCapabilities.every((capability) => asset.capabilities?.includes(capability))) return false;
  if (rfq.settlementAsset !== null && offer.unitPrice?.settlementAsset !== rfq.settlementAsset) return false;
  if (rfq.maxUnitPrice !== null && !moneyLessThanOrEqual(offer.unitPrice, rfq.maxUnitPrice)) return false;
  if (rfq.serviceWindowStart !== null) {
    if (offer.windowStart !== null && Date.parse(offer.windowStart) > Date.parse(rfq.serviceWindowStart)) return false;
    if (offer.windowEnd !== null && Date.parse(offer.windowEnd) < Date.parse(rfq.serviceWindowEnd)) return false;
  }
  return true;
}

/**
 * Read-only seller-side discovery over buyer RFQs and authoritative capacity.
 *
 * Returned opportunities are exact RFQ/offer pairs that satisfy the same fit
 * constraints enforced by RfqMarket.submitQuote(). The directory does not rank
 * buyers, auto-submit quotes, reserve capacity, or mutate either source.
 */
export class RfqOpportunityDirectory {
  constructor({
    rfqMarket,
    market,
    clock = () => new Date(),
    maxRevisionRetries = 3,
  } = {}) {
    invariant(rfqMarket && typeof rfqMarket === 'object', 'INVALID_CONFIGURATION', 'rfqMarket is required');
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'listRfqs', 'listQuotes']) {
      invariant(typeof rfqMarket[method] === 'function', 'INVALID_CONFIGURATION', `rfqMarket must provide ${method}()`);
    }
    for (const method of ['getRevision', 'listOffers', 'listAssets']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxRevisionRetries) && maxRevisionRetries >= 1 && maxRevisionRetries <= 20,
      'INVALID_CONFIGURATION', 'maxRevisionRetries must be an integer from 1 to 20');

    this.rfqMarket = rfqMarket;
    this.market = market;
    this.clock = clock;
    this.maxRevisionRetries = maxRevisionRetries;
  }

  async listOpportunities({
    sellerId,
    service = null,
    settlementAsset = null,
    limit = 100,
  } = {}) {
    const normalizedSellerId = nonEmptyString(sellerId, 'sellerId');
    const normalizedService = optionalString(service, 'service');
    const normalizedSettlementAsset = optionalString(settlementAsset, 'settlementAsset');
    const normalizedLimit = positiveInteger(limit, 'limit');
    invariant(normalizedLimit <= 500, 'INVALID_REQUEST', 'limit may not exceed 500');

    for (let attempt = 1; attempt <= this.maxRevisionRetries; attempt += 1) {
      const generatedAt = this.#now();
      const [rfqRevisionBefore, marketRevisionBefore] = await Promise.all([
        this.rfqMarket.getRevision(),
        this.market.getRevision(),
      ]);

      const [rfqs, offers, assets] = await Promise.all([
        this.rfqMarket.listRfqs({
          service: normalizedService ?? undefined,
          settlementAsset: normalizedSettlementAsset ?? undefined,
          status: 'open',
        }),
        this.market.listOffers({ status: null }),
        this.market.listAssets(),
      ]);

      const liveRfqs = rfqs.filter((rfq) => Date.parse(generatedAt) < Date.parse(rfq.expiresAt));
      const quoteRows = await Promise.all(liveRfqs.map(async (rfq) => [
        rfq.id,
        await this.rfqMarket.listQuotes(rfq.id, { status: 'active' }),
      ]));

      const [rfqRevisionAfter, marketRevisionAfter] = await Promise.all([
        this.rfqMarket.getRevision(),
        this.market.getRevision(),
      ]);
      if (rfqRevisionBefore !== rfqRevisionAfter || marketRevisionBefore !== marketRevisionAfter) continue;

      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      const activeQuotesByRfq = new Map(quoteRows);
      const sellerOffers = offers.filter((offer) => offer.sellerId === normalizedSellerId);
      const opportunities = [];

      for (const rfq of liveRfqs) {
        const activeQuotes = activeQuotesByRfq.get(rfq.id) ?? [];
        for (const offer of sellerOffers) {
          const asset = assetById.get(offer.assetId);
          if (!matchesRfq({ rfq, offer, asset, sellerId: normalizedSellerId })) continue;
          const alreadyQuoted = activeQuotes.some((quote) => quote.sellerId === normalizedSellerId && quote.offerId === offer.id);
          if (alreadyQuoted) continue;

          opportunities.push({
            rfqId: rfq.id,
            rfqVersion: rfq.version,
            buyerId: rfq.buyerId,
            offerId: offer.id,
            offerVersion: offer.version,
            assetId: offer.assetId,
            sellerId: normalizedSellerId,
            service: rfq.service,
            unit: rfq.unit,
            quantity: rfq.quantity,
            remaining: offer.remaining,
            unitPrice: clone(offer.unitPrice),
            total: multiplyAmount(offer.unitPrice, rfq.quantity),
            settlementAsset: rfq.settlementAsset,
            maxUnitPrice: rfq.maxUnitPrice === null ? null : clone(rfq.maxUnitPrice),
            requiredCapabilities: clone(rfq.requiredCapabilities),
            serviceWindowStart: rfq.serviceWindowStart,
            serviceWindowEnd: rfq.serviceWindowEnd,
            expiresAt: rfq.expiresAt,
          });
        }
      }

      opportunities.sort((left, right) => (
        left.expiresAt.localeCompare(right.expiresAt)
        || left.rfqId.localeCompare(right.rfqId)
        || left.offerId.localeCompare(right.offerId)
      ));

      return {
        sellerId: normalizedSellerId,
        rfqRevision: rfqRevisionBefore,
        marketRevision: marketRevisionBefore,
        generatedAt,
        total: opportunities.length,
        hasMore: opportunities.length > normalizedLimit,
        opportunities: opportunities.slice(0, normalizedLimit),
      };
    }

    throw new RfqOpportunityError('OPPORTUNITIES_CHANGED', 'RFQ demand or capacity changed repeatedly while assembling opportunities; retry');
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}
