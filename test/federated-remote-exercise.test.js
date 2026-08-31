import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { sha256Canonical } from '../src/canonical-json.js';
import { Clearinghouse } from '../src/clearinghouse.js';
import {
  createFederationCheckpoint,
  signFederationCheckpoint,
} from '../src/federation.js';
import { PolicyGateEngine } from '../src/policy.js';
import { admitFederatedCapacityRight } from '../src/extensions/federated-capacity-rights.js';
import {
  createFederatedRemoteExerciseIntent,
  verifyFederatedRemoteExerciseProof,
} from '../src/extensions/federated-remote-exercise.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function termsFromRight(right) {
  return {
    offerId: right.offerId,
    assetId: right.assetId,
    sellerId: right.sellerId,
    service: right.service,
    unit: right.unit,
    quantity: right.quantity,
    exerciseUnitPrice: right.exerciseUnitPrice,
    reservationTtlSeconds: right.reservationTtlSeconds,
    expiresAt: right.expiresAt,
    metadata: right.metadata,
  };
}

function policy(clock) {
  const engine = new PolicyGateEngine({ clock });
  engine.register('issuer-trust', {
    version: '1',
    evaluate: async () => ({ decision: 'allow', reason: 'issuer accepted for remote routing' }),
  });
  return engine;
}

