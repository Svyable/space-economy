import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { sha256Canonical } from '../src/canonical-json.js';
import {
  createFederationCheckpoint,
  signFederationCheckpoint,
  verifyFederationCheckpoint,
  verifyFederationExtension,
} from '../src/federation.js';

const CLEARINGHOUSE_ID = 'urn:space-economy:clearinghouse:alpha';

async function fixture() {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  return {
    market,
    clock,
    setNow(value) { now = new Date(value); },
  };
}

function keyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    keyId: 'did:key:alpha#federation-1',
    resolver: async ({ keyId, clearinghouseId, algorithm }) => (
      keyId === 'did:key:alpha#federation-1'
      && clearinghouseId === CLEARINGHOUSE_ID
      && algorithm === 'Ed25519'
        ? publicKey
        : null
    ),
  };
}

function rehash(checkpoint, overrides) {
  const next = { ...checkpoint, ...overrides };
  const body = {
    schema: next.schema,
    clearinghouseId: next.clearinghouseId,
    revision: next.revision,
    sequence: next.sequence,
    headHash: next.headHash,
    generatedAt: next.generatedAt,
    previousCheckpointHash: next.previousCheckpointHash,
  };
  return { ...body, checkpointHash: `sha256:${sha256Canonical(body)}` };
}

test('creates and verifies a signed checkpoint over a real clearinghouse ledger', async () => {
  const { market, clock } = await fixture();
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller-a' });
  await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
  }, { actorId: 'seller-a' });

  const checkpoint = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  assert.equal(checkpoint.revision, 2);
  assert.equal(checkpoint.sequence, 2);
  assert.equal(checkpoint.headHash, (await market.getLedger()).at(-1).hash);
  assert.equal(checkpoint.previousCheckpointHash, null);

  const keys = keyFixture();
  const envelope = signFederationCheckpoint(checkpoint, keys);
  const verified = await verifyFederationCheckpoint(envelope, {
    resolvePublicKey: keys.resolver,
    expectedClearinghouseId: CLEARINGHOUSE_ID,
  });
  assert.deepEqual(verified.checkpoint, checkpoint);
  assert.equal(verified.signer.keyId, keys.keyId);
});

test('empty clearinghouse checkpoints use the GENESIS ledger head', async () => {
  const { market, clock } = await fixture();
  const checkpoint = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  assert.equal(checkpoint.revision, 0);
  assert.equal(checkpoint.sequence, 0);
  assert.equal(checkpoint.headHash, 'GENESIS');
});

test('checkpoint construction retries torn reads and fails after the configured bound', async () => {
  let revisionCalls = 0;
  const retryingMarket = {
    async getRevision() {
      revisionCalls += 1;
      return [1, 2, 2, 2][revisionCalls - 1];
    },
    async verifyLedger() { return true; },
    async getLedger() { return []; },
  };
  const checkpoint = await createFederationCheckpoint({
    market: retryingMarket,
    clearinghouseId: CLEARINGHOUSE_ID,
    clock: () => new Date('2026-09-01T00:00:00.000Z'),
    maxRevisionRetries: 2,
  });
  assert.equal(checkpoint.revision, 2);
  assert.equal(revisionCalls, 4);

  let changing = 0;
  const unstableMarket = {
    async getRevision() { changing += 1; return changing; },
    async verifyLedger() { return true; },
    async getLedger() { return []; },
  };
  await assert.rejects(
    createFederationCheckpoint({
      market: unstableMarket,
      clearinghouseId: CLEARINGHOUSE_ID,
      clock: () => new Date('2026-09-01T00:00:00.000Z'),
      maxRevisionRetries: 2,
    }),
    (error) => error.code === 'FEDERATION_SNAPSHOT_CHANGED',
  );
});

test('checkpoint signing and verification fail closed on tampering, wrong identity, and unsigned extensions', async () => {
  const { market, clock } = await fixture();
  const checkpoint = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  const keys = keyFixture();
  const envelope = signFederationCheckpoint(checkpoint, keys);

  await assert.rejects(
    verifyFederationCheckpoint({
      ...envelope,
      checkpoint: { ...envelope.checkpoint, revision: envelope.checkpoint.revision + 1 },
    }, { resolvePublicKey: keys.resolver }),
    (error) => error.code === 'CHECKPOINT_HASH_MISMATCH',
  );

  const signatureBytes = Buffer.from(envelope.signature, 'base64url');
  signatureBytes[0] ^= 1;
  await assert.rejects(
    verifyFederationCheckpoint({ ...envelope, signature: signatureBytes.toString('base64url') }, { resolvePublicKey: keys.resolver }),
    (error) => error.code === 'INVALID_SIGNATURE',
  );

  await assert.rejects(
    verifyFederationCheckpoint(envelope, {
      resolvePublicKey: keys.resolver,
      expectedClearinghouseId: 'urn:space-economy:clearinghouse:other',
    }),
    (error) => error.code === 'CLEARINGHOUSE_MISMATCH',
  );

  await assert.rejects(
    verifyFederationCheckpoint({ ...envelope, note: 'unsigned ambiguity' }, { resolvePublicKey: keys.resolver }),
    (error) => error.code === 'UNSIGNED_EXTENSION',
  );

  await assert.rejects(
    verifyFederationCheckpoint(envelope, { resolvePublicKey: async () => null }),
    (error) => error.code === 'UNKNOWN_SIGNING_KEY',
  );
});

