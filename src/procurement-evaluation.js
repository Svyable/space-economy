const clone = (value) => structuredClone(value);

const PRIORITIES = new Set([
  'unit-price-asc',
  'provider-settled-rate-desc',
  'provider-orders-desc',
  'delivery-latency-asc',
  'seller-id-asc',
]);

export class ProcurementEvaluationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProcurementEvaluationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new ProcurementEvaluationError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= max, 'INVALID_REQUEST', `${field} must be a non-negative safe integer no greater than ${max}`);
  return value;
}

function normalizeMoney(value, field) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `${field} must be an object`);
  const settlementAsset = nonEmptyString(value.settlementAsset, `${field}.settlementAsset`);
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_REQUEST', `${field}.amount must be an unsigned integer string`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', `${field}.scale must be an integer from 0 to 18`);
  return { settlementAsset, amount: value.amount, scale: value.scale };
}

function compareMoney(left, right) {
  invariant(left.settlementAsset === right.settlementAsset, 'INCOMPARABLE_MONEY', 'settlement assets differ');
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = BigInt(left.amount) * (10n ** BigInt(scale - left.scale));
  const rightAmount = BigInt(right.amount) * (10n ** BigInt(scale - right.scale));
  return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}

function normalizeMarket(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'market is required');
  return {
    service: nonEmptyString(value.service, 'market.service'),
    unit: nonEmptyString(value.unit, 'market.unit'),
    settlementAsset: nonEmptyString(value.settlementAsset, 'market.settlementAsset'),
  };
}

function normalizePolicy(value = {}) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'policy must be an object');
  const maxUnitPrice = value.maxUnitPrice == null ? null : normalizeMoney(value.maxUnitPrice, 'policy.maxUnitPrice');
  const minProviderOrders = value.minProviderOrders == null ? null : nonNegativeInteger(value.minProviderOrders, 'policy.minProviderOrders');
  const minSettledOutcomeBasisPoints = value.minSettledOutcomeBasisPoints == null
    ? null
    : nonNegativeInteger(value.minSettledOutcomeBasisPoints, 'policy.minSettledOutcomeBasisPoints', 10000);
  const maxAverageDeliveryMs = value.maxAverageDeliveryMs == null
    ? null
    : nonNegativeInteger(value.maxAverageDeliveryMs, 'policy.maxAverageDeliveryMs');
  const maxPremiumOverMedianBasisPoints = value.maxPremiumOverMedianBasisPoints == null
    ? null
    : nonNegativeInteger(value.maxPremiumOverMedianBasisPoints, 'policy.maxPremiumOverMedianBasisPoints', 100000);

  const priorities = value.priorities == null
    ? ['unit-price-asc', 'provider-settled-rate-desc', 'delivery-latency-asc', 'provider-orders-desc', 'seller-id-asc']
    : value.priorities.map((priority, index) => nonEmptyString(priority, `policy.priorities[${index}]`));
  invariant(new Set(priorities).size === priorities.length, 'INVALID_REQUEST', 'policy priorities must be unique');
  for (const priority of priorities) invariant(PRIORITIES.has(priority), 'INVALID_REQUEST', `unsupported procurement priority: ${priority}`);

  return {
    maxUnitPrice,
    minProviderOrders,
    minSettledOutcomeBasisPoints,
    maxAverageDeliveryMs,
    maxPremiumOverMedianBasisPoints,
    priorities,
  };
}

function normalizeOffer(value, market, index) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `candidates[${index}].offer is required`);
  const unitPrice = normalizeMoney(value.unitPrice, `candidates[${index}].offer.unitPrice`);
  invariant(value.service === market.service, 'INVALID_REQUEST', `candidates[${index}] offer service does not match market`);
  invariant(value.unit === market.unit, 'INVALID_REQUEST', `candidates[${index}] offer unit does not match market`);
  invariant(unitPrice.settlementAsset === market.settlementAsset, 'INVALID_REQUEST', `candidates[${index}] offer settlement asset does not match market`);
  invariant(Number.isSafeInteger(value.remaining) && value.remaining >= 0, 'INVALID_REQUEST', `candidates[${index}].offer.remaining must be a non-negative safe integer`);
  return {
    id: nonEmptyString(value.id, `candidates[${index}].offer.id`),
    sellerId: nonEmptyString(value.sellerId, `candidates[${index}].offer.sellerId`),
    service: value.service,
    unit: value.unit,
    unitPrice,
    remaining: value.remaining,
    status: nonEmptyString(value.status, `candidates[${index}].offer.status`),
    version: value.version ?? null,
  };
}

