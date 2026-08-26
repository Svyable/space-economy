import { Clearinghouse } from '../src/clearinghouse.js';

const market = new Clearinghouse();
const ctx = (actorId, idempotencyKey) => ({ actorId, idempotencyKey });

const asset = market.registerAsset({
  name: 'Relay One A',
  type: 'communications-satellite',
  capabilities: ['data-relay'],
  identifiers: [{ scheme: 'cospar', value: '2026-001A' }],
  location: { orbit: 'LEO' },
}, ctx('relay-one', 'asset-1'));

const offer = market.createOffer({
  assetId: asset.id,
  service: 'data-relay',
  unit: 'MB',
  unitPrice: { settlementAsset: 'iso4217:USD', amount: '15', scale: 2 },
  capacity: 500_000,
}, ctx('relay-one', 'offer-1'));

const order = market.createOrder({ offerId: offer.id, quantity: 20_000 }, ctx('lunar-mapper', 'order-1'));
market.fundOrder(order.id, { amount: order.total.amount, reference: 'sandbox:funding:001' }, ctx('lunar-mapper', 'fund-1'));
market.recordDelivery(order.id, {
  proof: {
    type: 'telemetry-receipt',
    data: { receipt: 'telemetry-receipt-001', deliveredQuantity: 20_000 },
  },
}, ctx('relay-one', 'delivery-1'));
const settled = market.settleOrder(order.id, { reference: 'sandbox:settlement:001' }, ctx('lunar-mapper', 'settle-1'));

console.log(JSON.stringify({ asset, offer, settled, ledgerValid: market.verifyLedger() }, null, 2));
