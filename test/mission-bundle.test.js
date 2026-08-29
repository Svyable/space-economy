import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse, DomainError } from '../src/clearinghouse.js';
import { MissionBundleCoordinator } from '../src/mission-bundle.js';
import { MemorySnapshotStore } from '../src/store.js';

async function createOffer(market, seller, { capacity = 10, service = 'service', amount = '100' } = {}) {
  const asset = await market.registerAsset(
    { name: `${seller}-${service}`, type: 'space-infrastructure' },
    { actorId: seller },
  );
  return market.createOffer({
    assetId: asset.id,
    service,
    unit: 'unit',
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale: 2 },
    capacity,
  }, { actorId: seller });
}

test('reserves a three-leg mission as ordinary clearinghouse orders', async () => {
  const market = await Clearinghouse.open();
  const launch = await createOffer(market, 'launch-provider', { service: 'launch' });
  const transfer = await createOffer(market, 'transfer-provider', { service: 'orbital-transfer' });
  const relay = await createOffer(market, 'relay-provider', { service: 'data-relay' });
  const coordinator = await MissionBundleCoordinator.open({ market });

  const bundle = await coordinator.createBundle({
    name: 'Mission A',
    legs: [
      { legId: 'launch', offerId: launch.id, quantity: 2 },
      { legId: 'transfer', offerId: transfer.id, quantity: 3 },
      { legId: 'relay', offerId: relay.id, quantity: 4 },
    ],
  }, { actorId: 'mission-buyer', idempotencyKey: 'bundle-1' });

  const execution = await coordinator.executeBundle(bundle.id, { actorId: 'mission-buyer' });
  assert.equal(execution.bundle.status, 'reserved');
  assert.deepEqual(execution.bundle.legs.map((leg) => leg.status), ['reserved', 'reserved', 'reserved']);
  assert.equal(execution.orders.length, 3);
  assert.ok(execution.orders.every((order) => order.status === 'reserved'));
  assert.deepEqual((await market.listOffers({ status: null })).map((offer) => offer.remaining), [8, 7, 6]);
});

test('later-leg failure compensates earlier unfunded reservations in reverse', async () => {
  const market = await Clearinghouse.open();
  const launch = await createOffer(market, 'launch-provider', { service: 'launch', capacity: 5 });
  const relay = await createOffer(market, 'relay-provider', { service: 'relay', capacity: 1 });
  const coordinator = await MissionBundleCoordinator.open({ market });
  const bundle = await coordinator.createBundle({
    legs: [
      { legId: 'launch', offerId: launch.id, quantity: 3 },
      { legId: 'relay', offerId: relay.id, quantity: 2 },
    ],
  }, { actorId: 'buyer' });

  const execution = await coordinator.executeBundle(bundle.id, { actorId: 'buyer' });
  assert.equal(execution.bundle.status, 'compensated');
  assert.equal(execution.bundle.legs[0].status, 'compensated');
  assert.equal(execution.bundle.legs[1].status, 'failed');
  assert.equal(execution.bundle.failure.code, 'INSUFFICIENT_CAPACITY');
  const launchOrder = execution.orders.find((order) => order.offerId === launch.id);
  assert.equal(launchOrder.status, 'cancelled');
  const offers = await market.listOffers({ status: null });
  assert.equal(offers.find((offer) => offer.id === launch.id).remaining, 5);
  assert.equal(offers.find((offer) => offer.id === relay.id).remaining, 1);
});

test('replaying a successful bundle does not reserve capacity twice', async () => {
  const market = await Clearinghouse.open();
  const first = await createOffer(market, 'seller-1', { service: 'first', capacity: 5 });
  const second = await createOffer(market, 'seller-2', { service: 'second', capacity: 5 });
  const coordinator = await MissionBundleCoordinator.open({ market });
  const bundle = await coordinator.createBundle({
    legs: [
      { offerId: first.id, quantity: 2 },
      { offerId: second.id, quantity: 3 },
    ],
  }, { actorId: 'buyer' });

  const one = await coordinator.executeBundle(bundle.id, { actorId: 'buyer' });
  const two = await coordinator.executeBundle(bundle.id, { actorId: 'buyer' });
  assert.deepEqual(one.orders.map((order) => order.id), two.orders.map((order) => order.id));
  const offers = await market.listOffers({ status: null });
  assert.equal(offers.find((offer) => offer.id === first.id).remaining, 3);
  assert.equal(offers.find((offer) => offer.id === second.id).remaining, 2);
});

