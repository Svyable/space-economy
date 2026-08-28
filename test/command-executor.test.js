import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { SignedCommandExecutor } from '../src/command-executor.js';
import { PolicyGateEngine } from '../src/policy.js';
import { signCommand } from '../src/signed-command.js';

const keys = generateKeyPairSync('ed25519');
const audience = 'urn:space-economy:clearinghouse:test';
const verificationClock = () => new Date('2026-08-26T22:00:30.000Z');

const command = (operation, payload, overrides = {}) => signCommand({
  keyId: 'participant:operator-one#key-1',
  actorId: 'operator-one',
  audience,
  operation,
  nonce: `nonce-${operation}`,
  idempotencyKey: `idem-${operation}`,
  expectedVersion: null,
  createdAt: '2026-08-26T22:00:00Z',
  expiresAt: '2026-08-26T22:01:00Z',
  payload,
  ...overrides,
}, { privateKey: keys.privateKey });

const executor = async (market, overrides = {}) => new SignedCommandExecutor({
  market,
  audience,
  clock: verificationClock,
  maxClockSkewSeconds: 0,
  resolvePublicKey: async ({ actorId, keyId }) => (
    actorId === 'operator-one' && keyId === 'participant:operator-one#key-1'
      ? keys.publicKey
      : null
  ),
  ...overrides,
});

test('verified signed command derives actor context and executes only the mapped domain operation', async () => {
  const market = await Clearinghouse.open();
  const runner = await executor(market);
  const envelope = command('asset.register', { name: 'Relay A', type: 'satellite' });

  const execution = await runner.execute(envelope);
  assert.equal(execution.result.ownerId, 'operator-one');
  assert.equal(execution.result.name, 'Relay A');
  assert.match(execution.commandHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await market.listAssets()).length, 1);
  assert.ok(runner.listOperations().includes('asset.register'));
});

test('replaying the same verified envelope is economically idempotent', async () => {
  const market = await Clearinghouse.open();
  const runner = await executor(market);
  const envelope = command('asset.register', { name: 'Relay A', type: 'satellite' });

  const first = await runner.execute(envelope);
  const second = await runner.execute(envelope);
  assert.equal(first.result.id, second.result.id);
  assert.equal((await market.listAssets()).length, 1);
  assert.equal(await market.getRevision(), 1);
});

