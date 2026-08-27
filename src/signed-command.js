import { sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { canonicalize, sha256Canonical } from './canonical-json.js';

const DOMAIN = 'space-economy.command.v1';
const SCHEMA = 'spaceeconomy.command.v1';
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ENVELOPE_FIELDS = new Set([
  'schema',
  'algorithm',
  'keyId',
  'actorId',
  'audience',
  'operation',
  'nonce',
  'idempotencyKey',
  'expectedVersion',
  'createdAt',
  'expiresAt',
  'payload',
  'signature',
]);

export class SignedCommandError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SignedCommandError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new SignedCommandError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_COMMAND', `${field} is required`);
  return value.trim();
}

function timestamp(value, field) {
  const normalized = nonEmptyString(value, field);
  invariant(RFC3339.test(normalized), 'INVALID_COMMAND', `${field} must be an RFC 3339 timestamp`);
  const milliseconds = Date.parse(normalized);
  invariant(Number.isFinite(milliseconds), 'INVALID_COMMAND', `${field} must be a valid RFC 3339 timestamp`);
  return { value: new Date(milliseconds).toISOString(), milliseconds };
}

function expectedVersion(value) {
  if (value === null || value === undefined) return null;
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_COMMAND', 'expectedVersion must be a positive safe integer');
  return value;
}

function unsignedCommand(input) {
  invariant(input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload), 'INVALID_COMMAND', 'payload must be an object');
  const created = timestamp(input.createdAt, 'createdAt');
  const expires = timestamp(input.expiresAt, 'expiresAt');
  invariant(expires.milliseconds > created.milliseconds, 'INVALID_COMMAND', 'expiresAt must be after createdAt');

  return {
    schema: SCHEMA,
    algorithm: 'Ed25519',
    keyId: nonEmptyString(input.keyId, 'keyId'),
    actorId: nonEmptyString(input.actorId, 'actorId'),
    audience: nonEmptyString(input.audience, 'audience'),
    operation: nonEmptyString(input.operation, 'operation'),
    nonce: nonEmptyString(input.nonce, 'nonce'),
    idempotencyKey: nonEmptyString(input.idempotencyKey, 'idempotencyKey'),
    expectedVersion: expectedVersion(input.expectedVersion),
    createdAt: created.value,
    expiresAt: expires.value,
    payload: structuredClone(input.payload),
  };
}

function signingBytes(command) {
  return Buffer.from(`${DOMAIN}\n${canonicalize(command)}`, 'utf8');
}

function decodeSignature(value) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_SIGNATURE', 'signature must be unpadded base64url');
  const decoded = Buffer.from(value, 'base64url');
  invariant(decoded.length === 64, 'INVALID_SIGNATURE', 'Ed25519 signature must be 64 bytes');
  invariant(decoded.toString('base64url') === value, 'INVALID_SIGNATURE', 'signature must use canonical unpadded base64url encoding');
  return decoded;
}

/**
 * Signs a transport-neutral command envelope using Ed25519.
 *
 * Key storage/rotation is deliberately outside this helper. `privateKey` may be
 * any Node.js key input accepted for Ed25519 signing, including a KeyObject.
 */
export function signCommand(input, { privateKey }) {
  invariant(privateKey, 'INVALID_CONFIGURATION', 'privateKey is required');
  const command = unsignedCommand(input);
  const signature = signBytes(null, signingBytes(command), privateKey).toString('base64url');
  return {
    ...command,
    signature,
  };
}

/**
 * Verifies a signed command and returns trusted command context.
 *
 * `resolvePublicKey` is the authorization boundary between keyId/actorId and a
 * trusted public key. A verifier must not resolve arbitrary caller-supplied keys
 * without proving that the key is authorized for the claimed actor.
 */
export async function verifyCommand(envelope, {
  resolvePublicKey,
  audience,
  clock = () => new Date(),
  maxClockSkewSeconds = 60,
  maxLifetimeSeconds = 300,
} = {}) {
  invariant(typeof resolvePublicKey === 'function', 'INVALID_CONFIGURATION', 'resolvePublicKey must be a function');
  invariant(Number.isSafeInteger(maxClockSkewSeconds) && maxClockSkewSeconds >= 0, 'INVALID_CONFIGURATION', 'maxClockSkewSeconds must be a non-negative safe integer');
  invariant(Number.isSafeInteger(maxLifetimeSeconds) && maxLifetimeSeconds > 0, 'INVALID_CONFIGURATION', 'maxLifetimeSeconds must be a positive safe integer');

  invariant(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'INVALID_COMMAND', 'command envelope must be an object');
  const unexpectedFields = Object.keys(envelope).filter((field) => !ENVELOPE_FIELDS.has(field));
  invariant(unexpectedFields.length === 0, 'UNSIGNED_EXTENSION', 'command envelope contains unsupported unsigned fields', { fields: unexpectedFields });
  invariant(envelope.schema === SCHEMA, 'UNSUPPORTED_COMMAND_SCHEMA', `unsupported command schema: ${envelope.schema ?? 'missing'}`);
  invariant(envelope.algorithm === 'Ed25519', 'UNSUPPORTED_SIGNATURE_ALGORITHM', `unsupported signature algorithm: ${envelope.algorithm ?? 'missing'}`);

  const expectedAudience = nonEmptyString(audience, 'audience');
  const command = unsignedCommand(envelope);
  invariant(command.audience === expectedAudience, 'WRONG_AUDIENCE', 'command audience does not match this clearinghouse');

  const createdMs = Date.parse(command.createdAt);
  const expiresMs = Date.parse(command.expiresAt);
  invariant(expiresMs - createdMs <= maxLifetimeSeconds * 1000, 'COMMAND_LIFETIME_TOO_LONG', 'command lifetime exceeds verifier policy');

  const now = clock();
  invariant(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
  const nowMs = now.getTime();
  const skewMs = maxClockSkewSeconds * 1000;
  invariant(createdMs <= nowMs + skewMs, 'COMMAND_NOT_YET_VALID', 'command creation time is too far in the future');
  invariant(expiresMs >= nowMs - skewMs, 'COMMAND_EXPIRED', 'command has expired');

  const signature = decodeSignature(envelope.signature);
  const publicKey = await resolvePublicKey({
    keyId: command.keyId,
    actorId: command.actorId,
    algorithm: command.algorithm,
  });
  invariant(publicKey, 'UNKNOWN_SIGNING_KEY', 'no trusted public key resolved for command actor/key');
  invariant(verifyBytes(null, signingBytes(command), publicKey, signature), 'INVALID_SIGNATURE', 'command signature verification failed');

  return {
    command: structuredClone(command),
    commandHash: `sha256:${sha256Canonical(command)}`,
    context: {
      actorId: command.actorId,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.expectedVersion,
    },
    replay: {
      actorId: command.actorId,
      keyId: command.keyId,
      nonce: command.nonce,
      expiresAt: command.expiresAt,
    },
  };
}
