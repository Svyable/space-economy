import { sha256Canonical } from '../canonical-json.js';
import { verifyFederationCheckpoint, verifyFederationExtension } from '../federation.js';
import { FEDERATED_CAPACITY_RIGHT_ADMISSION_SCHEMA } from './federated-capacity-rights.js';

const clone = (value) => structuredClone(value);
const INTENT_SCHEMA = 'spaceeconomy.federated-remote-exercise-intent.v1';
const PROOF_SCHEMA = 'spaceeconomy.federated-remote-exercise-proof.v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const RIGHT_TRANSFERRED = 'spaceeconomy.capacity-right.transferred.v1';
const RIGHT_RELEASED = 'spaceeconomy.capacity-right.released.v1';
const RIGHT_EXPIRED = 'spaceeconomy.capacity-right.expired.v1';
const RIGHT_EXERCISED = 'spaceeconomy.capacity-right.exercised.v1';
const RIGHT_CREATED = 'spaceeconomy.capacity-right.created.v1';
const ORDER_RESERVED = 'spaceeconomy.order.reserved.v1';

export class FederatedRemoteExerciseError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FederatedRemoteExerciseError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new FederatedRemoteExerciseError(code, message, details);
}

function text(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REMOTE_EXERCISE', `${field} is required`);
  return value.trim();
}

function hash(value, field) {
  const normalized = text(value, field);
  invariant(HASH.test(normalized), 'INVALID_REMOTE_EXERCISE', `${field} must be a canonical sha256 digest`);
  return normalized;
}

