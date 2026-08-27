import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialVerifierRegistry, createCredentialPolicyGate } from '../src/credentials.js';
import { PolicyGateEngine } from '../src/policy.js';

const fixedClock = () => new Date('2026-08-26T22:30:00.000Z');

const credential = (overrides = {}) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'OperatorLicenseCredential'],
  issuer: 'did:example:authority',
  credentialSubject: {
    id: 'operator-one',
    licenseClass: 'orbital-services',
  },
  ...overrides,
});

const validVerifier = async () => ({
  status: 'valid',
  verifierId: 'example:vc-verifier',
  profileVersion: '2026-08',
  subjectId: 'operator-one',
  issuerId: 'did:example:authority',
  types: ['OperatorLicenseCredential', 'VerifiableCredential'],
  claims: { licenseClass: 'orbital-services', active: true },
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: '2027-01-01T00:00:00Z',
  evidence: [{ method: 'example-proof-suite', keyId: 'did:example:authority#key-1' }],
});

test('normalizes an attributable valid credential attestation', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  registry.register('operator-license/v1', validVerifier);

  const attestation = await registry.verify({
    profile: 'operator-license/v1',
    credential: credential(),
    expectedSubjectId: 'operator-one',
  });

  assert.equal(attestation.status, 'valid');
  assert.equal(attestation.subjectId, 'operator-one');
  assert.equal(attestation.issuerId, 'did:example:authority');
  assert.equal(attestation.subjectMatches, true);
  assert.deepEqual(attestation.types, ['OperatorLicenseCredential', 'VerifiableCredential']);
  assert.equal(attestation.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(attestation.validUntil, '2027-01-01T00:00:00.000Z');
  assert.match(attestation.credentialHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(attestation.attestationHash, /^sha256:[0-9a-f]{64}$/);
});

test('credential digest is independent of JSON property insertion order', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  registry.register('operator-license/v1', validVerifier);

  const left = await registry.verify({
    profile: 'operator-license/v1',
    credential: credential({ credentialSubject: { id: 'operator-one', licenseClass: 'orbital-services' } }),
  });
  const rightCredential = {
    credentialSubject: { licenseClass: 'orbital-services', id: 'operator-one' },
    issuer: 'did:example:authority',
    type: ['VerifiableCredential', 'OperatorLicenseCredential'],
    '@context': ['https://www.w3.org/ns/credentials/v2'],
  };
  const right = await registry.verify({ profile: 'operator-license/v1', credential: rightCredential });

  assert.equal(left.credentialHash, right.credentialHash);
});

test('valid credential for another subject fails actor binding', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  registry.register('operator-license/v1', validVerifier);

  const attestation = await registry.verify({
    profile: 'operator-license/v1',
    credential: credential(),
    expectedSubjectId: 'different-operator',
  });

  assert.equal(attestation.status, 'invalid');
  assert.equal(attestation.subjectMatches, false);
  assert.match(attestation.reason, /does not match/);
  await assert.rejects(
    registry.requireValid({
      profile: 'operator-license/v1',
      credential: credential(),
      expectedSubjectId: 'different-operator',
    }),
    (error) => error.code === 'CREDENTIAL_NOT_VALID',
  );
});

test('unknown profiles and malformed verifier results fail closed', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  await assert.rejects(
    registry.verify({ profile: 'unknown/v1', credential: credential() }),
    (error) => error.code === 'UNSUPPORTED_CREDENTIAL_PROFILE',
  );

  registry.register('bad/v1', async () => ({
    status: 'valid',
    verifierId: 'bad-verifier',
    profileVersion: '1',
  }));
  await assert.rejects(
    registry.verify({ profile: 'bad/v1', credential: credential() }),
    (error) => error.code === 'INVALID_VERIFIER_RESULT',
  );
});

test('credential policy gate maps verification status into fail-safe policy decisions', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  let status = 'valid';
  registry.register('operator-license/v1', async () => ({
    ...(await validVerifier()),
    status,
    reason: `credential ${status}`,
  }));

  const engine = new PolicyGateEngine({ clock: fixedClock });
  engine.register('operator-license', createCredentialPolicyGate({
    registry,
    profile: 'operator-license/v1',
    credentialProvider: async () => credential(),
  }));

  const request = {
    operation: 'offer.create',
    actor: { actorId: 'operator-one' },
    resource: { payload: {} },
    context: {},
  };

  assert.equal((await engine.evaluate(request)).decision, 'allow');
  status = 'invalid';
  assert.equal((await engine.evaluate(request)).decision, 'deny');
  status = 'indeterminate';
  assert.equal((await engine.evaluate(request)).decision, 'review');
});

test('mandatory credential policy can deny or review missing credentials explicitly', async () => {
  const registry = new CredentialVerifierRegistry({ clock: fixedClock });
  registry.register('operator-license/v1', validVerifier);

  const denyEngine = new PolicyGateEngine({ clock: fixedClock });
  denyEngine.register('license', createCredentialPolicyGate({
    registry,
    profile: 'operator-license/v1',
    credentialProvider: async () => null,
  }));
  const reviewEngine = new PolicyGateEngine({ clock: fixedClock });
  reviewEngine.register('license', createCredentialPolicyGate({
    registry,
    profile: 'operator-license/v1',
    credentialProvider: async () => null,
    missingDecision: 'review',
  }));
  const request = { operation: 'asset.register', actor: { actorId: 'operator-one' }, resource: null, context: {} };

  assert.equal((await denyEngine.evaluate(request)).decision, 'deny');
  assert.equal((await reviewEngine.evaluate(request)).decision, 'review');
});

test('credential verifier profiles cannot be silently replaced', () => {
  const registry = new CredentialVerifierRegistry();
  registry.register('operator-license/v1', validVerifier);
  assert.throws(
    () => registry.register('operator-license/v1', validVerifier),
    (error) => error.code === 'VERIFIER_EXISTS',
  );
});
