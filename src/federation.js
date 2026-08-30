import { sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { canonicalize, sha256Canonical } from './canonical-json.js';

const CHECKPOINT_SCHEMA = 'spaceeconomy.federation-checkpoint.v1';
const ENVELOPE_SCHEMA = 'spaceeconomy.federation-checkpoint-envelope.v1';
const DOMAIN = 'space-economy.federation-checkpoint.v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CHECKPOINT_FIELDS = new Set([
  'schema',
  'clearinghouseId',
  'revision',
  'sequence',
  'headHash',
  'generatedAt',
  'previousCheckpointHash',
  'checkpointHash',
]);
const ENVELOPE_FIELDS = new Set(['schema', 'algorithm', 'keyId', 'checkpoint', 'signature']);

export class FederationCheckpointError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FederationCheckpointError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new FederationCheckpointError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_CHECKPOINT', `${field} is required`);
  return value.trim();
}

function nonNegativeInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value >= 0, 'INVALID_CHECKPOINT', `${field} must be a non-negative safe integer`);
  return value;
}

function timestamp(value, field) {
  const normalized = nonEmptyString(value, field);
  invariant(RFC3339.test(normalized), 'INVALID_CHECKPOINT', `${field} must be an RFC 3339 timestamp`);
  const milliseconds = Date.parse(normalized);
  invariant(Number.isFinite(milliseconds), 'INVALID_CHECKPOINT', `${field} must be a valid RFC 3339 timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizeHash(value, field, { genesis = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (genesis && value === 'GENESIS') return value;
  invariant(typeof value === 'string' && HASH.test(value), 'INVALID_CHECKPOINT', `${field} must be a canonical sha256 hash${genesis ? ' or GENESIS' : ''}`);
  return value;
}

function checkpointBody(checkpoint) {
  return {
    schema: checkpoint.schema,
    clearinghouseId: checkpoint.clearinghouseId,
    revision: checkpoint.revision,
    sequence: checkpoint.sequence,
    headHash: checkpoint.headHash,
    generatedAt: checkpoint.generatedAt,
    previousCheckpointHash: checkpoint.previousCheckpointHash,
  };
}

function normalizeCheckpoint(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_CHECKPOINT', 'checkpoint must be an object');
  const unexpected = Object.keys(value).filter((field) => !CHECKPOINT_FIELDS.has(field));
  invariant(unexpected.length === 0, 'UNSUPPORTED_CHECKPOINT_EXTENSION', 'checkpoint contains unsupported fields', { fields: unexpected });
  invariant(value.schema === CHECKPOINT_SCHEMA, 'UNSUPPORTED_CHECKPOINT_SCHEMA', `unsupported checkpoint schema: ${value.schema ?? 'missing'}`);

  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    clearinghouseId: nonEmptyString(value.clearinghouseId, 'clearinghouseId'),
    revision: nonNegativeInteger(value.revision, 'revision'),
    sequence: nonNegativeInteger(value.sequence, 'sequence'),
    headHash: normalizeHash(value.headHash, 'headHash', { genesis: true }),
    generatedAt: timestamp(value.generatedAt, 'generatedAt'),
    previousCheckpointHash: normalizeHash(value.previousCheckpointHash, 'previousCheckpointHash', { nullable: true }),
    checkpointHash: normalizeHash(value.checkpointHash, 'checkpointHash'),
  };

  invariant(
    checkpoint.sequence === 0 ? checkpoint.headHash === 'GENESIS' : HASH.test(checkpoint.headHash),
    'INVALID_CHECKPOINT',
    'checkpoint head hash does not match its sequence',
  );
  const expectedHash = `sha256:${sha256Canonical(checkpointBody(checkpoint))}`;
  invariant(checkpoint.checkpointHash === expectedHash, 'CHECKPOINT_HASH_MISMATCH', 'checkpoint hash verification failed', {
    expectedHash,
    actualHash: checkpoint.checkpointHash,
  });
  return checkpoint;
}

function assertCheckpointLink(previous, next) {
  invariant(previous.clearinghouseId === next.clearinghouseId, 'CLEARINGHOUSE_MISMATCH', 'checkpoint clearinghouse identity changed');
  invariant(next.previousCheckpointHash === previous.checkpointHash, 'CHECKPOINT_LINK_MISMATCH', 'checkpoint does not link to the expected predecessor');
  invariant(next.revision >= previous.revision, 'CHECKPOINT_REGRESSION', 'checkpoint revision regressed', {
    previousRevision: previous.revision,
    revision: next.revision,
  });
  invariant(next.sequence >= previous.sequence, 'CHECKPOINT_REGRESSION', 'checkpoint ledger sequence regressed', {
    previousSequence: previous.sequence,
    sequence: next.sequence,
  });
  if (next.sequence === previous.sequence) {
    invariant(next.headHash === previous.headHash, 'CHECKPOINT_FORK', 'same ledger sequence names a different head hash');
  }
}

function unsignedEnvelope(checkpoint, keyId) {
  return {
    schema: ENVELOPE_SCHEMA,
    algorithm: 'Ed25519',
    keyId,
    checkpoint,
  };
}

function signingBytes(envelope) {
  return Buffer.from(`${DOMAIN}\n${canonicalize(envelope)}`, 'utf8');
}

function decodeSignature(value) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_SIGNATURE', 'signature must be unpadded base64url');
  const decoded = Buffer.from(value, 'base64url');
  invariant(decoded.length === 64, 'INVALID_SIGNATURE', 'Ed25519 signature must be 64 bytes');
  invariant(decoded.toString('base64url') === value, 'INVALID_SIGNATURE', 'signature must use canonical unpadded base64url encoding');
  return decoded;
}

function validateMarket(market) {
  invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
  for (const method of ['getRevision', 'verifyLedger', 'getLedger']) {
    invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
  }
}

/**
 * Build a revision-stable checkpoint over a clearinghouse's verified hash-chained ledger.
 *
 * `previousCheckpoint` is assumed to have been trusted/verified by the caller. It
 * is used only to construct and validate the local checkpoint link.
 */
export async function createFederationCheckpoint({
  market,
  clearinghouseId,
  previousCheckpoint = null,
  clock = () => new Date(),
  maxRevisionRetries = 3,
} = {}) {
  validateMarket(market);
  const normalizedClearinghouseId = nonEmptyString(clearinghouseId, 'clearinghouseId');
  invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
  invariant(Number.isSafeInteger(maxRevisionRetries) && maxRevisionRetries >= 1 && maxRevisionRetries <= 20, 'INVALID_CONFIGURATION', 'maxRevisionRetries must be an integer from 1 to 20');
  const previous = previousCheckpoint === null ? null : normalizeCheckpoint(previousCheckpoint);
  if (previous !== null) {
    invariant(previous.clearinghouseId === normalizedClearinghouseId, 'CLEARINGHOUSE_MISMATCH', 'previous checkpoint belongs to another clearinghouse');
  }

  for (let attempt = 1; attempt <= maxRevisionRetries; attempt += 1) {
    const before = await market.getRevision();
    invariant(Number.isSafeInteger(before) && before >= 0, 'INVALID_MARKET_STATE', 'market revision is invalid');
    const ledgerValid = await market.verifyLedger();
    invariant(ledgerValid === true, 'LEDGER_INTEGRITY_FAILED', 'clearinghouse ledger integrity verification failed');
    const ledger = await market.getLedger();
    invariant(Array.isArray(ledger), 'INVALID_MARKET_STATE', 'market ledger must be an array');
    const after = await market.getRevision();
    invariant(Number.isSafeInteger(after) && after >= 0, 'INVALID_MARKET_STATE', 'market revision is invalid');
    if (before !== after) continue;

    const sequence = ledger.length;
    const headHash = sequence === 0 ? 'GENESIS' : ledger.at(-1)?.hash;
    normalizeHash(headHash, 'ledger head hash', { genesis: true });
    if (sequence > 0) {
      invariant(ledger.at(-1)?.sequence === sequence, 'INVALID_MARKET_STATE', 'ledger head sequence does not match ledger length');
    }

    const now = clock();
    invariant(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    const body = {
      schema: CHECKPOINT_SCHEMA,
      clearinghouseId: normalizedClearinghouseId,
      revision: after,
      sequence,
      headHash,
      generatedAt: now.toISOString(),
      previousCheckpointHash: previous?.checkpointHash ?? null,
    };
    const checkpoint = {
      ...body,
      checkpointHash: `sha256:${sha256Canonical(body)}`,
    };
    const normalized = normalizeCheckpoint(checkpoint);
    if (previous !== null) assertCheckpointLink(previous, normalized);
    return normalized;
  }

  throw new FederationCheckpointError('FEDERATION_SNAPSHOT_CHANGED', 'market changed repeatedly while federation checkpoint was being assembled');
}

/** Sign a validated checkpoint with an Ed25519 clearinghouse key. */
export function signFederationCheckpoint(checkpoint, { keyId, privateKey } = {}) {
  invariant(privateKey, 'INVALID_CONFIGURATION', 'privateKey is required');
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  const normalizedKeyId = nonEmptyString(keyId, 'keyId');
  const unsigned = unsignedEnvelope(normalizedCheckpoint, normalizedKeyId);
  return {
    ...unsigned,
    signature: signBytes(null, signingBytes(unsigned), privateKey).toString('base64url'),
  };
}

/**
 * Verify a signed checkpoint.
 *
 * `resolvePublicKey` must authorize the returned key for the claimed clearinghouse
 * and key ID. The envelope intentionally carries no caller-selected public key.
 */
export async function verifyFederationCheckpoint(envelope, {
  resolvePublicKey,
  expectedClearinghouseId = null,
  previousCheckpoint = null,
} = {}) {
  invariant(typeof resolvePublicKey === 'function', 'INVALID_CONFIGURATION', 'resolvePublicKey must be a function');
  invariant(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'INVALID_ENVELOPE', 'checkpoint envelope must be an object');
  const unexpected = Object.keys(envelope).filter((field) => !ENVELOPE_FIELDS.has(field));
  invariant(unexpected.length === 0, 'UNSIGNED_EXTENSION', 'checkpoint envelope contains unsupported unsigned fields', { fields: unexpected });
  invariant(envelope.schema === ENVELOPE_SCHEMA, 'UNSUPPORTED_ENVELOPE_SCHEMA', `unsupported checkpoint envelope schema: ${envelope.schema ?? 'missing'}`);
  invariant(envelope.algorithm === 'Ed25519', 'UNSUPPORTED_SIGNATURE_ALGORITHM', `unsupported signature algorithm: ${envelope.algorithm ?? 'missing'}`);

  const keyId = nonEmptyString(envelope.keyId, 'keyId');
  const checkpoint = normalizeCheckpoint(envelope.checkpoint);
  if (expectedClearinghouseId !== null) {
    invariant(checkpoint.clearinghouseId === nonEmptyString(expectedClearinghouseId, 'expectedClearinghouseId'), 'CLEARINGHOUSE_MISMATCH', 'checkpoint belongs to another clearinghouse');
  }
  if (previousCheckpoint !== null) assertCheckpointLink(normalizeCheckpoint(previousCheckpoint), checkpoint);

  const publicKey = await resolvePublicKey({
    keyId,
    clearinghouseId: checkpoint.clearinghouseId,
    algorithm: envelope.algorithm,
  });
  invariant(publicKey, 'UNKNOWN_SIGNING_KEY', 'no trusted public key resolved for clearinghouse/key');
  const unsigned = unsignedEnvelope(checkpoint, keyId);
  const signature = decodeSignature(envelope.signature);
  invariant(verifyBytes(null, signingBytes(unsigned), publicKey, signature), 'INVALID_SIGNATURE', 'federation checkpoint signature verification failed');

  return {
    checkpoint: structuredClone(checkpoint),
    checkpointHash: checkpoint.checkpointHash,
    signer: { keyId, algorithm: 'Ed25519' },
  };
}

/**
 * Verify that `events` are exactly the ledger segment connecting two directly
 * chained checkpoints.
 */
export function verifyFederationExtension({ fromCheckpoint, toCheckpoint, events } = {}) {
  const from = normalizeCheckpoint(fromCheckpoint);
  const to = normalizeCheckpoint(toCheckpoint);
  assertCheckpointLink(from, to);
  invariant(Array.isArray(events), 'INVALID_EXTENSION', 'events must be an array');
  const expectedCount = to.sequence - from.sequence;
  invariant(events.length === expectedCount, 'EXTENSION_LENGTH_MISMATCH', 'event segment length does not match checkpoint sequence delta', {
    expected: expectedCount,
    actual: events.length,
  });

  if (expectedCount === 0) {
    invariant(to.headHash === from.headHash, 'CHECKPOINT_FORK', 'empty extension changes the ledger head');
    return {
      clearinghouseId: to.clearinghouseId,
      fromSequence: from.sequence,
      toSequence: to.sequence,
      eventsVerified: 0,
      headHash: to.headHash,
    };
  }

  let previousHash = from.headHash;
  let expectedSequence = from.sequence + 1;
  for (const event of events) {
    invariant(event && typeof event === 'object' && !Array.isArray(event), 'INVALID_EXTENSION', 'ledger event must be an object');
    invariant(event.sequence === expectedSequence, 'EXTENSION_SEQUENCE_MISMATCH', 'ledger extension sequence is not contiguous', {
      expectedSequence,
      actualSequence: event.sequence,
    });
    invariant(event.previoushash === previousHash, 'EXTENSION_HASH_LINK_MISMATCH', 'ledger extension previoushash does not match prior head', {
      sequence: event.sequence,
    });
    invariant(typeof event.hash === 'string' && HASH.test(event.hash), 'INVALID_EXTENSION', 'ledger event hash must be canonical sha256');
    const { hash, ...unsigned } = event;
    const expectedHash = `sha256:${sha256Canonical(unsigned)}`;
    invariant(hash === expectedHash, 'EXTENSION_EVENT_HASH_MISMATCH', 'ledger event hash verification failed', {
      sequence: event.sequence,
      expectedHash,
      actualHash: hash,
    });
    previousHash = hash;
    expectedSequence += 1;
  }

  invariant(previousHash === to.headHash, 'EXTENSION_HEAD_MISMATCH', 'ledger extension does not terminate at checkpoint head');
  return {
    clearinghouseId: to.clearinghouseId,
    fromSequence: from.sequence,
    toSequence: to.sequence,
    eventsVerified: events.length,
    headHash: to.headHash,
  };
}

export const FEDERATION_CHECKPOINT_SCHEMA = CHECKPOINT_SCHEMA;
export const FEDERATION_CHECKPOINT_ENVELOPE_SCHEMA = ENVELOPE_SCHEMA;
