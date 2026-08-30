import { randomUUID } from 'node:crypto';
import { sha256Canonical } from './canonical-json.js';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const RFQ_SCHEMA_VERSION = 1;
const MARKET_UNAVAILABLE_CODES = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_CAPACITY',
  'OFFER_WINDOW_CLOSED',
  'INVALID_REQUEST',
  'COMMITMENT_EXPIRED',
]);

export class RfqMarketError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RfqMarketError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new RfqMarketError(code, message, details);
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

function timestamp(value, field) {
  invariant(typeof value === 'string' || value instanceof Date, 'INVALID_REQUEST', `${field} must be a timestamp`);
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_REQUEST', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeCapabilities(value = []) {
  invariant(Array.isArray(value), 'INVALID_REQUEST', 'requiredCapabilities must be an array');
  const normalized = value.map((item, index) => nonEmptyString(item, `requiredCapabilities[${index}]`));
  return [...new Set(normalized)].sort();
}

function normalizeUnitPrice(value, field = 'maxUnitPrice') {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `${field} must be an object`);
  const settlementAsset = nonEmptyString(value.settlementAsset, `${field}.settlementAsset`);
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_REQUEST', `${field}.amount must be an unsigned integer string`);
  invariant(BigInt(value.amount) > 0n, 'INVALID_REQUEST', `${field}.amount must be positive`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', `${field}.scale must be an integer from 0 to 18`);
  return { settlementAsset, amount: value.amount, scale: value.scale };
}

function moneyLessThanOrEqual(left, right) {
  if (left.settlementAsset !== right.settlementAsset) return false;
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

function normalizeContext(context) {
  invariant(typeof context?.actorId === 'string' && context.actorId.trim().length > 0, 'UNAUTHENTICATED', 'actor identity is required');
  const actorId = context.actorId.trim();
  const idempotencyKey = context?.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    invariant(typeof idempotencyKey === 'string' && idempotencyKey.length >= 1 && idempotencyKey.length <= 255, 'INVALID_REQUEST', 'idempotencyKey must be 1-255 characters');
  }
  const expectedVersion = context?.expectedVersion ?? null;
  if (expectedVersion !== null) positiveInteger(expectedVersion, 'context.expectedVersion');
  return { actorId, idempotencyKey, expectedVersion };
}

function validateServiceWindow(start, end) {
  if (start === null && end === null) return;
  invariant(start !== null && end !== null, 'INVALID_REQUEST', 'serviceWindowStart and serviceWindowEnd must be supplied together');
  invariant(Date.parse(start) < Date.parse(end), 'INVALID_REQUEST', 'service window must have start < end');
}

