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
import {
  admitFederatedCapacityRight,
  refreshFederatedCapacityRightAdmission,
} from '../src/extensions/federated-capacity-rights.js';

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

function allowPolicy(clock) {
  const engine = new PolicyGateEngine({ clock });
  engine.register('trusted-federation', {
    version: '1',
    evaluate: async ({ resource }) => ({
      decision: 'allow',
      reason: `issuer ${resource.issuerClearinghouseId} is trusted`,
      claims: { trustDomain: 'test-federation' },
    }),
  });
  return engine;
}

function denyPolicy(clock) {
  const engine = new PolicyGateEngine({ clock });
  engine.register('deny-foreign-rights', {
    version: '1',
    evaluate: async () => ({ decision: 'deny', reason: 'foreign rights disabled' }),
  });
  return engine;
}

async function fixture() {
  let now = new Date('2026-09-01T00:00:00.000Z');
  let nextId = 0;
  const clock = () => new Date(now);
  const setTime = (value) => { now = new Date(value); };
  const market = await Clearinghouse.open({ clock, idGenerator: () => `issuer-id-${++nextId}` });
  const asset = await market.registerAsset({
    name: 'Federated Relay',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
  }, ctx('issuer-seller'));
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '30', scale: 2 },
    capacity: 100,
    reservationTtlSeconds: 300,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, ctx('issuer-seller'));
  const checkpoint0 = await createFederationCheckpoint({
    market,
    clearinghouseId: 'issuer-clearinghouse',
    clock,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const resolvePublicKey = async ({ clearinghouseId, keyId }) => (
    clearinghouseId === 'issuer-clearinghouse' && keyId === 'issuer-key-1' ? publicKey : null
  );
  const policyClock = () => new Date(now);
  return {
    market,
    offer,
    checkpoint0,
    privateKey,
    resolvePublicKey,
    clock,
    policyClock,
    setTime,
  };
}

async function checkpointAfter({ market, previousCheckpoint, privateKey, clock }) {
  const checkpoint = await createFederationCheckpoint({
    market,
    clearinghouseId: 'issuer-clearinghouse',
    previousCheckpoint,
    clock,
  });
  return {
    checkpoint,
    envelope: signFederationCheckpoint(checkpoint, { keyId: 'issuer-key-1', privateKey }),
  };
}

function extensionEvents(ledger, fromCheckpoint) {
  return ledger.slice(fromCheckpoint.sequence);
}

test('admits issuance plus transfers from a signed contiguous issuer extension without local capacity mutation', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 20,
    exerciseUnitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
    reservationTtlSeconds: 120,
    expiresAt: '2026-09-01T01:00:00.000Z',
    metadata: { mission: 'federated-demo' },
  }, ctx('issuer-seller'));
  await fx.market.transferCapacityRight(right.id, { toHolderId: 'buyer-b' }, ctx('buyer-a', { expectedVersion: right.version }));
  const { checkpoint, envelope } = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  const events = extensionEvents(await fx.market.getLedger(), fx.checkpoint0);

  const localMarket = await Clearinghouse.open();
  const localRevision = await localMarket.getRevision();
  const admission = await admitFederatedCapacityRight({
    fromCheckpoint: fx.checkpoint0,
    checkpointEnvelope: envelope,
    events,
    capacityRightId: right.id,
    rightTerms: termsFromRight(right),
    resolvePublicKey: fx.resolvePublicKey,
    policyEngine: allowPolicy(fx.policyClock),
    actor: { actorId: 'local-router' },
    expectedIssuerClearinghouseId: 'issuer-clearinghouse',
    expectedHolderId: 'buyer-b',
    clock: fx.clock,
  });

  assert.equal(admission.issuerClearinghouseId, 'issuer-clearinghouse');
  assert.equal(admission.right.id, right.id);
  assert.equal(admission.right.holderId, 'buyer-b');
  assert.equal(admission.right.transferSequence, 1);
  assert.equal(admission.right.status, 'held');
  assert.equal(admission.right.terms.service, 'data-relay');
  assert.equal(admission.checkpoint.checkpointHash, checkpoint.checkpointHash);
  assert.equal(admission.policy.decision, 'allow');
  assert.match(admission.admissionHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await localMarket.getRevision(), localRevision);
});

