import { sha256Canonical } from './canonical-json.js';

const clone = (value) => structuredClone(value);
const SCHEMA_VERSION = 1;
const BPS_DENOMINATOR = 10_000n;

export class ObligationNettingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ObligationNettingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new ObligationNettingError(code, message, details);
}

function text(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function digest(value, field) {
  const normalized = text(value, field);
  invariant(/^sha256:[0-9a-f]{64}$/.test(normalized), 'INVALID_REQUEST', `${field} must be a sha256 digest`);
  return normalized;
}

function timestamp(value, field) {
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), 'INVALID_REQUEST', `${field} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeMoney(value, field, settlementAsset = null) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `${field} is required`);
  const asset = text(value.settlementAsset, `${field}.settlementAsset`);
  if (settlementAsset !== null) invariant(asset === settlementAsset, 'ASSET_MISMATCH', `${field} uses a different settlement asset`, { expected: settlementAsset, actual: asset });
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_REQUEST', `${field}.amount must be an unsigned integer string`);
  invariant(BigInt(value.amount) > 0n, 'INVALID_REQUEST', `${field}.amount must be positive`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', `${field}.scale must be an integer from 0 to 18`);
  return { settlementAsset: asset, amount: value.amount, scale: value.scale };
}

function scaleAmount(amount, fromScale, toScale) {
  invariant(toScale >= fromScale, 'INVALID_CONFIGURATION', 'target scale may not be smaller than source scale');
  return BigInt(amount) * (10n ** BigInt(toScale - fromScale));
}

function signedAmount(value) {
  return value.toString();
}

function absoluteMoney(settlementAsset, amount, scale) {
  return { settlementAsset, amount: (amount < 0n ? -amount : amount).toString(), scale };
}

function normalizeCutoff(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'cutoff is required');
  const type = text(value.type, 'cutoff.type');
  const clearinghouseId = text(value.clearinghouseId, 'cutoff.clearinghouseId');
  if (type === 'ledger-revision') {
    invariant(Number.isSafeInteger(value.revision) && value.revision >= 0, 'INVALID_REQUEST', 'cutoff.revision must be a non-negative safe integer');
    return { type, clearinghouseId, revision: value.revision };
  }
  if (type === 'federation-checkpoint') {
    return { type, clearinghouseId, checkpointHash: digest(value.checkpointHash, 'cutoff.checkpointHash') };
  }
  throw new ObligationNettingError('INVALID_REQUEST', 'unsupported cutoff type');
}

function normalizeObligation(value, index, settlementAsset) {
  const obligationId = text(value?.obligationId, `obligations[${index}].obligationId`);
  const debtorId = text(value?.debtorId, `obligations[${index}].debtorId`);
  const creditorId = text(value?.creditorId, `obligations[${index}].creditorId`);
  invariant(debtorId !== creditorId, 'INVALID_REQUEST', 'obligation debtor and creditor must differ', { obligationId });
  return {
    obligationId,
    debtorId,
    creditorId,
    amount: normalizeMoney(value?.amount, `obligations[${index}].amount`, settlementAsset),
    sourceRef: text(value?.sourceRef, `obligations[${index}].sourceRef`),
    sourceDigest: digest(value?.sourceDigest, `obligations[${index}].sourceDigest`),
  };
}

function normalizeCollateral(value, index, settlementAsset, asOf) {
  const validFrom = timestamp(value?.validFrom, `collateralAttestations[${index}].validFrom`);
  const validUntil = timestamp(value?.validUntil, `collateralAttestations[${index}].validUntil`);
  invariant(Date.parse(validFrom) < Date.parse(validUntil), 'INVALID_REQUEST', 'collateral attestation validFrom must precede validUntil');
  const observed = Date.parse(asOf);
  return {
    subjectId: text(value?.subjectId, `collateralAttestations[${index}].subjectId`),
    amount: normalizeMoney(value?.amount, `collateralAttestations[${index}].amount`, settlementAsset),
    verifierId: text(value?.verifierId, `collateralAttestations[${index}].verifierId`),
    profileId: text(value?.profileId, `collateralAttestations[${index}].profileId`),
    evidenceDigest: digest(value?.evidenceDigest, `collateralAttestations[${index}].evidenceDigest`),
    validFrom,
    validUntil,
    active: Date.parse(validFrom) <= observed && observed < Date.parse(validUntil),
  };
}

function normalizeCollateralPolicy(value) {
  if (value === null || value === undefined) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'collateralPolicy must be an object');
  invariant(Number.isSafeInteger(value.minimumCoverageBps) && value.minimumCoverageBps >= 0 && value.minimumCoverageBps <= 10_000, 'INVALID_REQUEST', 'collateralPolicy.minimumCoverageBps must be an integer from 0 to 10000');
  return { minimumCoverageBps: value.minimumCoverageBps };
}

function add(map, participantId, amount) {
  map.set(participantId, (map.get(participantId) ?? 0n) + amount);
}

function buildInstructions(payers, receivers, settlementAsset, scale) {
  const instructions = [];
  let payerIndex = 0;
  let receiverIndex = 0;
  const pay = payers.map((entry) => ({ ...entry }));
  const receive = receivers.map((entry) => ({ ...entry }));

  while (payerIndex < pay.length && receiverIndex < receive.length) {
    const payer = pay[payerIndex];
    const receiver = receive[receiverIndex];
    const amount = payer.remaining < receiver.remaining ? payer.remaining : receiver.remaining;
    invariant(amount > 0n, 'CORRUPT_NETTING', 'settlement instruction amount must be positive');
    instructions.push({
      payerId: payer.participantId,
      receiverId: receiver.participantId,
      amount: { settlementAsset, amount: amount.toString(), scale },
    });
    payer.remaining -= amount;
    receiver.remaining -= amount;
    if (payer.remaining === 0n) payerIndex += 1;
    if (receiver.remaining === 0n) receiverIndex += 1;
  }

  invariant(pay.every((entry) => entry.remaining === 0n) && receive.every((entry) => entry.remaining === 0n), 'CORRUPT_NETTING', 'payer and receiver totals do not balance');
  return instructions;
}

/**
 * Pure deterministic netting over attributable obligations.
 *
 * This function computes obligations and settlement instructions only. It does
 * not move money, custody collateral, mark clearinghouse orders settled, or
 * claim external settlement finality.
 */
export function buildObligationNettingCycle(input) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST', 'netting cycle input is required');
  const settlementAsset = text(input.settlementAsset, 'settlementAsset');
  const asOf = timestamp(input.asOf, 'asOf');
  const cutoff = normalizeCutoff(input.cutoff);
  invariant(Array.isArray(input.obligations) && input.obligations.length > 0, 'INVALID_REQUEST', 'obligations must be a non-empty array');
  invariant(input.obligations.length <= 10_000, 'INVALID_REQUEST', 'obligations may contain at most 10000 entries');

  const obligations = input.obligations.map((value, index) => normalizeObligation(value, index, settlementAsset));
  invariant(new Set(obligations.map((value) => value.obligationId)).size === obligations.length, 'DUPLICATE_OBLIGATION', 'obligationId values must be unique');
  invariant(new Set(obligations.map((value) => value.sourceRef)).size === obligations.length, 'DUPLICATE_SOURCE', 'sourceRef values must be unique');
  obligations.sort((left, right) => left.obligationId.localeCompare(right.obligationId));

  const scale = Math.max(...obligations.map((value) => value.amount.scale));
  const positions = new Map();
  const grossPayables = new Map();
  const grossReceivables = new Map();
  let grossNotional = 0n;

  const normalizedObligations = obligations.map((obligation) => {
    const amount = scaleAmount(obligation.amount.amount, obligation.amount.scale, scale);
    grossNotional += amount;
    add(positions, obligation.debtorId, -amount);
    add(positions, obligation.creditorId, amount);
    add(grossPayables, obligation.debtorId, amount);
    add(grossReceivables, obligation.creditorId, amount);
    return {
      obligationId: obligation.obligationId,
      debtorId: obligation.debtorId,
      creditorId: obligation.creditorId,
      amount: { settlementAsset, amount: amount.toString(), scale },
      sourceRef: obligation.sourceRef,
      sourceDigest: obligation.sourceDigest,
    };
  });

  const totalPosition = [...positions.values()].reduce((sum, value) => sum + value, 0n);
  invariant(totalPosition === 0n, 'CORRUPT_NETTING', 'participant net positions do not sum to zero');

  const participantIds = [...positions.keys()].sort();
  const positionRows = participantIds.map((participantId) => {
    const net = positions.get(participantId);
    return {
      participantId,
      direction: net < 0n ? 'pay' : net > 0n ? 'receive' : 'flat',
      netAmount: absoluteMoney(settlementAsset, net, scale),
      signedNetAmount: signedAmount(net),
      grossPayable: { settlementAsset, amount: (grossPayables.get(participantId) ?? 0n).toString(), scale },
      grossReceivable: { settlementAsset, amount: (grossReceivables.get(participantId) ?? 0n).toString(), scale },
    };
  });

  const payers = positionRows
    .filter((row) => row.direction === 'pay')
    .map((row) => ({ participantId: row.participantId, remaining: -BigInt(row.signedNetAmount) }));
  const receivers = positionRows
    .filter((row) => row.direction === 'receive')
    .map((row) => ({ participantId: row.participantId, remaining: BigInt(row.signedNetAmount) }));
  const instructionCore = buildInstructions(payers, receivers, settlementAsset, scale);
  const netSettlementNotional = instructionCore.reduce((sum, instruction) => sum + BigInt(instruction.amount.amount), 0n);
  invariant(netSettlementNotional <= grossNotional, 'CORRUPT_NETTING', 'net settlement exceeds gross obligations');

  const collateralPolicy = normalizeCollateralPolicy(input.collateralPolicy);
  const collateralAttestations = (input.collateralAttestations ?? []).map((value, index) => normalizeCollateral(value, index, settlementAsset, asOf));
  const activeCollateral = collateralAttestations.filter((value) => value.active);
  const coverageScale = Math.max(scale, ...activeCollateral.map((value) => value.amount.scale), scale);
  const collateralBySubject = new Map();
  for (const attestation of activeCollateral) {
    add(collateralBySubject, attestation.subjectId, scaleAmount(attestation.amount.amount, attestation.amount.scale, coverageScale));
  }

  const collateralCoverage = positionRows
    .filter((row) => row.direction === 'pay')
    .map((row) => {
      const payable = scaleAmount(row.netAmount.amount, row.netAmount.scale, coverageScale);
      const collateral = collateralBySubject.get(row.participantId) ?? 0n;
      const requiredBps = collateralPolicy?.minimumCoverageBps ?? 0;
      const satisfied = collateral * BPS_DENOMINATOR >= payable * BigInt(requiredBps);
      return {
        participantId: row.participantId,
        payable: { settlementAsset, amount: payable.toString(), scale: coverageScale },
        activeCollateral: { settlementAsset, amount: collateral.toString(), scale: coverageScale },
        minimumCoverageBps: requiredBps,
        satisfied,
      };
    });

  if (collateralPolicy) {
    const failures = collateralCoverage.filter((row) => !row.satisfied);
    invariant(failures.length === 0, 'INSUFFICIENT_COLLATERAL', 'one or more payable positions fail collateral coverage policy', { participants: failures.map((row) => row.participantId) });
  }

  const canonicalCore = {
    schemaVersion: SCHEMA_VERSION,
    settlementAsset,
    scale,
    asOf,
    cutoff,
    obligations: normalizedObligations,
    positions: positionRows,
    instructions: instructionCore,
    grossNotional: { settlementAsset, amount: grossNotional.toString(), scale },
    netSettlementNotional: { settlementAsset, amount: netSettlementNotional.toString(), scale },
    collateralPolicy,
    collateralCoverage,
    collateralEvidence: collateralAttestations
      .map((value) => clone(value))
      .sort((left, right) => left.subjectId.localeCompare(right.subjectId) || left.evidenceDigest.localeCompare(right.evidenceDigest)),
  };
  const cycleHash = `sha256:${sha256Canonical(canonicalCore)}`;
  const settlementInstructions = instructionCore.map((instruction, index) => ({
    instructionId: `sha256:${sha256Canonical({ cycleHash, index, ...instruction })}`,
    ...instruction,
  }));

  return {
    ...canonicalCore,
    cycleHash,
    settlementInstructions,
    nettingReduction: { settlementAsset, amount: (grossNotional - netSettlementNotional).toString(), scale },
    instructionCount: settlementInstructions.length,
    participantCount: positionRows.length,
    obligationCount: normalizedObligations.length,
    custody: false,
    finalityClaimed: false,
  };
}