function normalizeProviderHistory(value, offer, index) {
  if (value == null) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `candidates[${index}].providerHistory must be an object`);
  invariant(value.sellerId === offer.sellerId, 'INVALID_REQUEST', `candidates[${index}] provider history seller does not match offer`);
  invariant(value.service === offer.service, 'INVALID_REQUEST', `candidates[${index}] provider history service does not match offer`);
  const totalOrders = value.orders?.total;
  const terminal = value.terminalOutcomes?.total;
  const settled = value.terminalOutcomes?.settled;
  invariant(Number.isSafeInteger(totalOrders) && totalOrders >= 0, 'INVALID_REQUEST', `candidates[${index}] provider history order count is invalid`);
  invariant(Number.isSafeInteger(terminal) && terminal >= 0, 'INVALID_REQUEST', `candidates[${index}] provider terminal count is invalid`);
  invariant(Number.isSafeInteger(settled) && settled >= 0 && settled <= terminal, 'INVALID_REQUEST', `candidates[${index}] provider settled count is invalid`);
  const averageDeliveryMs = value.timing?.delivery?.averageMs ?? null;
  invariant(averageDeliveryMs === null || (Number.isSafeInteger(averageDeliveryMs) && averageDeliveryMs >= 0), 'INVALID_REQUEST', `candidates[${index}] average delivery latency is invalid`);
  return {
    revision: value.revision ?? null,
    totalOrders,
    terminalOutcomes: terminal,
    settledOutcomes: settled,
    averageDeliveryMs,
  };
}

function normalizeBenchmark(value, market, index) {
  if (value == null) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `candidates[${index}].priceBenchmark must be an object`);
  invariant(value.service === market.service && value.unit === market.unit && value.settlementAsset === market.settlementAsset,
    'INVALID_REQUEST', `candidates[${index}] price benchmark does not match market`);
  const median = value.unitPrice?.median;
  invariant(median && typeof median === 'object', 'INVALID_REQUEST', `candidates[${index}] price benchmark median is required`);
  invariant(median.settlementAsset === market.settlementAsset, 'INVALID_REQUEST', `candidates[${index}] benchmark median settlement asset does not match market`);
  invariant(typeof median.amountNumerator === 'string' && /^[0-9]+$/.test(median.amountNumerator), 'INVALID_REQUEST', `candidates[${index}] benchmark median numerator is invalid`);
  invariant(typeof median.amountDenominator === 'string' && /^[1-9][0-9]*$/.test(median.amountDenominator), 'INVALID_REQUEST', `candidates[${index}] benchmark median denominator is invalid`);
  invariant(Number.isSafeInteger(median.scale) && median.scale >= 0 && median.scale <= 18, 'INVALID_REQUEST', `candidates[${index}] benchmark median scale is invalid`);
  return {
    revision: value.revision ?? null,
    observations: value.observations ?? null,
    median: clone(median),
  };
}

function normalizedCandidate(raw, market, index) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_REQUEST', `candidates[${index}] must be an object`);
  const offer = normalizeOffer(raw.offer, market, index);
  return {
    offer,
    providerHistory: normalizeProviderHistory(raw.providerHistory, offer, index),
    priceBenchmark: normalizeBenchmark(raw.priceBenchmark, market, index),
  };
}

function settledRate(history) {
  if (history == null || history.terminalOutcomes === 0) return null;
  return { numerator: history.settledOutcomes, denominator: history.terminalOutcomes };
}