test('funded earlier leg blocks automatic compensation and requires attention', async () => {
  const market = await Clearinghouse.open();
  const first = await createOffer(market, 'seller-1', { service: 'first', capacity: 5, amount: '250' });
  const second = await createOffer(market, 'seller-2', { service: 'second', capacity: 1 });
  let firstOrder = null;
  let createCalls = 0;
  const wrappedMarket = {
    createOrder: async (...args) => {
      createCalls += 1;
      if (createCalls === 1) {
        firstOrder = await market.createOrder(...args);
        return firstOrder;
      }
      await market.fundOrder(firstOrder.id, {
        amount: firstOrder.total.amount,
        reference: 'funding:bundle-leg-1',
      }, { actorId: 'buyer' });
      throw new DomainError('INSUFFICIENT_CAPACITY', 'synthetic second-leg capacity failure');
    },
    getOrder: (...args) => market.getOrder(...args),
    cancelOrder: (...args) => market.cancelOrder(...args),
  };
  const coordinator = await MissionBundleCoordinator.open({ market: wrappedMarket });
  const bundle = await coordinator.createBundle({
    legs: [
      { legId: 'first', offerId: first.id, quantity: 2 },
      { legId: 'second', offerId: second.id, quantity: 2 },
    ],
  }, { actorId: 'buyer' });

  const execution = await coordinator.executeBundle(bundle.id, { actorId: 'buyer' });
  assert.equal(execution.bundle.status, 'attention-required');
  assert.equal(execution.bundle.failure.code, 'NON_COMPENSATABLE_ORDER');
  assert.equal((await market.getOrder(firstOrder.id)).status, 'funded');
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === first.id).remaining, 3);
});

test('compensation can resume after restart even when planning expiry has passed', async () => {
  let now = new Date('2026-08-29T16:00:00.000Z');
  const market = await Clearinghouse.open();
  const first = await createOffer(market, 'seller-1', { service: 'first', capacity: 5 });
  const second = await createOffer(market, 'seller-2', { service: 'second', capacity: 1 });
  const bundleStore = new MemorySnapshotStore();
  let cancelFailures = 1;
  const wrappedMarket = {
    createOrder: (...args) => market.createOrder(...args),
    getOrder: (...args) => market.getOrder(...args),
    cancelOrder: async (...args) => {
      if (cancelFailures > 0) {
        cancelFailures -= 1;
        throw new Error('temporary cancellation transport failure');
      }
      return market.cancelOrder(...args);
    },
  };
  const coordinator = await MissionBundleCoordinator.open({
    market: wrappedMarket,
    store: bundleStore,
    clock: () => new Date(now),
  });
  const bundle = await coordinator.createBundle({
    expiresAt: '2026-08-29T16:01:00.000Z',
    legs: [
      { offerId: first.id, quantity: 2 },
      { offerId: second.id, quantity: 2 },
    ],
  }, { actorId: 'buyer' });

  await assert.rejects(
    coordinator.executeBundle(bundle.id, { actorId: 'buyer' }),
    /temporary cancellation transport failure/,
  );
  assert.equal((await coordinator.getBundle(bundle.id)).status, 'compensating');

  now = new Date('2026-08-29T16:02:00.000Z');
  const restarted = await MissionBundleCoordinator.open({
    market: wrappedMarket,
    store: bundleStore,
    clock: () => new Date(now),
  });
  const execution = await restarted.executeBundle(bundle.id, { actorId: 'buyer' });
  assert.equal(execution.bundle.status, 'compensated');
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === first.id).remaining, 5);
});

test('expired planned bundle cannot begin reserving', async () => {
  let now = new Date('2026-08-29T16:00:00.000Z');
  const market = await Clearinghouse.open();
  const first = await createOffer(market, 'seller-1', { service: 'first' });
  const second = await createOffer(market, 'seller-2', { service: 'second' });
  const coordinator = await MissionBundleCoordinator.open({ market, clock: () => new Date(now) });
  const bundle = await coordinator.createBundle({
    expiresAt: '2026-08-29T16:01:00.000Z',
    legs: [{ offerId: first.id, quantity: 1 }, { offerId: second.id, quantity: 1 }],
  }, { actorId: 'buyer' });
  now = new Date('2026-08-29T16:02:00.000Z');
  await assert.rejects(
    coordinator.executeBundle(bundle.id, { actorId: 'buyer' }),
    (error) => error.code === 'BUNDLE_EXPIRED',
  );
  assert.equal((await market.listOffers({ status: null })).every((offer) => offer.remaining === offer.capacity), true);
});

test('bundle state and create idempotency survive restart', async () => {
  const market = await Clearinghouse.open();
  const first = await createOffer(market, 'seller-1', { service: 'first' });
  const second = await createOffer(market, 'seller-2', { service: 'second' });
  const store = new MemorySnapshotStore();
  const coordinator = await MissionBundleCoordinator.open({ market, store });
  const input = { legs: [{ offerId: first.id, quantity: 1 }, { offerId: second.id, quantity: 1 }] };
  const created = await coordinator.createBundle(input, { actorId: 'buyer', idempotencyKey: 'create-bundle' });

  const restarted = await MissionBundleCoordinator.open({ market, store });
  const replay = await restarted.createBundle(input, { actorId: 'buyer', idempotencyKey: 'create-bundle' });
  assert.equal(replay.id, created.id);
  await assert.rejects(
    restarted.createBundle({ ...input, name: 'different' }, { actorId: 'buyer', idempotencyKey: 'create-bundle' }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});