test('checkpoint chaining rejects regression, wrong predecessor, and same-sequence forks', async () => {
  const { market, clock, setNow } = await fixture();
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller-a' });
  const first = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
  }, { actorId: 'seller-a' });
  setNow('2026-09-01T00:01:00.000Z');
  const second = await createFederationCheckpoint({
    market,
    clearinghouseId: CLEARINGHOUSE_ID,
    previousCheckpoint: first,
    clock,
  });
  const keys = keyFixture();
  const signedSecond = signFederationCheckpoint(second, keys);
  await verifyFederationCheckpoint(signedSecond, {
    resolvePublicKey: keys.resolver,
    previousCheckpoint: first,
  });

  const wrongPredecessor = rehash(first, { generatedAt: '2026-09-01T00:00:30.000Z' });
  await assert.rejects(
    verifyFederationCheckpoint(signedSecond, {
      resolvePublicKey: keys.resolver,
      previousCheckpoint: wrongPredecessor,
    }),
    (error) => error.code === 'CHECKPOINT_LINK_MISMATCH',
  );

  const regressed = rehash(second, {
    revision: 0,
    sequence: 0,
    headHash: 'GENESIS',
  });
  const signedRegressed = signFederationCheckpoint(regressed, keys);
  await assert.rejects(
    verifyFederationCheckpoint(signedRegressed, {
      resolvePublicKey: keys.resolver,
      previousCheckpoint: first,
    }),
    (error) => error.code === 'CHECKPOINT_REGRESSION',
  );

  const forkHash = `sha256:${'0'.repeat(64)}`;
  const fork = rehash(first, {
    previousCheckpointHash: first.checkpointHash,
    headHash: forkHash,
  });
  const signedFork = signFederationCheckpoint(fork, keys);
  await assert.rejects(
    verifyFederationCheckpoint(signedFork, {
      resolvePublicKey: keys.resolver,
      previousCheckpoint: first,
    }),
    (error) => error.code === 'CHECKPOINT_FORK',
  );
});

test('verifies exactly the incremental ledger segment between chained checkpoints', async () => {
  const { market, clock, setNow } = await fixture();
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller-a' });
  const from = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });

  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
  }, { actorId: 'seller-a' });
  await market.createOrder({ offerId: offer.id, quantity: 2 }, { actorId: 'buyer-a' });
  setNow('2026-09-01T00:02:00.000Z');
  const to = await createFederationCheckpoint({
    market,
    clearinghouseId: CLEARINGHOUSE_ID,
    previousCheckpoint: from,
    clock,
  });
  const ledger = await market.getLedger();
  const events = ledger.slice(from.sequence, to.sequence);

  const verified = verifyFederationExtension({ fromCheckpoint: from, toCheckpoint: to, events });
  assert.equal(verified.eventsVerified, 2);
  assert.equal(verified.headHash, to.headHash);

  assert.throws(
    () => verifyFederationExtension({ fromCheckpoint: from, toCheckpoint: to, events: events.slice(1) }),
    (error) => error.code === 'EXTENSION_LENGTH_MISMATCH',
  );

  const reordered = [events[1], events[0]];
  assert.throws(
    () => verifyFederationExtension({ fromCheckpoint: from, toCheckpoint: to, events: reordered }),
    (error) => error.code === 'EXTENSION_SEQUENCE_MISMATCH',
  );

  const tampered = structuredClone(events);
  tampered[0].data = { ...tampered[0].data, quantity: 999 };
  assert.throws(
    () => verifyFederationExtension({ fromCheckpoint: from, toCheckpoint: to, events: tampered }),
    (error) => error.code === 'EXTENSION_EVENT_HASH_MISMATCH',
  );
});

test('empty extension is valid only for an unchanged directly chained ledger head', async () => {
  const { market, clock, setNow } = await fixture();
  const from = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  setNow('2026-09-01T00:01:00.000Z');
  const to = await createFederationCheckpoint({
    market,
    clearinghouseId: CLEARINGHOUSE_ID,
    previousCheckpoint: from,
    clock,
  });
  const result = verifyFederationExtension({ fromCheckpoint: from, toCheckpoint: to, events: [] });
  assert.equal(result.eventsVerified, 0);
  assert.equal(result.headHash, 'GENESIS');
});

test('canonical checkpoint normalization makes signature verification independent of property insertion order', async () => {
  const { market, clock } = await fixture();
  const checkpoint = await createFederationCheckpoint({ market, clearinghouseId: CLEARINGHOUSE_ID, clock });
  const keys = keyFixture();
  const envelope = signFederationCheckpoint(checkpoint, keys);
  const reorderedCheckpoint = {
    checkpointHash: checkpoint.checkpointHash,
    previousCheckpointHash: checkpoint.previousCheckpointHash,
    generatedAt: checkpoint.generatedAt,
    headHash: checkpoint.headHash,
    sequence: checkpoint.sequence,
    revision: checkpoint.revision,
    clearinghouseId: checkpoint.clearinghouseId,
    schema: checkpoint.schema,
  };
  const verified = await verifyFederationCheckpoint({ ...envelope, checkpoint: reorderedCheckpoint }, {
    resolvePublicKey: keys.resolver,
  });
  assert.equal(verified.checkpointHash, checkpoint.checkpointHash);
});