function timestamp(value, field) {
  const normalized = text(value, field);
  const parsed = Date.parse(normalized);
  invariant(Number.isFinite(parsed), 'INVALID_REMOTE_EXERCISE', `${field} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function nonNegativeInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value >= 0, 'INVALID_CONFIGURATION', `${field} must be a non-negative safe integer`);
  return value;
}

function clockNow(clock) {
  invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
  const value = clock();
  invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
  return value.toISOString();
}

function assertFresh(timestampValue, now, maxAgeSeconds, maxFutureSkewSeconds, staleCode, futureCode) {
  nonNegativeInteger(maxAgeSeconds, 'maxAgeSeconds');
  nonNegativeInteger(maxFutureSkewSeconds, 'maxFutureSkewSeconds');
  const ageMs = Date.parse(now) - Date.parse(timestampValue);
  invariant(ageMs <= maxAgeSeconds * 1000, staleCode, 'evidence is older than configured freshness policy', {
    observedAt: timestampValue,
    maxAgeSeconds,
  });
  invariant(ageMs >= -(maxFutureSkewSeconds * 1000), futureCode, 'evidence is too far in the future', {
    observedAt: timestampValue,
    maxFutureSkewSeconds,
  });
}

function normalizeAdmission(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ADMISSION', 'admission must be an object');
  invariant(value.schema === FEDERATED_CAPACITY_RIGHT_ADMISSION_SCHEMA, 'INVALID_ADMISSION', 'unsupported capacity-right admission schema');
  const { admissionHash, ...body } = value;
  hash(admissionHash, 'admission.admissionHash');
  invariant(`sha256:${sha256Canonical(body)}` === admissionHash, 'ADMISSION_HASH_MISMATCH', 'capacity-right admission hash verification failed');
  invariant(value.right?.status === 'held', 'REMOTE_RIGHT_NOT_SPENDABLE', 'admission does not represent a held capacity right');
  invariant(value.issuerClearinghouseId === value.checkpoint?.clearinghouseId, 'INVALID_ADMISSION', 'admission issuer does not match its checkpoint');
  invariant(value.right?.termsHash && HASH.test(value.right.termsHash), 'INVALID_ADMISSION', 'admission right terms hash is invalid');
  return clone(value);
}

function normalizeIntent(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REMOTE_EXERCISE', 'intent must be an object');
  invariant(value.schema === INTENT_SCHEMA, 'INVALID_REMOTE_EXERCISE', 'unsupported remote exercise intent schema');
  const { intentHash, ...body } = value;
  hash(intentHash, 'intent.intentHash');
  invariant(`sha256:${sha256Canonical(body)}` === intentHash, 'INTENT_HASH_MISMATCH', 'remote exercise intent hash verification failed');
  return clone(value);
}

function multiplyAmount(amount, quantity) {
  return (BigInt(amount) * BigInt(quantity)).toString();
}

function expectedTotal(admission) {
  const price = admission.right.terms.exerciseUnitPrice;
  return {
    settlementAsset: price.settlementAsset,
    amount: multiplyAmount(price.amount, admission.right.terms.quantity),
    scale: price.scale,
  };
}

function sameMoney(left, right) {
  return left?.settlementAsset === right?.settlementAsset
    && left?.amount === right?.amount
    && left?.scale === right?.scale;
}

function assertEventHashIdentity(event, admission) {
  invariant(event?.data?.capacityRightId === admission.right.id, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer event names another capacity right');
  const eventTermsHash = event.data.termsHash ?? event.data.capacityRightTermsHash;
  invariant(eventTermsHash === admission.right.termsHash, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer event terms hash does not match admission');
}

function reconstructExercise(events, admission, intent) {
  const rightSubject = `capacity-right/${admission.right.id}`;
  const rightEvents = events.filter((event) => event?.subject === rightSubject);
  invariant(rightEvents.length > 0, 'REMOTE_EXERCISE_EVENT_MISSING', 'verified extension contains no lifecycle event for admitted right');

  let exercised = null;
  for (const event of rightEvents) {
    invariant(event.type !== RIGHT_CREATED, 'REMOTE_RIGHT_RECREATED', 'issuer extension recreates an already admitted capacity right');
    if (event.type === RIGHT_TRANSFERRED) {
      throw new FederatedRemoteExerciseError('REMOTE_RIGHT_CHANGED_AFTER_INTENT', 'capacity right transferred after the admitted state and must be re-admitted before exercise');
    }
    if (event.type === RIGHT_RELEASED || event.type === RIGHT_EXPIRED) {
      assertEventHashIdentity(event, admission);
      throw new FederatedRemoteExerciseError('REMOTE_RIGHT_NOT_SPENDABLE', `capacity right became ${event.type === RIGHT_RELEASED ? 'released' : 'expired'} before remote exercise`);
    }
    invariant(event.type === RIGHT_EXERCISED, 'UNSUPPORTED_RIGHT_EVENT', `unsupported capacity-right event in exercise proof: ${event.type ?? 'missing'}`);
    invariant(exercised === null, 'DUPLICATE_REMOTE_EXERCISE', 'verified issuer extension contains multiple exercise events for one right');
    assertEventHashIdentity(event, admission);
    invariant(event.data.holderId === intent.holderId, 'REMOTE_EXERCISE_HOLDER_MISMATCH', 'issuer exercised right for another holder');
    invariant(event.data.offerId === admission.right.terms.offerId, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer exercise offer does not match admitted right');
    invariant(event.data.sellerId === admission.right.terms.sellerId, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer exercise seller does not match admitted right');
    exercised = event;
  }
  invariant(exercised !== null, 'REMOTE_EXERCISE_EVENT_MISSING', 'verified issuer extension contains no capacity-right exercise event');

  const orderId = text(exercised.data.orderId, 'exercise.orderId');
  const orderSubject = `order/${orderId}`;
  const orderEvents = events.filter((event) => event?.subject === orderSubject && event.type === ORDER_RESERVED);
  invariant(orderEvents.length === 1, orderEvents.length === 0 ? 'REMOTE_ORDER_EVENT_MISSING' : 'DUPLICATE_REMOTE_ORDER_EVENT', 'verified issuer extension must contain exactly one matching order reservation event');
  const orderEvent = orderEvents[0];
  invariant(orderEvent.sequence + 1 === exercised.sequence, 'REMOTE_EXERCISE_EVENT_ORDER_MISMATCH', 'issuer order reservation and capacity-right exercise events are not the expected atomic command pair');
  assertEventHashIdentity(orderEvent, admission);
  invariant(orderEvent.data.orderId === orderId, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer order ID does not match exercise event');
  invariant(orderEvent.data.offerId === admission.right.terms.offerId, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer order offer does not match admitted right');
  invariant(orderEvent.data.buyerId === intent.holderId, 'REMOTE_EXERCISE_HOLDER_MISMATCH', 'issuer order buyer does not match exercise intent holder');
  invariant(orderEvent.data.sellerId === admission.right.terms.sellerId, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer order seller does not match admitted right');
  invariant(orderEvent.data.quantity === admission.right.terms.quantity, 'REMOTE_EXERCISE_PROVENANCE_MISMATCH', 'issuer order quantity does not match admitted right');
  invariant(sameMoney(orderEvent.data.total, expectedTotal(admission)), 'REMOTE_EXERCISE_AMOUNT_MISMATCH', 'issuer order total does not match admitted exercise terms');

  return {
    orderId,
    orderEventSequence: orderEvent.sequence,
    exerciseEventSequence: exercised.sequence,
    order: {
      id: orderId,
      offerId: orderEvent.data.offerId,
      buyerId: orderEvent.data.buyerId,
      sellerId: orderEvent.data.sellerId,
      quantity: orderEvent.data.quantity,
      total: clone(orderEvent.data.total),
      fundingDueAt: orderEvent.data.fundingDueAt ?? null,
      capacityRightId: admission.right.id,
      capacityRightTermsHash: admission.right.termsHash,
    },
  };
}

/**
 * Create a deterministic intent that can be embedded in a signed issuer command.
 * This does not submit anything to the issuer.
 */
export function createFederatedRemoteExerciseIntent({
  admission: rawAdmission,
  holderId,
  idempotencyKey,
  expiresAt,
  clock = () => new Date(),
  maxAdmissionAgeSeconds = 300,
  maxFutureSkewSeconds = 60,
} = {}) {
  const admission = normalizeAdmission(rawAdmission);
  const now = clockNow(clock);
  assertFresh(admission.checkpoint.generatedAt, now, maxAdmissionAgeSeconds, maxFutureSkewSeconds, 'STALE_REMOTE_ADMISSION', 'REMOTE_ADMISSION_FROM_FUTURE');
  invariant(Date.parse(now) < Date.parse(admission.right.terms.expiresAt), 'REMOTE_RIGHT_EXPIRED', 'admitted right has passed its exercise deadline');
  const normalizedHolder = text(holderId, 'holderId');
  invariant(normalizedHolder === admission.right.holderId, 'REMOTE_HOLDER_MISMATCH', 'intent holder does not own the admitted remote right');
  const normalizedIdempotencyKey = text(idempotencyKey, 'idempotencyKey');
  invariant(normalizedIdempotencyKey.length <= 255, 'INVALID_REMOTE_EXERCISE', 'idempotencyKey must be at most 255 characters');
  const normalizedExpiresAt = timestamp(expiresAt, 'expiresAt');
  invariant(Date.parse(normalizedExpiresAt) > Date.parse(now), 'INVALID_REMOTE_EXERCISE', 'intent expiry must be in the future');
  invariant(Date.parse(normalizedExpiresAt) <= Date.parse(admission.right.terms.expiresAt), 'INVALID_REMOTE_EXERCISE', 'intent may not outlive remote capacity right');

  const body = {
    schema: INTENT_SCHEMA,
    issuerClearinghouseId: admission.issuerClearinghouseId,
    capacityRightId: admission.right.id,
    termsHash: admission.right.termsHash,
    holderId: normalizedHolder,
    admissionHash: admission.admissionHash,
    admittedCheckpointHash: admission.checkpoint.checkpointHash,
    idempotencyKey: normalizedIdempotencyKey,
    createdAt: now,
    expiresAt: normalizedExpiresAt,
  };
  return { ...body, intentHash: `sha256:${sha256Canonical(body)}` };
}

/**
 * Verify issuer evidence that a remote exercise intent became exactly one issuer order.
 * No local order is created by this verifier.
 */
export async function verifyFederatedRemoteExerciseProof({
  intent: rawIntent,
  admission: rawAdmission,
  checkpointEnvelope,
  events,
  resolvePublicKey,
  expectedIssuerOrderId = null,
  clock = () => new Date(),
  maxCheckpointAgeSeconds = 300,
  maxFutureSkewSeconds = 60,
} = {}) {
  invariant(Array.isArray(events), 'INVALID_REMOTE_EXERCISE', 'events must be an array');
  const admission = normalizeAdmission(rawAdmission);
  const intent = normalizeIntent(rawIntent);
  invariant(intent.issuerClearinghouseId === admission.issuerClearinghouseId, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent issuer does not match admission');
  invariant(intent.capacityRightId === admission.right.id, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent right does not match admission');
  invariant(intent.termsHash === admission.right.termsHash, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent terms hash does not match admission');
  invariant(intent.holderId === admission.right.holderId, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent holder does not match admitted holder');
  invariant(intent.admissionHash === admission.admissionHash, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent admission hash does not match supplied admission');
  invariant(intent.admittedCheckpointHash === admission.checkpoint.checkpointHash, 'REMOTE_EXERCISE_INTENT_MISMATCH', 'intent checkpoint does not match admission');

  const now = clockNow(clock);
  invariant(Date.parse(now) < Date.parse(intent.expiresAt), 'REMOTE_EXERCISE_INTENT_EXPIRED', 'remote exercise intent has expired');
  const verified = await verifyFederationCheckpoint(checkpointEnvelope, {
    resolvePublicKey,
    expectedClearinghouseId: admission.issuerClearinghouseId,
    previousCheckpoint: admission.checkpoint,
  });
  const extension = verifyFederationExtension({
    fromCheckpoint: admission.checkpoint,
    toCheckpoint: verified.checkpoint,
    events,
  });
  assertFresh(verified.checkpoint.generatedAt, now, maxCheckpointAgeSeconds, maxFutureSkewSeconds, 'STALE_REMOTE_CHECKPOINT', 'REMOTE_CHECKPOINT_FROM_FUTURE');
  const result = reconstructExercise(events, admission, intent);
  if (expectedIssuerOrderId !== null) {
    invariant(result.orderId === text(expectedIssuerOrderId, 'expectedIssuerOrderId'), 'REMOTE_ORDER_ID_MISMATCH', 'issuer order does not match expected order ID');
  }

  const body = {
    schema: PROOF_SCHEMA,
    issuerClearinghouseId: admission.issuerClearinghouseId,
    intentHash: intent.intentHash,
    admissionHash: admission.admissionHash,
    capacityRightId: admission.right.id,
    termsHash: admission.right.termsHash,
    holderId: intent.holderId,
    issuerOrder: result.order,
    checkpoint: clone(verified.checkpoint),
    evidence: {
      fromCheckpointHash: admission.checkpoint.checkpointHash,
      fromSequence: extension.fromSequence,
      toSequence: extension.toSequence,
      eventsVerified: extension.eventsVerified,
      eventsDigest: `sha256:${sha256Canonical(events)}`,
      orderEventSequence: result.orderEventSequence,
      exerciseEventSequence: result.exerciseEventSequence,
    },
    verifiedAt: now,
    localOrderCreated: false,
    issuerAuthoritative: true,
  };
  return { ...body, proofHash: `sha256:${sha256Canonical(body)}` };
}

export const FEDERATED_REMOTE_EXERCISE_INTENT_SCHEMA = INTENT_SCHEMA;
export const FEDERATED_REMOTE_EXERCISE_PROOF_SCHEMA = PROOF_SCHEMA;
