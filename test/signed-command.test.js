import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signCommand, verifyCommand } from '../src/signed-command.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const otherKeyPair = generateKeyPairSync('ed25519');
const audience = 'urn:space-economy:clearinghouse:test';
const now = new Date('2026-08-26T21:00:30.000Z');

const input = (overrides = {}) => ({
  keyId: 'did:example:relay-one#key-1',
  actorId: 'relay-one',
  audience,
  operation: 'order.reserve',
  nonce: 'nonce-001',
  idempotencyKey: 'reserve-001',
  expectedVersion: 3,
  createdAt: '2026-08-26T21:00:00Z',
  expiresAt: '2026-08-26T21:01:00Z',
  payload: { offerId: 'offer-1', quantity: 8 },
  ...overrides,
});

const verifierOptions = (overrides = {}) => ({
  audience,
  clock: () => new Date(now),
  maxClockSkewSeconds: 0,
  maxLifetimeSeconds: 300,
  resolvePublicKey: async ({ keyId, actorId, algorithm }) => {
    assert.equal(keyId, 'did:example:relay-one#key-1');
    assert.equal(actorId, 'relay-one');
    assert.equal(algorithm, 'Ed25519');
    return publicKey;
  },
  ...overrides,
});

test('verifies a signed command and derives trusted clearinghouse context', async () => {
  const envelope = signCommand(input(), { privateKey });
  const verified = await verifyCommand(envelope, verifierOptions());

  assert.equal(verified.command.operation, 'order.reserve');
  assert.deepEqual(verified.command.payload, { offerId: 'offer-1', quantity: 8 });
  assert.deepEqual(verified.context, {
    actorId: 'relay-one',
    idempotencyKey: 'reserve-001',
    expectedVersion: 3,
  });
  assert.deepEqual(verified.replay, {
    actorId: 'relay-one',
    keyId: 'did:example:relay-one#key-1',
    nonce: 'nonce-001',
    expiresAt: '2026-08-26T21:01:00.000Z',
  });
  assert.match(verified.commandHash, /^sha256:[0-9a-f]{64}$/);
});

test('tampering any signed command field invalidates the signature', async () => {
  const envelope = signCommand(input(), { privateKey });
  for (const tampered of [
    { ...envelope, actorId: 'attacker' },
    { ...envelope, idempotencyKey: 'different-key' },
    { ...envelope, expectedVersion: 4 },
    { ...envelope, payload: { ...envelope.payload, quantity: 9 } },
  ]) {
    await assert.rejects(
      verifyCommand(tampered, verifierOptions({
        resolvePublicKey: async () => publicKey,
      })),
      (error) => error.code === 'INVALID_SIGNATURE',
    );
  }
});

test('wrong audience fails before command execution', async () => {
  const envelope = signCommand(input(), { privateKey });
  await assert.rejects(
    verifyCommand(envelope, verifierOptions({ audience: 'urn:space-economy:other' })),
    (error) => error.code === 'WRONG_AUDIENCE',
  );
});

test('expired, future, and overlong commands fail verifier time policy', async () => {
  const expired = signCommand(input({
    createdAt: '2026-08-26T20:58:00Z',
    expiresAt: '2026-08-26T20:59:00Z',
  }), { privateKey });
  await assert.rejects(
    verifyCommand(expired, verifierOptions()),
    (error) => error.code === 'COMMAND_EXPIRED',
  );

  const future = signCommand(input({
    createdAt: '2026-08-26T21:01:00Z',
    expiresAt: '2026-08-26T21:02:00Z',
  }), { privateKey });
  await assert.rejects(
    verifyCommand(future, verifierOptions()),
    (error) => error.code === 'COMMAND_NOT_YET_VALID',
  );

  const overlong = signCommand(input({
    createdAt: '2026-08-26T21:00:00Z',
    expiresAt: '2026-08-26T21:10:00Z',
  }), { privateKey });
  await assert.rejects(
    verifyCommand(overlong, verifierOptions()),
    (error) => error.code === 'COMMAND_LIFETIME_TOO_LONG',
  );
});

test('key resolution is an actor authorization boundary', async () => {
  const envelope = signCommand(input(), { privateKey });
  await assert.rejects(
    verifyCommand(envelope, verifierOptions({ resolvePublicKey: async () => null })),
    (error) => error.code === 'UNKNOWN_SIGNING_KEY',
  );
  await assert.rejects(
    verifyCommand(envelope, verifierOptions({ resolvePublicKey: async () => otherKeyPair.publicKey })),
    (error) => error.code === 'INVALID_SIGNATURE',
  );
});

test('rejects unsigned extension fields instead of ignoring them', async () => {
  const envelope = signCommand(input(), { privateKey });
  await assert.rejects(
    verifyCommand({ ...envelope, privileged: true }, verifierOptions()),
    (error) => error.code === 'UNSIGNED_EXTENSION',
  );
});

test('requires canonical base64url signatures and strict RFC 3339 timestamps', async () => {
  const envelope = signCommand(input(), { privateKey });
  await assert.rejects(
    verifyCommand({ ...envelope, signature: `${envelope.signature}=` }, verifierOptions()),
    (error) => error.code === 'INVALID_SIGNATURE',
  );
  assert.throws(
    () => signCommand(input({ createdAt: '2026-08-26', expiresAt: '2026-08-27' }), { privateKey }),
    (error) => error.code === 'INVALID_COMMAND',
  );
});

test('canonicalization makes semantically identical payload key order sign identically', () => {
  const left = signCommand(input({ payload: { offerId: 'offer-1', quantity: 8 } }), { privateKey });
  const right = signCommand(input({ payload: { quantity: 8, offerId: 'offer-1' } }), { privateKey });
  assert.equal(left.signature, right.signature);
});