test('supplied immutable terms are accepted only when their canonical hash matches issuer creation evidence', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T01:00:00.000Z',
    metadata: { purpose: 'relay' },
  }, ctx('issuer-seller'));
  const { envelope } = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  const tampered = termsFromRight(right);
  tampered.service = 'launch';

  await assert.rejects(
    admitFederatedCapacityRight({
      fromCheckpoint: fx.checkpoint0,
      checkpointEnvelope: envelope,
      events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
      capacityRightId: right.id,
      rightTerms: tampered,
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: allowPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      clock: fx.clock,
    }),
    (error) => error.code === 'RIGHT_TERMS_HASH_MISMATCH',
  );
});

test('refresh follows issuer transfers and invalidates the previously admitted holder', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, ctx('issuer-seller'));
  const first = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  const admission = await admitFederatedCapacityRight({
    fromCheckpoint: fx.checkpoint0,
    checkpointEnvelope: first.envelope,
    events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
    capacityRightId: right.id,
    rightTerms: termsFromRight(right),
    resolvePublicKey: fx.resolvePublicKey,
    policyEngine: allowPolicy(fx.policyClock),
    actor: { actorId: 'router' },
    expectedHolderId: 'buyer-a',
    clock: fx.clock,
  });

  const current = await fx.market.getCapacityRight(right.id, ctx('buyer-a'));
  await fx.market.transferCapacityRight(right.id, { toHolderId: 'buyer-b' }, ctx('buyer-a', { expectedVersion: current.version }));
  const second = await checkpointAfter({ ...fx, previousCheckpoint: first.checkpoint });
  const refreshEvents = extensionEvents(await fx.market.getLedger(), first.checkpoint);

  await assert.rejects(
    refreshFederatedCapacityRightAdmission({
      priorAdmission: admission,
      checkpointEnvelope: second.envelope,
      events: refreshEvents,
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: allowPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      expectedHolderId: 'buyer-a',
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_HOLDER_MISMATCH',
  );

  const refreshed = await refreshFederatedCapacityRightAdmission({
    priorAdmission: admission,
    checkpointEnvelope: second.envelope,
    events: refreshEvents,
    resolvePublicKey: fx.resolvePublicKey,
    policyEngine: allowPolicy(fx.policyClock),
    actor: { actorId: 'router' },
    expectedHolderId: 'buyer-b',
    clock: fx.clock,
  });
  assert.equal(refreshed.right.holderId, 'buyer-b');
  assert.equal(refreshed.previousAdmissionHash, admission.admissionHash);
  assert.notEqual(refreshed.admissionHash, admission.admissionHash);
});

test('release, expiry, or exercise evidence prevents a spendable refreshed admission', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, ctx('issuer-seller'));
  const first = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  const admission = await admitFederatedCapacityRight({
    fromCheckpoint: fx.checkpoint0,
    checkpointEnvelope: first.envelope,
    events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
    capacityRightId: right.id,
    rightTerms: termsFromRight(right),
    resolvePublicKey: fx.resolvePublicKey,
    policyEngine: allowPolicy(fx.policyClock),
    actor: { actorId: 'router' },
    clock: fx.clock,
  });
  const current = await fx.market.getCapacityRight(right.id, ctx('buyer-a'));
  await fx.market.releaseCapacityRight(right.id, ctx('buyer-a', { expectedVersion: current.version }));
  const second = await checkpointAfter({ ...fx, previousCheckpoint: first.checkpoint });

  await assert.rejects(
    refreshFederatedCapacityRightAdmission({
      priorAdmission: admission,
      checkpointEnvelope: second.envelope,
      events: extensionEvents(await fx.market.getLedger(), first.checkpoint),
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: allowPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      clock: fx.clock,
    }),
    (error) => error.code === 'REMOTE_RIGHT_NOT_SPENDABLE',
  );
});

