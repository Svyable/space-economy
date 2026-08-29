import assert from 'node:assert/strict';
import test from 'node:test';
import { TransparentProcurementEvaluator } from '../src/procurement-evaluation.js';

const market = {
  service: 'data-relay',
  unit: 'MB',
  settlementAsset: 'iso4217:USD',
};

function offer(id, sellerId, amount, overrides = {}) {
  return {
    id,
    sellerId,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale: 2 },
    remaining: 100,
    status: 'open',
    version: 3,
    ...overrides,
  };
}

function history(sellerId, {
  orders = 20,
  settled = 18,
  terminal = 20,
  deliveryMs = 120000,
  revision = 40,
} = {}) {
  return {
    sellerId,
    service: 'data-relay',
    revision,
    orders: { total: orders },
    terminalOutcomes: { total: terminal, settled },
    timing: { delivery: { averageMs: deliveryMs } },
  };
}

function benchmark({ numerator = '225', denominator = '2', scale = 2, observations = 30 } = {}) {
  return {
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    revision: 50,
    observations,
    unitPrice: {
      median: {
        settlementAsset: 'iso4217:USD',
        amountNumerator: numerator,
        amountDenominator: denominator,
        scale,
      },
    },
  };
}

test('hard gates reject capacity, price, history, rate, and latency violations with explicit reasons', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const result = evaluator.evaluate({
    market,
    quantity: 10,
    policy: {
      maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '150', scale: 2 },
      minProviderOrders: 10,
      minSettledOutcomeBasisPoints: 8000,
      maxAverageDeliveryMs: 300000,
    },
    candidates: [
      { offer: offer('good', 'seller-good', '125'), providerHistory: history('seller-good') },
      { offer: offer('capacity', 'seller-capacity', '125', { remaining: 5 }), providerHistory: history('seller-capacity') },
      { offer: offer('price', 'seller-price', '151'), providerHistory: history('seller-price') },
      { offer: offer('depth', 'seller-depth', '125'), providerHistory: history('seller-depth', { orders: 4 }) },
      { offer: offer('rate', 'seller-rate', '125'), providerHistory: history('seller-rate', { settled: 7, terminal: 10 }) },
      { offer: offer('latency', 'seller-latency', '125'), providerHistory: history('seller-latency', { deliveryMs: 300001 }) },
    ],
  });

  assert.equal(result.preferredOfferId, 'good');
  assert.deepEqual(result.eligible.map((item) => item.offerId), ['good']);
  const reasons = Object.fromEntries(result.rejected.map((item) => [item.offerId, item.rejections.map((reason) => reason.code)]));
  assert.deepEqual(reasons.capacity, ['INSUFFICIENT_CAPACITY']);
  assert.deepEqual(reasons.price, ['PRICE_ABOVE_MAXIMUM']);
  assert.deepEqual(reasons.depth, ['INSUFFICIENT_PROVIDER_HISTORY']);
  assert.deepEqual(reasons.rate, ['SETTLED_RATE_BELOW_MINIMUM']);
  assert.deepEqual(reasons.latency, ['DELIVERY_LATENCY_ABOVE_MAXIMUM']);
});

test('compares offer premium against an exact rational settled median', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const evidence = benchmark(); // USD 1.125 exactly
  const result = evaluator.evaluate({
    market,
    quantity: 1,
    policy: {
      maxPremiumOverMedianBasisPoints: 0,
      priorities: ['unit-price-asc'],
    },
    candidates: [
      { offer: offer('below', 'seller-a', '112'), priceBenchmark: evidence },
      { offer: offer('above', 'seller-b', '113'), priceBenchmark: evidence },
    ],
  });
  assert.deepEqual(result.eligible.map((item) => item.offerId), ['below']);
  assert.deepEqual(result.rejected[0].rejections.map((reason) => reason.code), ['PREMIUM_ABOVE_MARKET_LIMIT']);

  const withPremium = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { maxPremiumOverMedianBasisPoints: 100 }, // 1% permits 1.13 over 1.125
    candidates: [{ offer: offer('now-eligible', 'seller-c', '113'), priceBenchmark: evidence }],
  });
  assert.equal(withPremium.preferredOfferId, 'now-eligible');
});

