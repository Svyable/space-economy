import assert from 'node:assert/strict';
import test from 'node:test';
import { SettlementAdapterRegistry } from '../src/settlement.js';

const order = {
  id: 'order-1',
  buyerId: 'buyer',
  sellerId: 'seller',
  total: { settlementAsset: 'iso4217:USD', amount: '10000', scale: 2 },
};

const fixedClock = () => new Date('2026-08-26T21:00:00.000Z');

function adapter(overrides = {}) {
  return {
    adapterId: 'example:usd-sandbox',
    adapterVersion: '1',
    async fund({ amount, idempotencyKey }) {
      assert.deepEqual(amount, order.total);
      assert.equal(idempotencyKey, 'fund-1');
      return { status: 'confirmed', reference: 'funding:001' };
    },
    async settle({ amount, fundingReference, idempotencyKey }) {
      assert.deepEqual(amount, order.total);
      assert.equal(fundingReference, 'funding:001');
      assert.equal(idempotencyKey, 'settle-1');
      return { status: 'confirmed', reference: 'settlement:001' };
    },
    ...overrides,
  };
}

test('normalizes attributable funding and settlement receipts', async () => {
  const registry = new SettlementAdapterRegistry({ clock: fixedClock });
  registry.register('iso4217:USD', adapter());

  const funding = await registry.fund({ order, idempotencyKey: 'fund-1' });
  assert.equal(funding.operation, 'fund');
  assert.equal(funding.status, 'confirmed');
  assert.equal(funding.adapterId, 'example:usd-sandbox');
  assert.equal(funding.occurredAt, '2026-08-26T21:00:00.000Z');
  assert.match(funding.receiptHash, /^sha256:[0-9a-f]{64}$/);

  const settlement = await registry.settle({
    order,
    fundingReference: funding.reference,
    idempotencyKey: 'settle-1',
  });
  assert.equal(settlement.operation, 'settle');
  assert.equal(settlement.reference, 'settlement:001');
  assert.deepEqual(settlement.amount, order.total);
  assert.match(settlement.receiptHash, /^sha256:[0-9a-f]{64}$/);
});

test('requires idempotency keys for every side-effecting rail operation', async () => {
  const registry = new SettlementAdapterRegistry({ clock: fixedClock });
  registry.register('iso4217:USD', adapter());
  await assert.rejects(
    registry.fund({ order }),
    (error) => error.code === 'INVALID_SETTLEMENT_REQUEST',
  );
});

test('fails closed for unsupported settlement assets', async () => {
  const registry = new SettlementAdapterRegistry({ clock: fixedClock });
  await assert.rejects(
    registry.fund({ order, idempotencyKey: 'fund-1' }),
    (error) => error.code === 'UNSUPPORTED_SETTLEMENT_ASSET',
  );
});

test('accepts pending and rejected receipts without pretending they completed', async () => {
  const pendingRegistry = new SettlementAdapterRegistry({ clock: fixedClock });
  pendingRegistry.register('iso4217:USD', adapter({
    async fund() { return { status: 'pending', reference: 'funding:pending' }; },
  }));
  const pending = await pendingRegistry.fund({ order, idempotencyKey: 'fund-1' });
  assert.equal(pending.status, 'pending');

  const rejectedRegistry = new SettlementAdapterRegistry({ clock: fixedClock });
  rejectedRegistry.register('iso4217:USD', adapter({
    async fund() { return { status: 'rejected', reference: 'funding:rejected', reason: 'risk policy' }; },
  }));
  const rejected = await rejectedRegistry.fund({ order, idempotencyKey: 'fund-1' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'risk policy');
});

test('refunds are capability-gated rather than assumed', async () => {
  const registry = new SettlementAdapterRegistry({ clock: fixedClock });
  registry.register('iso4217:USD', adapter());
  await assert.rejects(
    registry.refund({ order, settlementReference: 'settlement:001', idempotencyKey: 'refund-1' }),
    (error) => error.code === 'REFUND_UNSUPPORTED',
  );

  const refundable = new SettlementAdapterRegistry({ clock: fixedClock });
  refundable.register('iso4217:USD', adapter({
    async refund({ settlementReference, idempotencyKey }) {
      assert.equal(settlementReference, 'settlement:001');
      assert.equal(idempotencyKey, 'refund-1');
      return { status: 'confirmed', reference: 'refund:001' };
    },
  }));
  const receipt = await refundable.refund({ order, settlementReference: 'settlement:001', idempotencyKey: 'refund-1' });
  assert.equal(receipt.operation, 'refund');
  assert.equal(receipt.reference, 'refund:001');
});

test('registry prevents silent replacement of a settlement rail', () => {
  const registry = new SettlementAdapterRegistry();
  registry.register('iso4217:USD', adapter());
  assert.throws(
    () => registry.register('iso4217:USD', adapter()),
    (error) => error.code === 'ADAPTER_EXISTS',
  );
});
