import { Clearinghouse } from '../src/clearinghouse.js';

const market = new Clearinghouse();

const satellite = market.registerAsset({
  owner: 'relay-one',
  name: 'Relay One A',
  type: 'communications-satellite',
  capabilities: ['data-relay'],
  location: { orbit: 'LEO' },
});

const capacity = market.createOffer({
  assetId: satellite.id,
  seller: 'relay-one',
  service: 'data-relay',
  unit: 'GB',
  pricePerUnit: 15,
  currency: 'USD',
  capacity: 500,
});

const order = market.createOrder({
  offerId: capacity.id,
  buyer: 'lunar-mapper',
  quantity: 20,
});

market.fundOrder(order.id, { buyer: 'lunar-mapper', amount: 300 });
market.recordDelivery(order.id, {
  seller: 'relay-one',
  proof: {
    receipt: 'telemetry-receipt-001',
    deliveredQuantity: 20,
    unit: 'GB',
  },
});
const settled = market.settleOrder(order.id, { buyer: 'lunar-mapper' });

console.log(JSON.stringify({
  asset: satellite,
  offer: market.listOffers()[0],
  order: settled,
  ledgerValid: market.verifyLedger(),
  ledgerEntries: market.getLedger().length,
}, null, 2));