function earlierTimestamp(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

/**
 * Pre-trade request-for-quote market layered above the clearinghouse kernel.
 *
 * RFQs express buyer demand. Quotes bind that demand to an existing authoritative
 * capacity offer. Public-price quotes convert through Clearinghouse.createOrder().
 * Commitment-backed quotes reference seller-authorized bilateral terms and convert
 * through Clearinghouse.exerciseCommercialCommitment(). Both paths preserve the
 * kernel's capacity conservation, exact money, reservation TTL, and idempotency.
 *
 * The RFQ book has its own CAS snapshot store because procurement intent is not
 * clearinghouse transaction state. Acceptance uses a recoverable claim -> reserve
 * -> finalize saga so the two persistence boundaries do not pretend to share ACID.
 */
export class RfqMarket {
  constructor({
    market,
    statePath = null,
    store = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    maxSnapshotRetries = 3,
  } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'listAssets', 'listOffers', 'createOrder', 'getOrder']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(!(statePath && store), 'INVALID_CONFIGURATION', 'provide either statePath or store, not both');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');

    this.market = market;
    this.store = store ?? (statePath ? new JsonFileSnapshotStore(statePath) : new MemorySnapshotStore());
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.maxSnapshotRetries = maxSnapshotRetries;
    this.commandQueue = Promise.resolve();
    this.#initializeEmpty();
    this.initialization = this.#loadPersisted();
    this.initialization.catch(() => {});
  }

  static async open(options = {}) {
    return new RfqMarket(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  createRfq(input, context) {
    return this.#command('rfq.create', context, input, ({ actorId }) => {
      const createdAt = this.#now();
      const expiresAt = timestamp(input?.expiresAt, 'expiresAt');
      invariant(Date.parse(expiresAt) > Date.parse(createdAt), 'INVALID_REQUEST', 'expiresAt must be in the future');

      const serviceWindowStart = input?.serviceWindowStart == null ? null : timestamp(input.serviceWindowStart, 'serviceWindowStart');
      const serviceWindowEnd = input?.serviceWindowEnd == null ? null : timestamp(input.serviceWindowEnd, 'serviceWindowEnd');
      validateServiceWindow(serviceWindowStart, serviceWindowEnd);

      const settlementAsset = optionalString(input?.settlementAsset, 'settlementAsset');
      const maxUnitPrice = input?.maxUnitPrice == null ? null : normalizeUnitPrice(input.maxUnitPrice);
      if (settlementAsset !== null && maxUnitPrice !== null) {
        invariant(maxUnitPrice.settlementAsset === settlementAsset, 'INVALID_REQUEST', 'maxUnitPrice settlement asset must match settlementAsset');
      }

      const rfq = {
        id: this.idGenerator(),
        buyerId: actorId,
        service: nonEmptyString(input?.service, 'service'),
        unit: nonEmptyString(input?.unit, 'unit'),
        quantity: positiveInteger(input?.quantity, 'quantity'),
        settlementAsset: settlementAsset ?? maxUnitPrice?.settlementAsset ?? null,
        maxUnitPrice,
        requiredCapabilities: normalizeCapabilities(input?.requiredCapabilities),
        serviceWindowStart,
        serviceWindowEnd,
        expiresAt,
        metadata: input?.metadata ?? {},
        status: 'open',
        acceptedQuoteId: null,
        orderId: null,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      };
      this.rfqs.set(rfq.id, rfq);
      return rfq;
    });
  }

  listRfqs({ service, settlementAsset, status = 'open' } = {}) {
    return this.#read(() => [...this.rfqs.values()]
      .map((rfq) => this.#publicRfq(rfq))
      .filter((rfq) => (!service || rfq.service === service)
        && (!settlementAsset || rfq.settlementAsset === settlementAsset)
        && (!status || rfq.status === status)));
  }

  getRfq(rfqId) {
    return this.#read(() => this.#publicRfq(this.#rfq(rfqId)));
  }

  cancelRfq(rfqId, context) {
    return this.#command('rfq.cancel', context, { rfqId }, ({ actorId, expectedVersion }) => {
      const rfq = this.#rfq(rfqId);
      this.#expectVersion(rfq, expectedVersion);
      invariant(actorId === rfq.buyerId, 'FORBIDDEN', 'only the buyer may cancel the RFQ');
      invariant(rfq.status === 'open', 'CONFLICT', 'RFQ is not open');
      this.#assertRfqLive(rfq);

      const now = this.#now();
      rfq.status = 'cancelled';
      rfq.version += 1;
      rfq.updatedAt = now;
      this.#closeActiveQuotes(rfq.id, 'rfq-cancelled', now);
      return rfq;
    });
  }

  submitQuote(rfqId, input, context) {
    return this.#command('quote.submit', context, { rfqId, ...input }, async ({ actorId }) => {
      const rfq = this.#rfq(rfqId);
      invariant(rfq.status === 'open', 'CONFLICT', 'RFQ is not open');
      this.#assertRfqLive(rfq);
      invariant(actorId !== rfq.buyerId, 'INVALID_REQUEST', 'buyer may not quote its own RFQ');

      const offerId = nonEmptyString(input?.offerId, 'offerId');
      const { offer, asset } = await this.#readOfferAndAsset(offerId);
      const commercialCommitmentId = optionalString(input?.commercialCommitmentId, 'commercialCommitmentId');
      let commitment = null;
      let quotedUnitPrice = offer.unitPrice;

      if (commercialCommitmentId !== null) {
        commitment = await this.#readCommercialCommitment(commercialCommitmentId, actorId);
        quotedUnitPrice = commitment.unitPrice;
        this.#validateCommercialCommitmentForRfq({ rfq, offer, asset, commitment, sellerId: actorId });
      } else {
        this.#validateOfferForRfq({ rfq, offer, asset, sellerId: actorId, unitPrice: offer.unitPrice });
      }

      const duplicate = [...this.quotes.values()].find((quote) => (
        quote.rfqId === rfq.id
        && quote.offerId === offer.id
        && quote.sellerId === actorId
        && quote.status === 'active'
      ));
      invariant(!duplicate, 'DUPLICATE_QUOTE', 'an active quote already binds this offer to the RFQ', { quoteId: duplicate?.id });

      const now = this.#now();
      const defaultValidUntil = commitment === null
        ? rfq.expiresAt
        : earlierTimestamp(rfq.expiresAt, commitment.expiresAt);
      const validUntil = input?.validUntil == null ? defaultValidUntil : timestamp(input.validUntil, 'validUntil');
      invariant(Date.parse(validUntil) > Date.parse(now), 'INVALID_REQUEST', 'validUntil must be in the future');
      invariant(Date.parse(validUntil) <= Date.parse(rfq.expiresAt), 'INVALID_REQUEST', 'validUntil may not exceed the RFQ expiry');
      if (commitment !== null) {
        invariant(Date.parse(validUntil) <= Date.parse(commitment.expiresAt), 'INVALID_REQUEST', 'validUntil may not exceed the commercial commitment expiry');
      }

      const quote = {
        id: this.idGenerator(),
        rfqId: rfq.id,
        offerId: offer.id,
        assetId: offer.assetId,
        sellerId: actorId,
        quantity: rfq.quantity,
        unitPrice: clone(quotedUnitPrice),
        total: multiplyAmount(quotedUnitPrice, rfq.quantity),
        offerVersionAtQuote: offer.version,
        commercialCommitmentId: commitment?.id ?? null,
        commercialTermsHash: commitment?.termsHash ?? null,
        pricingSource: commitment === null ? 'public-offer' : 'commercial-commitment',
        validUntil,
        metadata: input?.metadata ?? {},
        status: 'active',
        closedReason: null,
        orderId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.quotes.set(quote.id, quote);
      return quote;
    });
  }

  listQuotes(rfqId, { status = 'active' } = {}) {
    return this.#read(() => {
      this.#rfq(rfqId);
      return [...this.quotes.values()]
        .filter((quote) => quote.rfqId === rfqId)
        .map((quote) => this.#publicQuote(quote))
        .filter((quote) => !status || quote.status === status);
    });
  }

  getQuote(quoteId) {
    return this.#read(() => this.#publicQuote(this.#quote(quoteId)));
  }

  withdrawQuote(quoteId, context) {
    return this.#command('quote.withdraw', context, { quoteId }, ({ actorId, expectedVersion }) => {
      const quote = this.#quote(quoteId);
      this.#expectVersion(quote, expectedVersion);
      invariant(actorId === quote.sellerId, 'FORBIDDEN', 'only the seller may withdraw the quote');
      invariant(quote.status === 'active', 'CONFLICT', 'quote is not active');
      this.#assertQuoteLive(quote);

      const now = this.#now();
      quote.status = 'withdrawn';
      quote.closedReason = 'seller-withdrawn';
      quote.version += 1;
      quote.updatedAt = now;
      return quote;
    });
  }

  acceptQuote(quoteId, rawContext) {
    const execute = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      let quote = this.#quote(quoteId);
      let rfq = this.#rfq(quote.rfqId);
      invariant(context.actorId === rfq.buyerId, 'FORBIDDEN', 'only the RFQ buyer may accept a quote');

      if (rfq.status === 'awarded') {
        invariant(rfq.acceptedQuoteId === quote.id, 'CONFLICT', 'RFQ was awarded to a different quote', {
          acceptedQuoteId: rfq.acceptedQuoteId,
        });
        const order = await this.market.getOrder(rfq.orderId);
        return { rfq: this.#publicRfq(rfq), quote: this.#publicQuote(quote), order };
      }

      if (rfq.status === 'accepting') {
        invariant(rfq.acceptedQuoteId === quote.id, 'CONFLICT', 'RFQ acceptance is already claimed by a different quote', {
          acceptedQuoteId: rfq.acceptedQuoteId,
        });
      } else {
        invariant(rfq.status === 'open', 'CONFLICT', 'RFQ is not open');
        this.#expectVersion(rfq, context.expectedVersion);
        this.#assertRfqLive(rfq);
        invariant(quote.status === 'active', 'CONFLICT', 'quote is not active');
        this.#assertQuoteLive(quote);

        await this.#persistTransition(() => {
          const claimedRfq = this.#rfq(rfq.id);
          const claimedQuote = this.#quote(quote.id);
          invariant(claimedRfq.status === 'open', 'CONFLICT', 'RFQ is not open');
          invariant(claimedQuote.status === 'active', 'CONFLICT', 'quote is not active');
          const now = this.#now();
          claimedRfq.status = 'accepting';
          claimedRfq.acceptedQuoteId = claimedQuote.id;
          claimedRfq.version += 1;
          claimedRfq.updatedAt = now;
          claimedQuote.status = 'accepting';
          claimedQuote.version += 1;
          claimedQuote.updatedAt = now;
          return { rfq: claimedRfq, quote: claimedQuote };
        });
        rfq = this.#rfq(rfq.id);
        quote = this.#quote(quote.id);
      }

      let order;
      try {
        const idempotencyKey = `rfq-accept:${sha256Canonical({ rfqId: rfq.id, quoteId: quote.id })}`;
        if (quote.commercialCommitmentId !== null) {
          this.#assertCommercialCommitmentSupport();
          order = await this.market.exerciseCommercialCommitment(
            quote.commercialCommitmentId,
            { actorId: rfq.buyerId, idempotencyKey },
          );
        } else {
          order = await this.market.createOrder(
            { offerId: quote.offerId, quantity: rfq.quantity },
            { actorId: rfq.buyerId, idempotencyKey },
          );
        }
      } catch (error) {
        if (!MARKET_UNAVAILABLE_CODES.has(error?.code)) throw error;

        await this.#persistTransition(() => {
          const failedRfq = this.#rfq(rfq.id);
          const failedQuote = this.#quote(quote.id);
          if (failedRfq.status === 'accepting' && failedRfq.acceptedQuoteId === failedQuote.id) {
            const now = this.#now();
            failedRfq.status = 'open';
            failedRfq.acceptedQuoteId = null;
            failedRfq.version += 1;
            failedRfq.updatedAt = now;
            failedQuote.status = 'unavailable';
            failedQuote.closedReason = error.code;
            failedQuote.version += 1;
            failedQuote.updatedAt = now;
          }
          return { rfq: failedRfq, quote: failedQuote };
        });
        throw new RfqMarketError('QUOTE_UNAVAILABLE', 'quoted terms can no longer satisfy the RFQ', {
          quoteId: quote.id,
          causeCode: error.code,
        });
      }

      const finalized = await this.#persistTransition(() => {
        const awardedRfq = this.#rfq(rfq.id);
        const acceptedQuote = this.#quote(quote.id);
        if (awardedRfq.status === 'awarded') {
          invariant(awardedRfq.acceptedQuoteId === acceptedQuote.id, 'CONFLICT', 'RFQ was awarded to a different quote');
          return { rfq: awardedRfq, quote: acceptedQuote };
        }
        invariant(awardedRfq.status === 'accepting' && awardedRfq.acceptedQuoteId === acceptedQuote.id, 'CONFLICT', 'RFQ acceptance claim changed before finalization');

        const now = this.#now();
        awardedRfq.status = 'awarded';
        awardedRfq.orderId = order.id;
        awardedRfq.version += 1;
        awardedRfq.updatedAt = now;
        acceptedQuote.status = 'accepted';
        acceptedQuote.orderId = order.id;
        acceptedQuote.version += 1;
        acceptedQuote.updatedAt = now;
        this.#closeActiveQuotes(awardedRfq.id, 'not-selected', now, acceptedQuote.id);
        return { rfq: awardedRfq, quote: acceptedQuote };
      });

      return {
        rfq: this.#publicRfq(finalized.rfq),
        quote: this.#publicQuote(finalized.quote),
        order: clone(order),
      };
    };

    const pending = this.commandQueue.then(execute);
    this.commandQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  getRevision() {
    return this.#read(() => this.revision);
  }

  #initializeEmpty() {
    this.rfqs = new Map();
    this.quotes = new Map();
    this.idempotency = new Map();
    this.revision = 0;
  }

  async #loadPersisted() {
    const persisted = await this.store.load();
    if (persisted) this.#restore(persisted);
  }

  #command(operation, rawContext, fingerprintData, mutator) {
    const execute = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      const fingerprint = sha256Canonical({ operation, actorId: context.actorId, input: fingerprintData });
      const idempotencyId = context.idempotencyKey ? `${context.actorId}\u0000${operation}\u0000${context.idempotencyKey}` : null;

      if (idempotencyId && this.idempotency.has(idempotencyId)) {
        const prior = this.idempotency.get(idempotencyId);
        invariant(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'idempotency key was already used with a different request');
        return clone(prior.result);
      }

      const before = this.#snapshot();
      const expectedRevision = this.revision;
      try {
        const result = await mutator(context);
        this.revision += 1;
        if (idempotencyId) {
          this.idempotency.set(idempotencyId, {
            fingerprint,
            result: clone(result),
            createdAt: this.#now(),
          });
        }
        await this.store.save(this.#snapshot(), { expectedRevision });
        return clone(result);
      } catch (error) {
        this.#restore(before);
        if (error instanceof StoreConflictError) {
          await this.#reloadAfterConflict();
          throw new RfqMarketError('STORE_CONFLICT', 'RFQ book changed concurrently; retry the command');
        }
        throw error;
      }
    };

    const pending = this.commandQueue.then(execute);
    this.commandQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #persistTransition(mutator) {
    const before = this.#snapshot();
    const expectedRevision = this.revision;
    try {
      const result = await mutator();
      this.revision += 1;
      await this.store.save(this.#snapshot(), { expectedRevision });
      return clone(result);
    } catch (error) {
      this.#restore(before);
      if (error instanceof StoreConflictError) {
        await this.#reloadAfterConflict();
        throw new RfqMarketError('STORE_CONFLICT', 'RFQ book changed concurrently; retry the command');
      }
      throw error;
    }
  }

  async #reloadAfterConflict() {
    const latest = await this.store.load();
    if (latest) this.#restore(latest);
    else this.#initializeEmpty();
  }

  async #read(reader) {
    await this.initialization;
    const pendingCommands = this.commandQueue;
    await pendingCommands;
    return reader();
  }

  #expectVersion(resource, expectedVersion) {
    if (expectedVersion === null) return;
    invariant(resource.version === expectedVersion, 'STALE_VERSION', 'resource version changed', {
      expectedVersion,
      actualVersion: resource.version,
    });
  }

  #assertRfqLive(rfq) {
    invariant(Date.parse(this.#now()) < Date.parse(rfq.expiresAt), 'RFQ_EXPIRED', 'RFQ has expired', { expiresAt: rfq.expiresAt });
  }

  #assertQuoteLive(quote) {
    invariant(Date.parse(this.#now()) < Date.parse(quote.validUntil), 'QUOTE_EXPIRED', 'quote has expired', { validUntil: quote.validUntil });
  }

  #publicRfq(rfq) {
    const result = clone(rfq);
    if (result.status === 'open' && Date.parse(this.#now()) >= Date.parse(result.expiresAt)) result.status = 'expired';
    return result;
  }

  #publicQuote(quote) {
    const result = clone(quote);
    const rfq = this.rfqs.get(result.rfqId);
    if (result.status === 'active' && (
      Date.parse(this.#now()) >= Date.parse(result.validUntil)
      || (rfq?.status === 'open' && Date.parse(this.#now()) >= Date.parse(rfq.expiresAt))
    )) result.status = 'expired';
    return result;
  }

  #closeActiveQuotes(rfqId, reason, timestampValue, exceptQuoteId = null) {
    for (const quote of this.quotes.values()) {
      if (quote.rfqId !== rfqId || quote.id === exceptQuoteId || quote.status !== 'active') continue;
      quote.status = 'closed';
      quote.closedReason = reason;
      quote.version += 1;
      quote.updatedAt = timestampValue;
    }
  }

  async #readOfferAndAsset(offerId) {
    for (let attempt = 1; attempt <= this.maxSnapshotRetries; attempt += 1) {
      const before = await this.market.getRevision();
      const [offers, assets] = await Promise.all([
        this.market.listOffers({ status: null }),
        this.market.listAssets(),
      ]);
      const after = await this.market.getRevision();
      if (before !== after) continue;
      const offer = offers.find((item) => item.id === offerId);
      invariant(offer, 'NOT_FOUND', 'offer not found');
      const asset = assets.find((item) => item.id === offer.assetId);
      invariant(asset, 'NOT_FOUND', 'offer asset not found');
      return { offer, asset };
    }
    throw new RfqMarketError('READ_SNAPSHOT_CONFLICT', 'market changed repeatedly while validating the quote; retry');
  }

  async #readCommercialCommitment(commitmentId, sellerId) {
    this.#assertCommercialCommitmentSupport();
    const commitment = await this.market.getCommercialCommitment(commitmentId, { actorId: sellerId });
    invariant(commitment && typeof commitment === 'object', 'INVALID_STATE', 'commercial commitment response is invalid');
    return commitment;
  }

  #assertCommercialCommitmentSupport() {
    invariant(
      typeof this.market.getCommercialCommitment === 'function'
      && typeof this.market.exerciseCommercialCommitment === 'function',
      'COMMERCIAL_TERMS_UNSUPPORTED',
      'market does not support commercial commitments',
    );
  }

  #validateCommercialCommitmentForRfq({ rfq, offer, asset, commitment, sellerId }) {
    invariant(commitment.status === 'active', 'CONFLICT', 'commercial commitment is not active');
    invariant(commitment.offerId === offer.id, 'QUOTE_MISMATCH', 'commercial commitment references a different offer');
    invariant(commitment.assetId === offer.assetId, 'QUOTE_MISMATCH', 'commercial commitment references a different asset');
    invariant(commitment.sellerId === sellerId, 'FORBIDDEN', 'seller may only quote its own commercial commitment');
    invariant(commitment.buyerId === rfq.buyerId, 'QUOTE_MISMATCH', 'commercial commitment is designated for a different buyer');
    invariant(commitment.service === rfq.service, 'QUOTE_MISMATCH', 'commercial commitment service does not match RFQ');
    invariant(commitment.unit === rfq.unit, 'QUOTE_MISMATCH', 'commercial commitment unit does not match RFQ');
    invariant(commitment.quantity === rfq.quantity, 'QUOTE_MISMATCH', 'commercial commitment quantity must equal the single-award RFQ quantity');
    invariant(typeof commitment.termsHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(commitment.termsHash), 'INVALID_STATE', 'commercial commitment termsHash is invalid');
    this.#validateOfferForRfq({
      rfq,
      offer,
      asset,
      sellerId,
      unitPrice: commitment.unitPrice,
    });
  }

  #validateOfferForRfq({ rfq, offer, asset, sellerId, unitPrice = offer.unitPrice }) {
    invariant(offer.status === 'open', 'CONFLICT', 'offer is not open');
    invariant(offer.sellerId === sellerId, 'FORBIDDEN', 'seller may only quote its own offer');
    invariant(offer.sellerId !== rfq.buyerId, 'INVALID_REQUEST', 'buyer and seller must be different participants');
    invariant(offer.service === rfq.service, 'QUOTE_MISMATCH', 'offer service does not match RFQ service');
    invariant(offer.unit === rfq.unit, 'QUOTE_MISMATCH', 'offer unit does not match RFQ unit');
    invariant(offer.remaining >= rfq.quantity, 'INSUFFICIENT_CAPACITY', 'offer does not currently have enough remaining capacity', { remaining: offer.remaining });
    invariant(asset.status === 'active', 'CONFLICT', 'offer asset is not active');
    invariant(rfq.requiredCapabilities.every((capability) => asset.capabilities?.includes(capability)), 'QUOTE_MISMATCH', 'offer asset does not satisfy required capabilities');

    if (rfq.settlementAsset !== null) {
      invariant(unitPrice?.settlementAsset === rfq.settlementAsset, 'QUOTE_MISMATCH', 'quoted settlement asset does not match RFQ');
    }
    if (rfq.maxUnitPrice !== null) {
      invariant(moneyLessThanOrEqual(unitPrice, rfq.maxUnitPrice), 'QUOTE_PRICE_EXCEEDED', 'quoted unit price exceeds RFQ maximum');
    }
    if (rfq.serviceWindowStart !== null) {
      if (offer.windowStart !== null) {
        invariant(Date.parse(offer.windowStart) <= Date.parse(rfq.serviceWindowStart), 'QUOTE_MISMATCH', 'offer starts after the requested service window begins');
      }
      if (offer.windowEnd !== null) {
        invariant(Date.parse(offer.windowEnd) >= Date.parse(rfq.serviceWindowEnd), 'QUOTE_MISMATCH', 'offer ends before the requested service window ends');
      }
    }
  }

  #rfq(id) {
    const rfq = this.rfqs.get(id);
    invariant(rfq, 'NOT_FOUND', 'RFQ not found');
    return rfq;
  }

  #quote(id) {
    const quote = this.quotes.get(id);
    invariant(quote, 'NOT_FOUND', 'quote not found');
    return quote;
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }

  #snapshot() {
    return {
      schemaVersion: RFQ_SCHEMA_VERSION,
      revision: this.revision,
      rfqs: [...this.rfqs.values()].map((item) => clone(item)),
      quotes: [...this.quotes.values()].map((item) => clone(item)),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]),
    };
  }

  #restore(state) {
    invariant(state?.schemaVersion === RFQ_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', `unsupported RFQ state schema version: ${state?.schemaVersion ?? 'missing'}`);
    invariant(Number.isSafeInteger(state.revision) && state.revision >= 0, 'CORRUPT_STATE', 'RFQ state revision is invalid');
    this.rfqs = new Map((state.rfqs ?? []).map((item) => [item.id, item]));
    this.quotes = new Map((state.quotes ?? []).map((item) => [item.id, {
      ...item,
      commercialCommitmentId: item.commercialCommitmentId ?? null,
      commercialTermsHash: item.commercialTermsHash ?? null,
      pricingSource: item.pricingSource ?? 'public-offer',
    }]));
    this.idempotency = new Map(state.idempotency ?? []);
    this.revision = state.revision;
  }
}