test('freshness policy rejects stale issuer evidence even when signature and ledger extension are valid', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T02:00:00.000Z',
  }, ctx('issuer-seller'));
  const { envelope } = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  fx.setTime('2026-09-01T00:10:00.000Z');

  await assert.rejects(
    admitFederatedCapacityRight({
      fromCheckpoint: fx.checkpoint0,
      checkpointEnvelope: envelope,
      events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
      capacityRightId: right.id,
      rightTerms: termsFromRight(right),
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: allowPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      clock: fx.clock,
      maxCheckpointAgeSeconds: 60,
    }),
    (error) => error.code === 'STALE_REMOTE_CHECKPOINT',
  );
});

test('local policy denial remains an attributable admission boundary', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T01:00:00.000Z',
  }, ctx('issuer-seller'));
  const { envelope } = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });

  await assert.rejects(
    admitFederatedCapacityRight({
      fromCheckpoint: fx.checkpoint0,
      checkpointEnvelope: envelope,
      events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
      capacityRightId: right.id,
      rightTerms: termsFromRight(right),
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: denyPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      clock: fx.clock,
    }),
    (error) => error.code === 'POLICY_NOT_ALLOWED' && error.details?.decision === 'deny',
  );
});

test('federation same-sequence equivocation fails before right admission', async () => {
  const fx = await fixture();
  const body = {
    schema: 'spaceeconomy.federation-checkpoint.v1',
    clearinghouseId: fx.checkpoint0.clearinghouseId,
    revision: fx.checkpoint0.revision,
    sequence: fx.checkpoint0.sequence,
    headHash: `sha256:${'f'.repeat(64)}`,
    generatedAt: fx.clock().toISOString(),
    previousCheckpointHash: fx.checkpoint0.checkpointHash,
  };
  const fork = { ...body, checkpointHash: `sha256:${sha256Canonical(body)}` };
  const envelope = signFederationCheckpoint(fork, { keyId: 'issuer-key-1', privateKey: fx.privateKey });

  await assert.rejects(
    admitFederatedCapacityRight({
      fromCheckpoint: fx.checkpoint0,
      checkpointEnvelope: envelope,
      events: [],
      capacityRightId: 'never-reached',
      rightTerms: {},
      resolvePublicKey: fx.resolvePublicKey,
      policyEngine: allowPolicy(fx.policyClock),
      actor: { actorId: 'router' },
      clock: fx.clock,
    }),
    (error) => error.code === 'CHECKPOINT_FORK',
  );
});

test('admission hash is deterministic for identical verified evidence and policy evaluation', async () => {
  const fx = await fixture();
  const right = await fx.market.createCapacityRight({
    offerId: fx.offer.id,
    holderId: 'buyer-a',
    quantity: 10,
    exerciseUnitPrice: fx.offer.unitPrice,
    expiresAt: '2026-09-01T01:00:00.000Z',
    metadata: { b: 2, a: 1 },
  }, ctx('issuer-seller'));
  const { envelope } = await checkpointAfter({ ...fx, previousCheckpoint: fx.checkpoint0 });
  const input = {
    fromCheckpoint: fx.checkpoint0,
    checkpointEnvelope: envelope,
    events: extensionEvents(await fx.market.getLedger(), fx.checkpoint0),
    capacityRightId: right.id,
    rightTerms: termsFromRight(right),
    resolvePublicKey: fx.resolvePublicKey,
    actor: { actorId: 'router' },
    clock: fx.clock,
  };
  const first = await admitFederatedCapacityRight({ ...input, policyEngine: allowPolicy(fx.policyClock) });
  const second = await admitFederatedCapacityRight({ ...input, policyEngine: allowPolicy(fx.policyClock) });

  assert.equal(first.admissionHash, second.admissionHash);
  assert.deepEqual(first, second);
});