async function setup() {
  let now = new Date('2026-09-01T00:00:00.000Z');
  let id = 0;
  const clock = () => new Date(now);
  const setTime = (value) => { now = new Date(value); };
  const issuer = await Clearinghouse.open({ clock, idGenerator: () => `id-${++id}` });
  const asset = await issuer.registerAsset({ name: 'Remote Relay', type: 'relay' }, ctx('seller'));
  const offer = await issuer.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '30', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 120,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, ctx('seller'));
  const checkpoint0 = await createFederationCheckpoint({ market: issuer, clearinghouseId: 'issuer', clock });
  const right = await issuer.createCapacityRight({
    offerId: offer.id,
    holderId: 'buyer',
    quantity: 20,
    exerciseUnitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
    reservationTtlSeconds: 60,
    expiresAt: '2026-09-01T01:00:00.000Z',
    metadata: { mission: 'remote-exercise' },
  }, ctx('seller'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const resolvePublicKey = async ({ clearinghouseId, keyId }) => (
    clearinghouseId === 'issuer' && keyId === 'key-1' ? publicKey : null
  );
  const checkpoint1 = await createFederationCheckpoint({
    market: issuer,
    clearinghouseId: 'issuer',
    previousCheckpoint: checkpoint0,
    clock,
  });
  const envelope1 = signFederationCheckpoint(checkpoint1, { keyId: 'key-1', privateKey });
  const admission = await admitFederatedCapacityRight({
    fromCheckpoint: checkpoint0,
    checkpointEnvelope: envelope1,
    events: (await issuer.getLedger()).slice(checkpoint0.sequence),
    capacityRightId: right.id,
    rightTerms: termsFromRight(right),
    resolvePublicKey,
    policyEngine: policy(clock),
    actor: { actorId: 'router' },
    expectedHolderId: 'buyer',
    expectedIssuerClearinghouseId: 'issuer',
    clock,
  });
  return {
    issuer,
    right,
    checkpoint1,
    admission,
    privateKey,
    resolvePublicKey,
    clock,
    setTime,
  };
}

async function nextCheckpoint(fx) {
  const checkpoint = await createFederationCheckpoint({
    market: fx.issuer,
    clearinghouseId: 'issuer',
    previousCheckpoint: fx.checkpoint1,
    clock: fx.clock,
  });
  return {
    checkpoint,
    envelope: signFederationCheckpoint(checkpoint, { keyId: 'key-1', privateKey: fx.privateKey }),
    events: (await fx.issuer.getLedger()).slice(fx.checkpoint1.sequence),
  };
}

function intentFor(fx, overrides = {}) {
  return createFederatedRemoteExerciseIntent({
    admission: fx.admission,
    holderId: 'buyer',
    idempotencyKey: 'remote-exercise:mission-1:relay',
    expiresAt: '2026-09-01T00:10:00.000Z',
    clock: fx.clock,
    ...overrides,
  });
}

function makeEvent({ previousHash, sequence, type, subject, data, time = '2026-09-01T00:00:00.000Z', id = `fake-${sequence}` }) {
  const unsigned = {
    specversion: '1.0',
    id,
    source: 'urn:space-economy:clearinghouse',
    type,
    subject,
    time,
    datacontenttype: 'application/json',
    sequence,
    previoushash: previousHash,
    data,
  };
  return { ...unsigned, hash: `sha256:${sha256Canonical(unsigned)}` };
}

function signedCheckpointForEvents({ previousCheckpoint, events, privateKey, revision = previousCheckpoint.revision + 1 }) {
  const headHash = events.length === 0 ? previousCheckpoint.headHash : events.at(-1).hash;
  const body = {
    schema: 'spaceeconomy.federation-checkpoint.v1',
    clearinghouseId: previousCheckpoint.clearinghouseId,
    revision,
    sequence: previousCheckpoint.sequence + events.length,
    headHash,
    generatedAt: '2026-09-01T00:00:00.000Z',
    previousCheckpointHash: previousCheckpoint.checkpointHash,
  };
  const checkpoint = { ...body, checkpointHash: `sha256:${sha256Canonical(body)}` };
  return signFederationCheckpoint(checkpoint, { keyId: 'key-1', privateKey });
}

test('proves exactly one issuer order from paired right-exercise and order-reservation events without local order creation', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  const local = await Clearinghouse.open();
  const localRevision = await local.getRevision();

  const order = await fx.issuer.exerciseCapacityRight(fx.right.id, ctx('buyer', {
    idempotencyKey: intent.idempotencyKey,
  }));
  const replay = await fx.issuer.exerciseCapacityRight(fx.right.id, ctx('buyer', {
    idempotencyKey: intent.idempotencyKey,
  }));
  assert.equal(replay.id, order.id);

  const successor = await nextCheckpoint(fx);
  const proof = await verifyFederatedRemoteExerciseProof({
    intent,
    admission: fx.admission,
    checkpointEnvelope: successor.envelope,
    events: successor.events,
    resolvePublicKey: fx.resolvePublicKey,
    expectedIssuerOrderId: order.id,
    clock: fx.clock,
  });

  assert.equal(proof.issuerOrder.id, order.id);
  assert.equal(proof.issuerOrder.capacityRightId, fx.right.id);
  assert.deepEqual(proof.issuerOrder.total, { settlementAsset: 'iso4217:USD', amount: '500', scale: 2 });
  assert.equal(proof.evidence.exerciseEventSequence, proof.evidence.orderEventSequence + 1);
  assert.equal(proof.localOrderCreated, false);
  assert.equal(proof.issuerAuthoritative, true);
  assert.match(proof.proofHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await local.getRevision(), localRevision);
  assert.equal(successor.events.filter((event) => event.type === 'spaceeconomy.order.reserved.v1').length, 1);
});

test('remote exercise intent is deterministic and cannot be created from stale admission evidence', async () => {
  const fx = await setup();
  const first = intentFor(fx);
  const second = intentFor(fx);
  assert.deepEqual(first, second);
  assert.match(first.intentHash, /^sha256:[0-9a-f]{64}$/);

  fx.setTime('2026-09-01T00:10:00.000Z');
  assert.throws(
    () => intentFor(fx, { maxAdmissionAgeSeconds: 60, expiresAt: '2026-09-01T00:20:00.000Z' }),
    (error) => error.code === 'STALE_REMOTE_ADMISSION',
  );
});

test('transfer after the admitted state invalidates the remote exercise intent proof path', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  const current = await fx.issuer.getCapacityRight(fx.right.id, ctx('buyer'));
  await fx.issuer.transferCapacityRight(fx.right.id, { toHolderId: 'other-buyer' }, ctx('buyer', { expectedVersion: current.version }));
  const successor = await nextCheckpoint(fx);

  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent,
      admission: fx.admission,
      checkpointEnvelope: successor.envelope,
      events: successor.events,
      resolvePublicKey: fx.resolvePublicKey,
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_RIGHT_CHANGED_AFTER_INTENT',
  );
});

