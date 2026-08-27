import assert from 'node:assert/strict';
import test from 'node:test';
import { PolicyGateEngine } from '../src/policy.js';

const fixedClock = () => new Date('2026-08-26T21:30:00.000Z');
const request = {
  operation: 'order.reserve',
  actor: { actorId: 'operator-one', credentials: ['license:example'] },
  resource: { offerId: 'offer-1', service: 'orbital-transfer' },
  context: { jurisdiction: 'example' },
};

test('evaluates gates deterministically and hashes attributable decisions', async () => {
  const engine = new PolicyGateEngine({ clock: fixedClock });
  engine.register('z-license', {
    version: '2',
    async evaluate(input) {
      assert.equal(input.actor.actorId, 'operator-one');
      return { decision: 'allow', reason: 'license active', claims: { license: 'example' } };
    },
  });
  engine.register('a-mission-safety', {
    version: '1',
    async evaluate() {
      return { decision: 'allow', reason: 'no blocking mission-safety rule' };
    },
  });

  const evaluation = await engine.evaluate(request);
  assert.equal(evaluation.decision, 'allow');
  assert.deepEqual(evaluation.results.map((result) => result.gateId), ['a-mission-safety', 'z-license']);
  assert.match(evaluation.results[0].decisionHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(evaluation.evaluationHash, /^sha256:[0-9a-f]{64}$/);
});

test('deny outranks review and review outranks allow', async () => {
  const engine = new PolicyGateEngine({ clock: fixedClock });
  engine.register('allow', { version: '1', evaluate: async () => ({ decision: 'allow', reason: 'ok' }) });
  engine.register('review', { version: '1', evaluate: async () => ({ decision: 'review', reason: 'human approval required' }) });
  engine.register('deny', { version: '1', evaluate: async () => ({ decision: 'deny', reason: 'blocked' }) });
  assert.equal((await engine.evaluate(request)).decision, 'deny');

  const reviewEngine = new PolicyGateEngine({ clock: fixedClock });
  reviewEngine.register('allow', { version: '1', evaluate: async () => ({ decision: 'allow', reason: 'ok' }) });
  reviewEngine.register('review', { version: '1', evaluate: async () => ({ decision: 'review', reason: 'human approval required' }) });
  assert.equal((await reviewEngine.evaluate(request)).decision, 'review');
});

test('requireAllowed fails closed for review or deny decisions with audit details', async () => {
  const engine = new PolicyGateEngine({ clock: fixedClock });
  engine.register('export-policy', {
    version: '2026-08',
    evaluate: async () => ({ decision: 'review', reason: 'manual jurisdiction review required' }),
  });
  await assert.rejects(
    engine.requireAllowed(request),
    (error) => error.code === 'POLICY_NOT_ALLOWED'
      && error.details.decision === 'review'
      && /^sha256:/.test(error.details.evaluationHash),
  );
});

test('gate execution failures are attributable and fail closed', async () => {
  const engine = new PolicyGateEngine({ clock: fixedClock });
  engine.register('external-risk', {
    version: '1',
    async evaluate() { throw new Error('upstream unavailable'); },
  });
  await assert.rejects(
    engine.evaluate(request),
    (error) => error.code === 'POLICY_GATE_FAILED'
      && error.details.gateId === 'external-risk'
      && error.details.cause === 'upstream unavailable',
  );
});

test('duplicate gate identifiers cannot silently replace policy behavior', () => {
  const engine = new PolicyGateEngine();
  engine.register('license', { version: '1', evaluate: async () => ({ decision: 'allow', reason: 'ok' }) });
  assert.throws(
    () => engine.register('license', { version: '2', evaluate: async () => ({ decision: 'deny', reason: 'changed' }) }),
    (error) => error.code === 'POLICY_GATE_EXISTS',
  );
});

test('an explicitly empty policy set is neutral rather than inventing policy', async () => {
  const engine = new PolicyGateEngine({ clock: fixedClock });
  const evaluation = await engine.evaluate(request);
  assert.equal(evaluation.decision, 'allow');
  assert.deepEqual(evaluation.results, []);
});