test('unsupported operations are rejected after signature verification without reflective dispatch', async () => {
  const market = await Clearinghouse.open();
  const runner = await executor(market);
  const envelope = command('constructor', { arbitrary: true });

  await assert.rejects(
    runner.execute(envelope),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
  assert.equal(await market.getRevision(), 0);
});

test('tampered signed commands fail before policy or domain execution', async () => {
  const market = await Clearinghouse.open();
  let policyCalls = 0;
  const policyEngine = {
    async requireAllowed() {
      policyCalls += 1;
      return { decision: 'allow' };
    },
  };
  const runner = await executor(market, { policyEngine });
  const envelope = command('asset.register', { name: 'Relay A', type: 'satellite' });
  envelope.payload.name = 'Tampered';

  await assert.rejects(
    runner.execute(envelope),
    (error) => error.code === 'INVALID_SIGNATURE',
  );
  assert.equal(policyCalls, 0);
  assert.equal(await market.getRevision(), 0);
});

test('policy deny blocks the clearinghouse mutation and preserves revision', async () => {
  const market = await Clearinghouse.open();
  const policyEngine = new PolicyGateEngine({ clock: verificationClock });
  policyEngine.register('operator-status', {
    version: '1',
    async evaluate({ actor }) {
      assert.equal(actor.actorId, 'operator-one');
      assert.equal(actor.keyId, 'participant:operator-one#key-1');
      assert.match(actor.commandHash, /^sha256:/);
      return { decision: 'deny', reason: 'operator suspended' };
    },
  });
  const runner = await executor(market, { policyEngine });

  await assert.rejects(
    runner.execute(command('asset.register', { name: 'Relay A', type: 'satellite' })),
    (error) => error.code === 'POLICY_NOT_ALLOWED' && error.details.decision === 'deny',
  );
  assert.equal(await market.getRevision(), 0);
  assert.deepEqual(await market.listAssets(), []);
});

test('allowed policy evaluation is returned as an attributable execution artifact', async () => {
  const market = await Clearinghouse.open();
  const policyEngine = new PolicyGateEngine({ clock: verificationClock });
  policyEngine.register('operator-status', {
    version: '1',
    evaluate: async () => ({ decision: 'allow', reason: 'operator active' }),
  });
  const runner = await executor(market, { policyEngine });
  const execution = await runner.execute(
    command('asset.register', { name: 'Relay A', type: 'satellite' }),
    { policyContext: { deployment: 'test' } },
  );

  assert.equal(execution.policy.decision, 'allow');
  assert.match(execution.policy.evaluationHash, /^sha256:/);
  assert.equal(execution.result.ownerId, 'operator-one');
});

test('order action handlers extract orderId but keep signed optimistic context intact', async () => {
  const market = await Clearinghouse.open();
  const sellerRunner = await executor(market);
  const assetExecution = await sellerRunner.execute(command('asset.register', { name: 'Relay', type: 'satellite' }));
  const offerExecution = await sellerRunner.execute(command('offer.create', {
    assetId: assetExecution.result.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
  }, { nonce: 'offer-nonce', idempotencyKey: 'offer-idem' }));

  const buyerKeys = generateKeyPairSync('ed25519');
  const buyerExecutor = new SignedCommandExecutor({
    market,
    audience,
    clock: verificationClock,
    maxClockSkewSeconds: 0,
    resolvePublicKey: async () => buyerKeys.publicKey,
  });
  const buyerCommand = (operation, payload, extra = {}) => signCommand({
    keyId: 'participant:buyer#key-1',
    actorId: 'buyer',
    audience,
    operation,
    nonce: `buyer-${operation}`,
    idempotencyKey: `buyer-${operation}`,
    expectedVersion: null,
    createdAt: '2026-08-26T22:00:00Z',
    expiresAt: '2026-08-26T22:01:00Z',
    payload,
    ...extra,
  }, { privateKey: buyerKeys.privateKey });

  const reserved = await buyerExecutor.execute(buyerCommand('order.reserve', {
    offerId: offerExecution.result.id,
    quantity: 2,
  }));
  const funded = await buyerExecutor.execute(buyerCommand('order.fund', {
    orderId: reserved.result.id,
    amount: '20',
    reference: 'funding:001',
  }, {
    nonce: 'buyer-fund-unique',
    idempotencyKey: 'buyer-fund-unique',
    expectedVersion: reserved.result.version,
  }));

  assert.equal(funded.result.status, 'funded');
  assert.equal(funded.result.funding.reference, 'funding:001');
});

test('signed expiry command follows the schema-v2 reservation deadline and restores capacity', async () => {
  let now = new Date('2026-08-26T22:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(now) });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller' });
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
    reservationTtlSeconds: 30,
  }, { actorId: 'seller' });
  const order = await market.createOrder({ offerId: offer.id, quantity: 4 }, { actorId: 'buyer' });
  assert.equal((await market.listOffers())[0].remaining, 6);

  now = new Date('2026-08-26T22:00:31.000Z');
  const runner = await executor(market);
  const execution = await runner.execute(command('order.expire', { orderId: order.id }, {
    nonce: 'expire-order-unique',
    idempotencyKey: 'expire-order-unique',
    expectedVersion: order.version,
  }));

  assert.equal(execution.result.status, 'expired');
  assert.equal(execution.result.expiration.triggeredBy, 'operator-one');
  assert.equal((await market.listOffers())[0].remaining, 10);
  assert.ok(runner.listOperations().includes('order.expire'));
});