test('valid signed issuer history must contain the paired order reservation, not only an exercise claim', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  const exercise = makeEvent({
    previousHash: fx.checkpoint1.headHash,
    sequence: fx.checkpoint1.sequence + 1,
    type: 'spaceeconomy.capacity-right.exercised.v1',
    subject: `capacity-right/${fx.right.id}`,
    data: {
      capacityRightId: fx.right.id,
      orderId: 'fake-order',
      offerId: fx.right.offerId,
      sellerId: fx.right.sellerId,
      holderId: 'buyer',
      termsHash: fx.right.termsHash,
    },
  });
  const envelope = signedCheckpointForEvents({ previousCheckpoint: fx.checkpoint1, events: [exercise], privateKey: fx.privateKey });

  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent,
      admission: fx.admission,
      checkpointEnvelope: envelope,
      events: [exercise],
      resolvePublicKey: fx.resolvePublicKey,
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_ORDER_EVENT_MISSING',
  );
});

test('a cryptographically valid issuer extension with the wrong order amount fails semantic proof verification', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  const order = makeEvent({
    previousHash: fx.checkpoint1.headHash,
    sequence: fx.checkpoint1.sequence + 1,
    type: 'spaceeconomy.order.reserved.v1',
    subject: 'order/fake-order',
    data: {
      orderId: 'fake-order',
      offerId: fx.right.offerId,
      buyerId: 'buyer',
      sellerId: fx.right.sellerId,
      quantity: fx.right.quantity,
      total: { settlementAsset: 'iso4217:USD', amount: '501', scale: 2 },
      fundingDueAt: null,
      capacityRightId: fx.right.id,
      capacityRightTermsHash: fx.right.termsHash,
    },
  });
  const exercise = makeEvent({
    previousHash: order.hash,
    sequence: order.sequence + 1,
    type: 'spaceeconomy.capacity-right.exercised.v1',
    subject: `capacity-right/${fx.right.id}`,
    data: {
      capacityRightId: fx.right.id,
      orderId: 'fake-order',
      offerId: fx.right.offerId,
      sellerId: fx.right.sellerId,
      holderId: 'buyer',
      termsHash: fx.right.termsHash,
    },
  });
  const events = [order, exercise];
  const envelope = signedCheckpointForEvents({ previousCheckpoint: fx.checkpoint1, events, privateKey: fx.privateKey });

  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent,
      admission: fx.admission,
      checkpointEnvelope: envelope,
      events,
      resolvePublicKey: fx.resolvePublicKey,
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_EXERCISE_AMOUNT_MISMATCH',
  );
});

test('expected issuer order ID is an explicit reconciliation boundary', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  await fx.issuer.exerciseCapacityRight(fx.right.id, ctx('buyer', { idempotencyKey: intent.idempotencyKey }));
  const successor = await nextCheckpoint(fx);

  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent,
      admission: fx.admission,
      checkpointEnvelope: successor.envelope,
      events: successor.events,
      resolvePublicKey: fx.resolvePublicKey,
      expectedIssuerOrderId: 'wrong-order',
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_ORDER_ID_MISMATCH',
  );
});

test('tampering the admission or intent fails before federation evidence is consumed', async () => {
  const fx = await setup();
  const intent = intentFor(fx);
  const badAdmission = structuredClone(fx.admission);
  badAdmission.right.holderId = 'attacker';

  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent,
      admission: badAdmission,
      checkpointEnvelope: {},
      events: [],
      resolvePublicKey: fx.resolvePublicKey,
      clock: fx.clock,
    }),
    (error) => error.code === 'ADMISSION_HASH_MISMATCH',
  );

  const badIntent = structuredClone(intent);
  badIntent.holderId = 'attacker';
  await assert.rejects(
    verifyFederatedRemoteExerciseProof({
      intent: badIntent,
      admission: fx.admission,
      checkpointEnvelope: {},
      events: [],
      resolvePublicKey: fx.resolvePublicKey,
      clock: fx.clock,
    }),
    (error) => error.code === 'INTENT_HASH_MISMATCH',
  );
});