function offerWithinBenchmarkPremium(offerPrice, benchmark, premiumBasisPoints) {
  const median = benchmark.median;
  const scale = Math.max(offerPrice.scale, median.scale);
  const offerScaled = BigInt(offerPrice.amount) * (10n ** BigInt(scale - offerPrice.scale));
  const medianNumeratorScaled = BigInt(median.amountNumerator) * (10n ** BigInt(scale - median.scale));
  const medianDenominator = BigInt(median.amountDenominator);
  return offerScaled * medianDenominator * 10000n
    <= medianNumeratorScaled * BigInt(10000 + premiumBasisPoints);
}

function reject(rejections, code, detail) {
  rejections.push({ code, detail });
}

function evaluateCandidate(candidate, quantity, policy) {
  const { offer, providerHistory, priceBenchmark } = candidate;
  const rejections = [];
  if (offer.status !== 'open') reject(rejections, 'OFFER_NOT_OPEN', 'offer is not open');
  if (offer.remaining < quantity) reject(rejections, 'INSUFFICIENT_CAPACITY', 'offer remaining capacity is below requested quantity');

  if (policy.maxUnitPrice !== null) {
    invariant(policy.maxUnitPrice.settlementAsset === offer.unitPrice.settlementAsset, 'INVALID_REQUEST', 'policy maxUnitPrice settlement asset does not match market');
    if (compareMoney(offer.unitPrice, policy.maxUnitPrice) > 0) reject(rejections, 'PRICE_ABOVE_MAXIMUM', 'offer unit price exceeds buyer maximum');
  }

  const needsHistory = policy.minProviderOrders !== null
    || policy.minSettledOutcomeBasisPoints !== null
    || policy.maxAverageDeliveryMs !== null;
  if (needsHistory && providerHistory === null) {
    reject(rejections, 'PROVIDER_HISTORY_REQUIRED', 'buyer policy requires provider history evidence');
  } else if (providerHistory !== null) {
    if (policy.minProviderOrders !== null && providerHistory.totalOrders < policy.minProviderOrders) {
      reject(rejections, 'INSUFFICIENT_PROVIDER_HISTORY', 'provider order history is below buyer minimum');
    }
    if (policy.minSettledOutcomeBasisPoints !== null) {
      if (providerHistory.terminalOutcomes === 0) {
        reject(rejections, 'INSUFFICIENT_PROVIDER_HISTORY', 'provider has no terminal outcomes for settled-rate evaluation');
      } else if (BigInt(providerHistory.settledOutcomes) * 10000n
        < BigInt(policy.minSettledOutcomeBasisPoints) * BigInt(providerHistory.terminalOutcomes)) {
        reject(rejections, 'SETTLED_RATE_BELOW_MINIMUM', 'provider settled terminal-outcome rate is below buyer minimum');
      }
    }
    if (policy.maxAverageDeliveryMs !== null) {
      if (providerHistory.averageDeliveryMs === null) {
        reject(rejections, 'DELIVERY_HISTORY_REQUIRED', 'provider has no observed delivery latency');
      } else if (providerHistory.averageDeliveryMs > policy.maxAverageDeliveryMs) {
        reject(rejections, 'DELIVERY_LATENCY_ABOVE_MAXIMUM', 'provider average observed delivery latency exceeds buyer maximum');
      }
    }
  }

  if (policy.maxPremiumOverMedianBasisPoints !== null) {
    if (priceBenchmark === null) {
      reject(rejections, 'PRICE_BENCHMARK_REQUIRED', 'buyer policy requires settled market price evidence');
    } else if (!offerWithinBenchmarkPremium(offer.unitPrice, priceBenchmark, policy.maxPremiumOverMedianBasisPoints)) {
      reject(rejections, 'PREMIUM_ABOVE_MARKET_LIMIT', 'offer price exceeds buyer premium limit over settled market median');
    }
  }

  const rate = settledRate(providerHistory);
  return {
    offerId: offer.id,
    sellerId: offer.sellerId,
    eligible: rejections.length === 0,
    rejections,
    evidence: {
      remaining: offer.remaining,
      offerVersion: offer.version,
      unitPrice: clone(offer.unitPrice),
      providerHistoryRevision: providerHistory?.revision ?? null,
      providerOrders: providerHistory?.totalOrders ?? null,
      terminalOutcomes: providerHistory?.terminalOutcomes ?? null,
      settledOutcomes: providerHistory?.settledOutcomes ?? null,
      settledRate: rate,
      averageDeliveryMs: providerHistory?.averageDeliveryMs ?? null,
      priceBenchmarkRevision: priceBenchmark?.revision ?? null,
      priceBenchmarkObservations: priceBenchmark?.observations ?? null,
      priceBenchmarkMedian: clone(priceBenchmark?.median ?? null),
    },
  };
}

