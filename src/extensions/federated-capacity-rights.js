import { sha256Canonical } from '../canonical-json.js';
import { verifyFederationCheckpoint, verifyFederationExtension } from '../federation.js';

const clone = (value) => structuredClone(value);
const ADMISSION_SCHEMA = 'spaceeconomy.federated-capacity-right-admission.v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const RIGHT_CREATED = 'spaceeconomy.capacity-right.created.v1';
const RIGHT_TRANSFERRED = 'spaceeconomy.capacity-right.transferred.v1';
const RIGHT_RELEASED = 'spaceeconomy.capacity-right.released.v1';
const RIGHT_EXPIRED = 'spaceeconomy.capacity-right.expired.v1';
const RIGHT_EXERCISED = 'spaceeconomy.capacity-right.exercised.v1';
const KNOWN_RIGHT_EVENTS = new Set([
  RIGHT_CREATED,
  RIGHT_TRANSFERRED,
  RIGHT_RELEASED,
  RIGHT_EXPIRED,
  RIGHT_EXERCISED,
]);

export class FederatedCapacityRightError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FederatedCapacityRightError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new FederatedCapacityRightError(code, message, details);
}

function text(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REMOTE_RIGHT', `${field} is required`);
  return value.trim();
}

function hash(value, field) {
  const normalized = text(value, field);
  invariant(HASH.test(normalized), 'INVALID_REMOTE_RIGHT', `${field} must be a canonical sha256 digest`);
  return normalized;
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REMOTE_RIGHT', `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value >= 0, 'INVALID_CONFIGURATION', `${field} must be a non-negative safe integer`);
  return value;
}