test('buyer-declared priority order can prefer price or execution history transparently', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const cheap = {
    offer: offer('cheap', 'seller-cheap', '100'),
    providerHistory: history('seller-cheap', { settled: 5, terminal: 10, orders: 10, deliveryMs: 300000 }),
  };
  const reliable = {
    offer: offer('reliable', 'seller-reliable', '120'),
    providerHistory: history('seller-reliable', { settled: 10, terminal: 10, orders: 50, deliveryMs: 60000 }),
  };

  const priceFirst = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { priorities: ['unit-price-asc', 'provider-settled-rate-desc'] },
    candidates: [reliable, cheap],
  });
  assert.deepEqual(priceFirst.eligible.map((item) => item.offerId), ['cheap', 'reliable']);

  const reliabilityFirst = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { priorities: ['provider-settled-rate-desc', 'unit-price-asc'] },
    candidates: [cheap, reliable],
  });
  assert.deepEqual(reliabilityFirst.eligible.map((item) => item.offerId), ['reliable', 'cheap']);
  assert.deepEqual(reliabilityFirst.policy.priorities, ['provider-settled-rate-desc', 'unit-price-asc']);
  assert.equal('score' in reliabilityFirst.eligible[0], false);
});

test('missing evidence is only a hard failure when buyer policy requires it', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const noEvidence = { offer: offer('plain', 'seller-plain', '100') };

  const permissive = evaluator.evaluate({ market, quantity: 1, candidates: [noEvidence] });
  assert.equal(permissive.preferredOfferId, 'plain');
  assert.equal(permissive.eligible[0].evidence.settledRate, null);

  const needsHistory = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { minProviderOrders: 1 },
    candidates: [noEvidence],
  });
  assert.deepEqual(needsHistory.rejected[0].rejections.map((reason) => reason.code), ['PROVIDER_HISTORY_REQUIRED']);

  const needsBenchmark = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { maxPremiumOverMedianBasisPoints: 1000 },
    candidates: [noEvidence],
  });
  assert.deepEqual(needsBenchmark.rejected[0].rejections.map((reason) => reason.code), ['PRICE_BENCHMARK_REQUIRED']);
});

test('priorities treat missing optional evidence as less preferred rather than fabricating values', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const result = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { priorities: ['provider-settled-rate-desc', 'delivery-latency-asc'] },
    candidates: [
      { offer: offer('unknown', 'seller-a', '100') },
      { offer: offer('known', 'seller-b', '100'), providerHistory: history('seller-b', { settled: 1, terminal: 1, deliveryMs: 100000 }) },
    ],
  });
  assert.deepEqual(result.eligible.map((item) => item.offerId), ['known', 'unknown']);
});

test('identical evidence has deterministic offer-id tie breaking', () => {
  const evaluator = new TransparentProcurementEvaluator();
  const result = evaluator.evaluate({
    market,
    quantity: 1,
    policy: { priorities: ['unit-price-asc'] },
    candidates: [
      { offer: offer('offer-z', 'same-seller', '100') },
      { offer: offer('offer-a', 'same-seller', '100') },
    ],
  });
  assert.deepEqual(result.eligible.map((item) => item.offerId), ['offer-a', 'offer-z']);
});

test('rejects incomparable or mismatched evidence instead of silently coercing it', () => {
  const evaluator = new TransparentProcurementEvaluator();
  assert.throws(
    () => evaluator.evaluate({
      market,
      quantity: 1,
      candidates: [{ offer: offer('wrong-service', 'seller', '100', { service: 'compute' }) }],
    }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => evaluator.evaluate({
      market,
      quantity: 1,
      candidates: [{ offer: offer('wrong-history', 'seller-a', '100'), providerHistory: history('seller-b') }],
    }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => evaluator.evaluate({
      market,
      quantity: 1,
      policy: { priorities: ['mystery-score-desc'] },
      candidates: [{ offer: offer('offer', 'seller', '100') }],
    }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