function compareRates(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const l = BigInt(left.numerator) * BigInt(right.denominator);
  const r = BigInt(right.numerator) * BigInt(left.denominator);
  return l > r ? -1 : l < r ? 1 : 0;
}

function compareNullableNumberAsc(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareEvaluations(left, right, priorities) {
  for (const priority of priorities) {
    let comparison = 0;
    if (priority === 'unit-price-asc') comparison = compareMoney(left.evidence.unitPrice, right.evidence.unitPrice);
    if (priority === 'provider-settled-rate-desc') comparison = compareRates(left.evidence.settledRate, right.evidence.settledRate);
    if (priority === 'provider-orders-desc') {
      const leftOrders = left.evidence.providerOrders;
      const rightOrders = right.evidence.providerOrders;
      if (leftOrders === null && rightOrders === null) comparison = 0;
      else if (leftOrders === null) comparison = 1;
      else if (rightOrders === null) comparison = -1;
      else comparison = rightOrders - leftOrders;
    }
    if (priority === 'delivery-latency-asc') comparison = compareNullableNumberAsc(left.evidence.averageDeliveryMs, right.evidence.averageDeliveryMs);
    if (priority === 'seller-id-asc') comparison = left.sellerId.localeCompare(right.sellerId);
    if (comparison !== 0) return comparison;
  }
  return left.offerId.localeCompare(right.offerId);
}

/**
 * Applies a buyer-supplied, inspectable procurement policy to candidate offers.
 *
 * The evaluator is pure decision support: it does not reserve capacity or mutate
 * market state. Hard gates and lexicographic priorities are explicit in the
 * returned policy, and every rejection/evidence field remains attributable.
 */
export class TransparentProcurementEvaluator {
  evaluate({ market, quantity, candidates, policy = {} }) {
    const normalizedMarket = normalizeMarket(market);
    const normalizedQuantity = positiveInteger(quantity, 'quantity');
    invariant(Array.isArray(candidates) && candidates.length > 0, 'INVALID_REQUEST', 'candidates must be a non-empty array');
    const normalizedPolicy = normalizePolicy(policy);
    if (normalizedPolicy.maxUnitPrice !== null) {
      invariant(normalizedPolicy.maxUnitPrice.settlementAsset === normalizedMarket.settlementAsset, 'INVALID_REQUEST', 'policy maxUnitPrice settlement asset does not match market');
    }
    const normalizedCandidates = candidates.map((candidate, index) => normalizedCandidate(candidate, normalizedMarket, index));
    const offerIds = normalizedCandidates.map((candidate) => candidate.offer.id);
    invariant(new Set(offerIds).size === offerIds.length, 'INVALID_REQUEST', 'candidate offer IDs must be unique');

    const evaluations = normalizedCandidates.map((candidate) => evaluateCandidate(candidate, normalizedQuantity, normalizedPolicy));
    const eligible = evaluations
      .filter((evaluation) => evaluation.eligible)
      .sort((left, right) => compareEvaluations(left, right, normalizedPolicy.priorities))
      .map((evaluation, index) => ({ rank: index + 1, ...clone(evaluation) }));
    const rejected = evaluations
      .filter((evaluation) => !evaluation.eligible)
      .sort((left, right) => left.offerId.localeCompare(right.offerId))
      .map((evaluation) => clone(evaluation));

    return {
      market: normalizedMarket,
      quantity: normalizedQuantity,
      policy: clone(normalizedPolicy),
      preferredOfferId: eligible[0]?.offerId ?? null,
      eligible,
      rejected,
    };
  }
}
