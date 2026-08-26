import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';

function fixture(options = {}) {
  const market = new Clearinghouse(options);
  const asset = market.registerAsset({
    owner: 'orbital-relay-co',
    name: 'Relay-7',
    type: 'communications-satellite',
    capabilities: ['data-relay'],
    location: { orbit: 'LEO', inclinationDeg: 51.6 },
  });
  const offer = market.createOffer({
    assetId: asset.id,
    seller: asset.owner,
    service: 'data-relay',
    unit: 'GB',
    pricePerUnit: 12.5,
    currency: 'USD',
    capacity: 100,
  });
  return { market, asset, offer };
}

test('settles a capacity-backed service and preserves a valid audit chain', () => {
  const { market, offer } = fixture();
  const order = market.createOrder({ offerId: offer.id, buyer: 'lunar-imaging-inc', quantity: 8 });
  assert.equal(order.total, 100);
  assert.equal(order.status, 'reserved');

  market.fundOrder(order.id, { buyer: 'lunar-imaging-inc', amount: 100 });
  market.recordDelivery(order.id, {
    seller: 'orbital-relay-co',
    proof: { packetReceipt: 'sha256:example', deliveredQuantity: 8 },
  });
  const settled = market.settleOrder(order.id, { buyer: 'lunar-imaging-inc' });

  assert.equal(settled.status, 'settled');
  assert.equal(settled.settlement.to, 'orbital-relay-co');
  assert.equal(market.listOffers()[0].remaining, 92);
  assert.equal(market.getLedger().length, 6);
  assert.equal(market.verifyLedger(), true);
});

test('prevents oversubscription of scarce physical capacity', () => {
  const { market, offer } = fixture();
  market.createOrder({ offerId: offer.id, buyer: 'buyer-a', quantity: 90 });
  assert.throws(
    () => market.createOrder({ offerId: offer.id, buyer: 'buyer-b', quantity: 11 }),
    (error) => error.code === 'INSUFFICIENT_CAPACITY',
  );
});

test('enforces party authorization across funding and delivery', () => {
  const { market, offer } = fixture();
  const order = market.createOrder({ offerId: offer.id, buyer: 'buyer-a', quantity: 1 });
  assert.throws(
    () => market.fundOrder(order.id, { buyer: 'buyer-b', amount: 12.5 }),
    (error) => error.code === 'FORBIDDEN',
  );
  market.fundOrder(order.id, { buyer: 'buyer-a', amount: 12.5 });
  assert.throws(
    () => market.recordDelivery(order.id, { seller: 'impostor', proof: { ok: true } }),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('persists state and validates ledger integrity on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-economy-'));
  const statePath = path.join(dir, 'state.json');
  const { market } = fixture({ statePath });
  assert.equal(market.verifyLedger(), true);

  const restored = new Clearinghouse({ statePath });
  assert.equal(restored.listAssets().length, 1);
  assert.equal(restored.listOffers().length, 1);
  assert.equal(restored.verifyLedger(), true);
});
