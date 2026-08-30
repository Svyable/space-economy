import assert from 'node:assert/strict';
import test from 'node:test';
import { buildObligationNettingCycle } from '../src/obligation-netting.js';

const usd = (amount, scale = 2) => ({ settlementAsset: 'iso4217:USD', amount, scale });
const digest = (hex) => `sha256:${hex.repeat(64).slice(0, 64)}`;

function obligation(obligationId, debtorId, creditorId, amount, scale = 2) {
  return {
    obligationId,
    debtorId,
    creditorId,
    amount: usd(amount, scale),
    sourceRef: `order:${obligationId}`,
    sourceDigest: digest(obligationId === 'a' ? 'a' : obligationId === 'b' ? 'b' : 'c'),
  };
}

function baseInput(overrides = {}) {
  return {
    settlementAsset: 'iso4217:USD',
    asOf: '2026-09-01T12:00:00Z',
    cutoff: { type: 'ledger-revision', clearinghouseId: 'clearinghouse-a', revision: 42 },
    obligations: [
      obligation('a', 'alpha', 'beta', '10000'),
      obligation('b', 'beta', 'gamma', '7000'),
      obligation('c', 'gamma', 'alpha', '2000'),
    ],
    ...overrides,
  };
}

test('nets a multilateral obligation graph exactly and conserves zero-sum positions', () => {
  const cycle = buildObligationNettingCycle(baseInput());

  assert.deepEqual(cycle.positions.map((row) => [row.participantId, row.direction, row.signedNetAmount]), [
    ['alpha', 'pay', '-8000'],
    ['beta', 'receive', '3000'],
    ['gamma', 'receive', '5000'],
  ]);
  assert.equal(cycle.grossNotional.amount, '19000');
  assert.equal(cycle.netSettlementNotional.amount, '8000');
  assert.equal(cycle.nettingReduction.amount, '11000');
  assert.equal(cycle.instructionCount, 2);
  assert.deepEqual(cycle.settlementInstructions.map((instruction) => [instruction.payerId, instruction.receiverId, instruction.amount.amount]), [
    ['alpha', 'beta', '3000'],
    ['alpha', 'gamma', '5000'],
  ]);
  assert.equal(cycle.positions.reduce((sum, row) => sum + BigInt(row.signedNetAmount), 0n), 0n);
  assert.equal(cycle.custody, false);
  assert.equal(cycle.finalityClaimed, false);
  assert.match(cycle.cycleHash, /^sha256:[0-9a-f]{64}$/);
});

test('aligns decimal scales with integer arithmetic and never uses floating point', () => {
  const cycle = buildObligationNettingCycle(baseInput({
    obligations: [
      obligation('a', 'alpha', 'beta', '1', 0),
      obligation('b', 'beta', 'alpha', '50', 2),
    ],
  }));

  assert.equal(cycle.scale, 2);
  assert.deepEqual(cycle.positions.map((row) => [row.participantId, row.signedNetAmount]), [
    ['alpha', '-50'],
    ['beta', '50'],
  ]);
  assert.equal(cycle.settlementInstructions[0].amount.amount, '50');
});

test('cycle hash and instructions are deterministic independent of obligation insertion order', () => {
  const first = buildObligationNettingCycle(baseInput());
  const second = buildObligationNettingCycle(baseInput({ obligations: [...baseInput().obligations].reverse() }));

  assert.equal(first.cycleHash, second.cycleHash);
  assert.deepEqual(first.settlementInstructions, second.settlementInstructions);
  assert.deepEqual(first.positions, second.positions);
});

test('rejects cross-asset netting and duplicate source obligations', () => {
  const foreign = baseInput();
  foreign.obligations[1].amount = { settlementAsset: 'iso4217:EUR', amount: '7000', scale: 2 };
  assert.throws(() => buildObligationNettingCycle(foreign), (error) => error.code === 'ASSET_MISMATCH');

  const duplicate = baseInput();
  duplicate.obligations[1].sourceRef = duplicate.obligations[0].sourceRef;
  assert.throws(() => buildObligationNettingCycle(duplicate), (error) => error.code === 'DUPLICATE_SOURCE');
});

test('collateral coverage is exact, attributable, and does not become a custody claim', () => {
  const collateral = {
    subjectId: 'alpha',
    amount: usd('4000'),
    verifierId: 'collateral-verifier-a',
    profileId: 'bank-balance-attestation-v1',
    evidenceDigest: digest('d'),
    validFrom: '2026-09-01T00:00:00Z',
    validUntil: '2026-09-02T00:00:00Z',
  };
  const cycle = buildObligationNettingCycle(baseInput({
    collateralPolicy: { minimumCoverageBps: 5000 },
    collateralAttestations: [collateral],
  }));

  assert.equal(cycle.collateralCoverage[0].participantId, 'alpha');
  assert.equal(cycle.collateralCoverage[0].payable.amount, '8000');
  assert.equal(cycle.collateralCoverage[0].activeCollateral.amount, '4000');
  assert.equal(cycle.collateralCoverage[0].satisfied, true);
  assert.equal(cycle.custody, false);

  assert.throws(() => buildObligationNettingCycle(baseInput({
    collateralPolicy: { minimumCoverageBps: 5001 },
    collateralAttestations: [collateral],
  })), (error) => error.code === 'INSUFFICIENT_COLLATERAL');
});

test('expired collateral evidence cannot satisfy exposure policy', () => {
  assert.throws(() => buildObligationNettingCycle(baseInput({
    collateralPolicy: { minimumCoverageBps: 1 },
    collateralAttestations: [{
      subjectId: 'alpha',
      amount: usd('999999'),
      verifierId: 'verifier',
      profileId: 'profile',
      evidenceDigest: digest('e'),
      validFrom: '2026-08-01T00:00:00Z',
      validUntil: '2026-08-31T00:00:00Z',
    }],
  })), (error) => error.code === 'INSUFFICIENT_COLLATERAL');
});

test('federated cutoff requires an attributable checkpoint digest', () => {
  const cycle = buildObligationNettingCycle(baseInput({
    cutoff: {
      type: 'federation-checkpoint',
      clearinghouseId: 'remote-clearinghouse',
      checkpointHash: digest('f'),
    },
  }));
  assert.equal(cycle.cutoff.type, 'federation-checkpoint');
  assert.match(cycle.cutoff.checkpointHash, /^sha256:[0-9a-f]{64}$/);

  assert.throws(() => buildObligationNettingCycle(baseInput({
    cutoff: { type: 'federation-checkpoint', clearinghouseId: 'remote', checkpointHash: 'not-a-hash' },
  })), (error) => error.code === 'INVALID_REQUEST');
});