function timestamp(value, field) {
  const normalized = text(value, field);
  const parsed = Date.parse(normalized);
  invariant(Number.isFinite(parsed), 'INVALID_REMOTE_RIGHT', `${field} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function money(value, field) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REMOTE_RIGHT', `${field} is required`);
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount) && BigInt(value.amount) > 0n, 'INVALID_REMOTE_RIGHT', `${field}.amount must be a positive unsigned integer string`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REMOTE_RIGHT', `${field}.scale must be an integer from 0 to 18`);
  return {
    settlementAsset: text(value.settlementAsset, `${field}.settlementAsset`),
    amount: value.amount,
    scale: value.scale,
  };
}

function sameMoney(left, right) {
  return left?.settlementAsset === right?.settlementAsset
    && left?.amount === right?.amount
    && left?.scale === right?.scale;
}

function metadata(value) {
  const normalized = value ?? {};
  invariant(normalized && typeof normalized === 'object' && !Array.isArray(normalized), 'INVALID_REMOTE_RIGHT', 'rightTerms.metadata must be an object');
  try {
    sha256Canonical(normalized);
  } catch (error) {
    throw new FederatedCapacityRightError('INVALID_REMOTE_RIGHT', `rightTerms.metadata must be canonical JSON: ${error.message}`);
  }
  return clone(normalized);
}

function normalizeTerms(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REMOTE_RIGHT', 'rightTerms are required');
  const reservationTtlSeconds = value.reservationTtlSeconds ?? null;
  if (reservationTtlSeconds !== null) positiveInteger(reservationTtlSeconds, 'rightTerms.reservationTtlSeconds');
  return {
    offerId: text(value.offerId, 'rightTerms.offerId'),
    assetId: text(value.assetId, 'rightTerms.assetId'),
    sellerId: text(value.sellerId, 'rightTerms.sellerId'),
    service: text(value.service, 'rightTerms.service'),
    unit: text(value.unit, 'rightTerms.unit'),
    quantity: positiveInteger(value.quantity, 'rightTerms.quantity'),
    exerciseUnitPrice: money(value.exerciseUnitPrice, 'rightTerms.exerciseUnitPrice'),
    reservationTtlSeconds,
    expiresAt: timestamp(value.expiresAt, 'rightTerms.expiresAt'),
    metadata: metadata(value.metadata),
  };
}

function termsHash(terms) {
  return `sha256:${sha256Canonical(terms)}`;
}

function assertEventIdentity(event, state) {
  invariant(event?.data?.capacityRightId === state.id, 'RIGHT_EVENT_MISMATCH', 'capacity-right event names another right');
  invariant(event.data.termsHash === state.termsHash, 'RIGHT_EVENT_MISMATCH', 'capacity-right event terms hash changed');
  if (event.data.offerId !== undefined) invariant(event.data.offerId === state.terms.offerId, 'RIGHT_EVENT_MISMATCH', 'capacity-right event offer changed');
  if (event.data.sellerId !== undefined) invariant(event.data.sellerId === state.terms.sellerId, 'RIGHT_EVENT_MISMATCH', 'capacity-right event seller changed');
}

function applyLifecycleEvent(state, event) {
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'INVALID_RIGHT_EVENT', 'capacity-right ledger event must be an object');
  invariant(event.subject === `capacity-right/${state.id}`, 'RIGHT_EVENT_MISMATCH', 'capacity-right event subject mismatch');
  invariant(KNOWN_RIGHT_EVENTS.has(event.type), 'UNSUPPORTED_RIGHT_EVENT', `unsupported capacity-right event type: ${event.type ?? 'missing'}`);
  invariant(event.type !== RIGHT_CREATED, 'DUPLICATE_RIGHT_CREATION', 'capacity right has more than one creation event');
  assertEventIdentity(event, state);
  invariant(state.status === 'held', 'RIGHT_LIFECYCLE_CONFLICT', 'capacity-right lifecycle event follows a terminal event', {
    status: state.status,
    sequence: event.sequence,
  });

  if (event.type === RIGHT_TRANSFERRED) {
    invariant(event.data.fromHolderId === state.holderId, 'RIGHT_HOLDER_CHAIN_MISMATCH', 'capacity-right transfer does not start from current holder');
    const expectedSequence = state.transferSequence + 1;
    invariant(event.data.transferSequence === expectedSequence, 'RIGHT_TRANSFER_SEQUENCE_MISMATCH', 'capacity-right transfer sequence is not contiguous', {
      expected: expectedSequence,
      actual: event.data.transferSequence,
    });
    const toHolderId = text(event.data.toHolderId, 'transfer.toHolderId');
    invariant(toHolderId !== state.holderId, 'RIGHT_HOLDER_CHAIN_MISMATCH', 'capacity-right transfer does not change holder');
    state.holderId = toHolderId;
    state.transferSequence = expectedSequence;
  } else if (event.type === RIGHT_RELEASED) {
    invariant(event.data.holderId === state.holderId, 'RIGHT_HOLDER_CHAIN_MISMATCH', 'capacity-right release holder mismatch');
    state.status = 'released';
  } else if (event.type === RIGHT_EXPIRED) {
    invariant(event.data.holderId === state.holderId, 'RIGHT_HOLDER_CHAIN_MISMATCH', 'capacity-right expiry holder mismatch');
    state.status = 'expired';
  } else if (event.type === RIGHT_EXERCISED) {
    invariant(event.data.holderId === state.holderId, 'RIGHT_HOLDER_CHAIN_MISMATCH', 'capacity-right exercise holder mismatch');
    state.status = 'exercised';
    state.orderId = text(event.data.orderId, 'exercise.orderId');
  }
  state.lastEventSequence = event.sequence;
  return state;
}

function reconstructFromIssuance({ events, capacityRightId, rightTerms }) {
  const terms = normalizeTerms(rightTerms);
  const expectedTermsHash = termsHash(terms);
  const subject = `capacity-right/${capacityRightId}`;
  const related = events.filter((event) => event?.subject === subject);
  invariant(related.length > 0, 'RIGHT_EVIDENCE_MISSING', 'verified extension contains no events for requested capacity right');
  const creationEvents = related.filter((event) => event.type === RIGHT_CREATED);
  invariant(creationEvents.length === 1, creationEvents.length === 0 ? 'RIGHT_CREATION_MISSING' : 'DUPLICATE_RIGHT_CREATION', 'verified extension must contain exactly one capacity-right creation event');
  const creation = creationEvents[0];
  invariant(related[0] === creation, 'RIGHT_EVENT_ORDER_INVALID', 'capacity-right lifecycle event appears before creation');
  invariant(creation.data?.capacityRightId === capacityRightId, 'RIGHT_EVENT_MISMATCH', 'creation event names another right');
  invariant(creation.data.termsHash === expectedTermsHash, 'RIGHT_TERMS_HASH_MISMATCH', 'supplied immutable terms do not match issuer terms hash', {
    expectedTermsHash,
    actualTermsHash: creation.data?.termsHash,
  });
  invariant(creation.data.offerId === terms.offerId, 'RIGHT_EVENT_MISMATCH', 'creation event offer does not match immutable terms');
  invariant(creation.data.assetId === terms.assetId, 'RIGHT_EVENT_MISMATCH', 'creation event asset does not match immutable terms');
  invariant(creation.data.sellerId === terms.sellerId, 'RIGHT_EVENT_MISMATCH', 'creation event seller does not match immutable terms');
  invariant(creation.data.quantity === terms.quantity, 'RIGHT_EVENT_MISMATCH', 'creation event quantity does not match immutable terms');
  invariant(sameMoney(creation.data.exerciseUnitPrice, terms.exerciseUnitPrice), 'RIGHT_EVENT_MISMATCH', 'creation event exercise price does not match immutable terms');
  invariant(timestamp(creation.data.expiresAt, 'creation.expiresAt') === terms.expiresAt, 'RIGHT_EVENT_MISMATCH', 'creation event expiry does not match immutable terms');

  const state = {
    id: capacityRightId,
    termsHash: expectedTermsHash,
    terms,
    initialHolderId: text(creation.data.holderId, 'creation.holderId'),
    holderId: text(creation.data.holderId, 'creation.holderId'),
    transferSequence: 0,
    status: 'held',
    orderId: null,
    creationSequence: creation.sequence,
    lastEventSequence: creation.sequence,
  };
  for (const event of related.slice(1)) applyLifecycleEvent(state, event);
  return state;
}

function applyRefreshEvents(priorRight, events) {
  const state = clone(priorRight);
  const subject = `capacity-right/${state.id}`;
  for (const event of events.filter((candidate) => candidate?.subject === subject)) applyLifecycleEvent(state, event);
  return state;
}

function assertSpendable(state, { expectedHolderId, now }) {
  invariant(state.status === 'held', 'REMOTE_RIGHT_NOT_SPENDABLE', `remote capacity right is ${state.status}`, { status: state.status });
  invariant(Date.parse(now) < Date.parse(state.terms.expiresAt), 'REMOTE_RIGHT_EXPIRED', 'remote capacity right has passed its exercise deadline', { expiresAt: state.terms.expiresAt });
  if (expectedHolderId !== null) {
    invariant(state.holderId === text(expectedHolderId, 'expectedHolderId'), 'REMOTE_HOLDER_MISMATCH', 'remote capacity right is held by another participant', {
      expectedHolderId,
      actualHolderId: state.holderId,
    });
  }
}

function clockNow(clock) {
  invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
  const value = clock();
  invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
  return value.toISOString();
}

function assertFreshCheckpoint(checkpoint, now, { maxCheckpointAgeSeconds, maxFutureSkewSeconds }) {
  nonNegativeInteger(maxCheckpointAgeSeconds, 'maxCheckpointAgeSeconds');
  nonNegativeInteger(maxFutureSkewSeconds, 'maxFutureSkewSeconds');
  const ageMs = Date.parse(now) - Date.parse(checkpoint.generatedAt);
  invariant(ageMs <= maxCheckpointAgeSeconds * 1000, 'STALE_REMOTE_CHECKPOINT', 'remote checkpoint is older than admission freshness policy', {
    generatedAt: checkpoint.generatedAt,
    maxCheckpointAgeSeconds,
  });
  invariant(ageMs >= -(maxFutureSkewSeconds * 1000), 'REMOTE_CHECKPOINT_FROM_FUTURE', 'remote checkpoint is too far in the future', {
    generatedAt: checkpoint.generatedAt,
    maxFutureSkewSeconds,
  });
}

async function evaluatePolicy({ policyEngine, actor, right, checkpoint, previousAdmissionHash = null }) {
  invariant(policyEngine && typeof policyEngine.requireAllowed === 'function', 'INVALID_CONFIGURATION', 'policyEngine.requireAllowed() is required');
  invariant(actor && typeof actor === 'object' && !Array.isArray(actor), 'INVALID_CONFIGURATION', 'actor is required for local admission policy');
  return policyEngine.requireAllowed({
    operation: 'federated-capacity-right.admit',
    actor,
    resource: {
      issuerClearinghouseId: checkpoint.clearinghouseId,
      capacityRightId: right.id,
      holderId: right.holderId,
      status: right.status,
      termsHash: right.termsHash,
      terms: clone(right.terms),
    },
    context: {
      checkpointHash: checkpoint.checkpointHash,
      checkpointSequence: checkpoint.sequence,
      previousAdmissionHash,
    },
  });
}

function buildAdmission({ right, checkpoint, extension, events, policy, admittedAt, previousAdmissionHash = null }) {
  const body = {
    schema: ADMISSION_SCHEMA,
    issuerClearinghouseId: checkpoint.clearinghouseId,
    right: clone(right),
    checkpoint: clone(checkpoint),
    evidence: {
      fromCheckpointHash: extension.fromCheckpointHash,
      fromSequence: extension.fromSequence,
      toSequence: extension.toSequence,
      eventsVerified: extension.eventsVerified,
      eventsDigest: `sha256:${sha256Canonical(events)}`,
    },
    policy: clone(policy),
    admittedAt,
    previousAdmissionHash,
  };
  return { ...body, admissionHash: `sha256:${sha256Canonical(body)}` };
}

function normalizePriorAdmission(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ADMISSION', 'priorAdmission must be an object');
  invariant(value.schema === ADMISSION_SCHEMA, 'INVALID_ADMISSION', 'unsupported prior admission schema');
  const { admissionHash, ...body } = value;
  hash(admissionHash, 'priorAdmission.admissionHash');
  invariant(`sha256:${sha256Canonical(body)}` === admissionHash, 'ADMISSION_HASH_MISMATCH', 'prior admission hash verification failed');
  invariant(value.right?.status === 'held', 'REMOTE_RIGHT_NOT_SPENDABLE', 'prior admission no longer represents a held right');
  return clone(value);
}

/**
 * Admit a remote right whose creation occurs inside one verified federation extension.
 * No local clearinghouse market is accepted or mutated by this function.
 */
export async function admitFederatedCapacityRight({
  fromCheckpoint,
  checkpointEnvelope,
  events,
  capacityRightId,
  rightTerms,
  resolvePublicKey,
  policyEngine,
  actor,
  expectedIssuerClearinghouseId = null,
  expectedHolderId = null,
  clock = () => new Date(),
  maxCheckpointAgeSeconds = 300,
  maxFutureSkewSeconds = 60,
} = {}) {
  invariant(Array.isArray(events), 'INVALID_REMOTE_RIGHT', 'events must be an array');
  const verified = await verifyFederationCheckpoint(checkpointEnvelope, {
    resolvePublicKey,
    expectedClearinghouseId: expectedIssuerClearinghouseId,
    previousCheckpoint: fromCheckpoint,
  });
  const extension = verifyFederationExtension({
    fromCheckpoint,
    toCheckpoint: verified.checkpoint,
    events,
  });
  const now = clockNow(clock);
  assertFreshCheckpoint(verified.checkpoint, now, { maxCheckpointAgeSeconds, maxFutureSkewSeconds });
  const right = reconstructFromIssuance({
    events,
    capacityRightId: text(capacityRightId, 'capacityRightId'),
    rightTerms,
  });
  assertSpendable(right, { expectedHolderId, now });
  const policy = await evaluatePolicy({ policyEngine, actor, right, checkpoint: verified.checkpoint });
  return buildAdmission({
    right,
    checkpoint: verified.checkpoint,
    extension: {
      ...extension,
      fromCheckpointHash: fromCheckpoint.checkpointHash,
    },
    events,
    policy,
    admittedAt: now,
  });
}

/**
 * Refresh an existing admission against the issuer's directly chained next checkpoint.
 * The resulting artifact replaces local reliance state; it never copies the remote right.
 */
export async function refreshFederatedCapacityRightAdmission({
  priorAdmission,
  checkpointEnvelope,
  events,
  resolvePublicKey,
  policyEngine,
  actor,
  expectedHolderId = null,
  clock = () => new Date(),
  maxCheckpointAgeSeconds = 300,
  maxFutureSkewSeconds = 60,
} = {}) {
  invariant(Array.isArray(events), 'INVALID_REMOTE_RIGHT', 'events must be an array');
  const prior = normalizePriorAdmission(priorAdmission);
  const verified = await verifyFederationCheckpoint(checkpointEnvelope, {
    resolvePublicKey,
    expectedClearinghouseId: prior.issuerClearinghouseId,
    previousCheckpoint: prior.checkpoint,
  });
  const extension = verifyFederationExtension({
    fromCheckpoint: prior.checkpoint,
    toCheckpoint: verified.checkpoint,
    events,
  });
  const now = clockNow(clock);
  assertFreshCheckpoint(verified.checkpoint, now, { maxCheckpointAgeSeconds, maxFutureSkewSeconds });
  const right = applyRefreshEvents(prior.right, events);
  assertSpendable(right, { expectedHolderId, now });
  const policy = await evaluatePolicy({
    policyEngine,
    actor,
    right,
    checkpoint: verified.checkpoint,
    previousAdmissionHash: prior.admissionHash,
  });
  return buildAdmission({
    right,
    checkpoint: verified.checkpoint,
    extension: {
      ...extension,
      fromCheckpointHash: prior.checkpoint.checkpointHash,
    },
    events,
    policy,
    admittedAt: now,
    previousAdmissionHash: prior.admissionHash,
  });
}

export const FEDERATED_CAPACITY_RIGHT_ADMISSION_SCHEMA = ADMISSION_SCHEMA;
