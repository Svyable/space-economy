import assert from 'node:assert/strict';
import test from 'node:test';
import { ProofVerifierRegistry, createExactQuantityReceiptVerifier } from '../src/proofs.js';

const order = {
  id: 'order-1',
  quantity: 8,
  unit: 'MB',
  service: 'data-relay',
  buyerId: 'buyer',
  sellerId: 'seller',
};

const fixedClock = () => new Date('2026-08-26T20:00:00.000Z');

test('verifies a typed proof and emits a deterministic attributable attestation', async () => {
  const registry = new ProofVerifierRegistry({ clock: fixedClock });
  registry.register('quantity-receipt/v1', createExactQuantityReceiptVerifier());

  const result = await registry.verify({
    order,
    proof: { type: 'quantity-receipt/v1', data: { unit: 'MB', deliveredQuantity: 8 } },
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.verifierId, 'spaceeconomy:reference:exact-quantity');
  assert.equal(result.profileVersion, '1');
  assert.equal(result.proofType, 'quantity-receipt/v1');
  assert.equal(result.verifiedAt, '2026-08-26T20:00:00.000Z');
  assert.match(result.proofHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.attestationHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.claims, { deliveredQuantity: 8, unit: 'MB' });
});

test('canonical proof digest is independent of JSON property insertion order', async () => {
  const registry = new ProofVerifierRegistry({ clock: fixedClock });
  registry.register('quantity-receipt/v1', createExactQuantityReceiptVerifier());

  const left = await registry.verify({
    order,
    proof: { type: 'quantity-receipt/v1', data: { unit: 'MB', deliveredQuantity: 8 } },
  });
  const right = await registry.verify({
    order,
    proof: { data: { deliveredQuantity: 8, unit: 'MB' }, type: 'quantity-receipt/v1' },
  });

  assert.equal(left.proofHash, right.proofHash);
  assert.equal(left.attestationHash, right.attestationHash);
});

test('reference verifier rejects quantity or unit mismatch without throwing', async () => {
  const registry = new ProofVerifierRegistry({ clock: fixedClock });
  registry.register('quantity-receipt/v1', createExactQuantityReceiptVerifier());

  const result = await registry.verify({
    order,
    proof: { type: 'quantity-receipt/v1', data: { unit: 'GB', deliveredQuantity: 7 } },
  });

  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /does not match/);
});

test('unknown proof types fail closed', async () => {
  const registry = new ProofVerifierRegistry({ clock: fixedClock });
  await assert.rejects(
    registry.verify({ order, proof: { type: 'unknown/v1', data: {} } }),
    (error) => error.code === 'UNSUPPORTED_PROOF_TYPE',
  );
});

test('verifier results must be attributable and use a closed status vocabulary', async () => {
  const registry = new ProofVerifierRegistry({ clock: fixedClock });
  registry.register('bad/v1', async () => ({ status: 'maybe', verifierId: 'x', profileVersion: '1' }));
  await assert.rejects(
    registry.verify({ order, proof: { type: 'bad/v1', data: {} } }),
    (error) => error.code === 'INVALID_VERIFIER_RESULT',
  );
});

test('registry prevents silent replacement of an existing proof profile', () => {
  const registry = new ProofVerifierRegistry();
  registry.register('quantity-receipt/v1', createExactQuantityReceiptVerifier());
  assert.throws(
    () => registry.register('quantity-receipt/v1', createExactQuantityReceiptVerifier()),
    (error) => error.code === 'VERIFIER_EXISTS',
  );
});
