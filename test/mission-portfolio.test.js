import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MissionPortfolioCoordinator } from '../src/mission-portfolio.js';
import { MemorySnapshotStore } from '../src/store.js';

const ctx = (actorId, extra = {}) => ({ actorId, ...extra });

function trustedAcquirer(market, sellersByOffer) {
  return {
    async acquireCapacityRight({ terms, buyerId, idempotencyKey }) {
      const sellerId = sellersByOffer.get(terms.offerId);
      if (!sellerId) throw Object.assign(new Error('offer is not authorized for acquisition'), { code: 'NOT_FOUND' });
      return market.createCapacityRight({ ...terms, holderId: buyerId }, { actorId: sellerId, idempotencyKey });
    },
  };
}

async function reservedOrderCount(market) {
  return (await market.getLedger()).filter((entry) => entry.type === 'spaceeconomy.order.reserved.v1').length;
}

async function fixture({ coordinatorStore = new MemorySnapshotStore(), coordinatorIdPrefix = 'portfolio' } = {}) {
  let id = 0;
  const market = await Clearinghouse.open({
    clock: () => new Date('2026-09-01T00:00:00Z'),
    idGenerator: () => `id-${++id}`,
  });
  const assetA = await market.registerAsset({ name: 'Launch', type: 'launch', capabilities: ['launch'] }, ctx('seller-a'));
  const assetB = await market.registerAsset({ name: 'Relay', type: 'relay', capabilities: ['relay'] }, ctx('seller-b'));
  const offerA = await market.createOffer({
    assetId: assetA.id,
    service: 'launch',
    unit: 'kg',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '100', scale: 2 },
    capacity: 10,
    windowStart: '2026-09-02T00:00:00Z',
    windowEnd: '2026-09-03T00:00:00Z',
  }, ctx('seller-a'));
  const offerB = await market.createOffer({
    assetId: assetB.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    capacity: 20,
    windowStart: '2026-09-02T00:00:00Z',
    windowEnd: '2026-09-03T00:00:00Z',
  }, ctx('seller-b'));
  const sellersByOffer = new Map([[offerA.id, 'seller-a'], [offerB.id, 'seller-b']]);
  const acquirer = trustedAcquirer(market, sellersByOffer);
  let portfolioId = 0;
  const coordinator = await MissionPortfolioCoordinator.open({
    market,
    capacityRightAcquirer: acquirer,
    store: coordinatorStore,
    idGenerator: () => `${coordinatorIdPrefix}-${++portfolioId}`,
    clock: () => new Date('2026-09-01T00:00:00Z'),
  });
  return { market, coordinator, coordinatorStore, offerA, offerB, sellersByOffer, acquirer };
}

function legs(offerA, offerB, overrideB = {}) {
  return [
    {
      legId: 'launch',
      offerId: offerA.id,
      quantity: 5,
      exerciseUnitPrice: offerA.unitPrice,
      expiresAt: '2026-09-01T01:00:00Z',
      stage: 1,
    },
    {
      legId: 'relay',
      offerId: offerB.id,
      quantity: 10,
      exerciseUnitPrice: offerB.unitPrice,
      expiresAt: '2026-09-01T01:00:00Z',
      stage: 2,
      ...overrideB,
    },
  ];
}

test('secures every physical leg before exercising any order', async () => {
  const { market, coordinator, offerA, offerB } = await fixture();
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB) }, ctx('buyer'));
  const secured = await coordinator.acquirePortfolio(created.id, ctx('buyer'));

  assert.equal(secured.status, 'secured');
  assert.ok(secured.legs.every((leg) => leg.status === 'held' && leg.rightId && leg.termsHash));
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerA.id).remaining, 5);
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerB.id).remaining, 10);
  assert.equal(await reservedOrderCount(market), 0);

  const stage1 = await coordinator.exerciseStage(created.id, 1, ctx('buyer'));
  assert.equal(stage1.status, 'exercising');
  assert.equal(stage1.legs.find((leg) => leg.legId === 'launch').status, 'exercised');
  assert.equal(stage1.legs.find((leg) => leg.legId === 'relay').status, 'held');
  assert.equal(await reservedOrderCount(market), 1);

  const active = await coordinator.exerciseStage(created.id, 2, ctx('buyer'));
  assert.equal(active.status, 'active');
  assert.equal(await reservedOrderCount(market), 2);
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerA.id).remaining, 5);
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerB.id).remaining, 10);
});

test('later acquisition failure unwinds earlier held inventory before any order exists', async () => {
  const { market, coordinator, offerA, offerB } = await fixture();
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB, { quantity: 21 }) }, ctx('buyer'));
  const result = await coordinator.acquirePortfolio(created.id, ctx('buyer'));

  assert.equal(result.status, 'unwound');
  assert.equal(result.legs.find((leg) => leg.legId === 'launch').status, 'released');
  assert.equal(result.legs.find((leg) => leg.legId === 'relay').status, 'failed');
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerA.id).remaining, 10);
  assert.equal(await reservedOrderCount(market), 0);
});

test('stage ordering prevents downstream execution before dependencies', async () => {
  const { coordinator, offerA, offerB } = await fixture();
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB) }, ctx('buyer'));
  await coordinator.acquirePortfolio(created.id, ctx('buyer'));

  await assert.rejects(
    coordinator.exerciseStage(created.id, 2, ctx('buyer')),
    (error) => error.code === 'CONFLICT',
  );
});

test('transferring a secured right away fails closed instead of exercising foreign inventory', async () => {
  const { market, coordinator, offerA, offerB } = await fixture();
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB) }, ctx('buyer'));
  const secured = await coordinator.acquirePortfolio(created.id, ctx('buyer'));
  const launch = secured.legs.find((leg) => leg.legId === 'launch');
  const right = await market.getCapacityRight(launch.rightId, ctx('buyer'));
  await market.transferCapacityRight(right.id, { toHolderId: 'other-buyer' }, ctx('buyer', { expectedVersion: right.version }));

  const result = await coordinator.exerciseStage(created.id, 1, ctx('buyer'));
  assert.equal(result.status, 'attention-required');
  assert.equal(result.failure.code, 'RIGHT_NOT_EXERCISABLE');
  assert.equal(await reservedOrderCount(market), 0);
});

test('trusted acquisition capability, not buyer input, supplies seller authorization', async () => {
  const { market, offerA, offerB } = await fixture();
  const rejectingAcquirer = {
    async acquireCapacityRight() {
      throw Object.assign(new Error('seller authorization absent'), { code: 'FORBIDDEN' });
    },
  };
  const coordinator = await MissionPortfolioCoordinator.open({ market, capacityRightAcquirer: rejectingAcquirer });
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB) }, ctx('buyer'));

  await assert.rejects(
    coordinator.acquirePortfolio(created.id, ctx('buyer')),
    (error) => error.code === 'FORBIDDEN',
  );
  assert.equal((await market.listCapacityRights(ctx('buyer'))).length, 0);
});

class FailOnSaveStore {
  constructor(base, failOnSaveNumber) {
    this.base = base;
    this.failOnSaveNumber = failOnSaveNumber;
    this.saveCount = 0;
  }
  load() { return this.base.load(); }
  async save(snapshot, options) {
    this.saveCount += 1;
    if (this.saveCount === this.failOnSaveNumber) throw new Error('coordinator persistence unavailable');
    return this.base.save(snapshot, options);
  }
}

test('restart after kernel acquisition but before coordinator checkpoint replays the same right', async () => {
  const durableStore = new MemorySnapshotStore();
  const failingStore = new FailOnSaveStore(durableStore, 3);
  const { market, coordinator, offerA, offerB, acquirer } = await fixture({ coordinatorStore: failingStore });
  const created = await coordinator.createPortfolio({ legs: legs(offerA, offerB) }, ctx('buyer'));

  await assert.rejects(coordinator.acquirePortfolio(created.id, ctx('buyer')), /coordinator persistence unavailable/);
  const rightsAfterCrash = await market.listCapacityRights(ctx('buyer'));
  assert.equal(rightsAfterCrash.length, 1);
  assert.equal((await durableStore.load()).portfolios[0].status, 'acquiring');
  assert.equal((await durableStore.load()).portfolios[0].legs[0].status, 'pending');

  const reopened = await MissionPortfolioCoordinator.open({
    market,
    capacityRightAcquirer: acquirer,
    store: durableStore,
    clock: () => new Date('2026-09-01T00:00:00Z'),
  });
  const secured = await reopened.acquirePortfolio(created.id, ctx('buyer'));
  assert.equal(secured.status, 'secured');
  assert.equal((await market.listCapacityRights(ctx('buyer'))).length, 2);
  assert.equal(secured.legs[0].rightId, rightsAfterCrash[0].id);
});

test('competing portfolios cannot both acquire the final physical units', async () => {
  const { market, offerA, offerB, acquirer } = await fixture();
  const left = await MissionPortfolioCoordinator.open({ market, capacityRightAcquirer: acquirer, store: new MemorySnapshotStore(), idGenerator: () => 'left' });
  const right = await MissionPortfolioCoordinator.open({ market, capacityRightAcquirer: acquirer, store: new MemorySnapshotStore(), idGenerator: () => 'right' });
  const scarceLegs = (secondQuantity) => [
    { legId: 'scarce', offerId: offerA.id, quantity: 10, exerciseUnitPrice: offerA.unitPrice, expiresAt: '2026-09-01T01:00:00Z', stage: 1 },
    { legId: 'relay', offerId: offerB.id, quantity: secondQuantity, exerciseUnitPrice: offerB.unitPrice, expiresAt: '2026-09-01T01:00:00Z', stage: 2 },
  ];
  const leftPortfolio = await left.createPortfolio({ legs: scarceLegs(1) }, ctx('buyer-left'));
  const rightPortfolio = await right.createPortfolio({ legs: scarceLegs(1) }, ctx('buyer-right'));

  const [leftResult, rightResult] = await Promise.all([
    left.acquirePortfolio(leftPortfolio.id, ctx('buyer-left')),
    right.acquirePortfolio(rightPortfolio.id, ctx('buyer-right')),
  ]);
  const statuses = [leftResult.status, rightResult.status].sort();
  assert.deepEqual(statuses, ['secured', 'unwound']);
  assert.equal((await market.listOffers({ status: null })).find((offer) => offer.id === offerA.id).remaining, 0);
});

test('partial stage execution becomes attention-required instead of pretending rollback', async () => {
  const coordinatorStore = new MemorySnapshotStore();
  const { market, coordinator, offerA, offerB, acquirer } = await fixture({ coordinatorStore });
  const sameStage = legs(offerA, offerB, { stage: 1 });
  const created = await coordinator.createPortfolio({ legs: sameStage }, ctx('buyer'));
  const secured = await coordinator.acquirePortfolio(created.id, ctx('buyer'));
  const relayRightId = secured.legs.find((leg) => leg.legId === 'relay').rightId;
  const marketFacade = {
    getCapacityRight: (id, context) => market.getCapacityRight(id, context),
    releaseCapacityRight: (id, context) => market.releaseCapacityRight(id, context),
    exerciseCapacityRight: (id, context) => {
      if (id === relayRightId) throw Object.assign(new Error('relay activation unavailable'), { code: 'DOWNSTREAM_UNAVAILABLE' });
      return market.exerciseCapacityRight(id, context);
    },
  };
  const resumed = await MissionPortfolioCoordinator.open({ market: marketFacade, capacityRightAcquirer: acquirer, store: coordinatorStore });

  const result = await resumed.exerciseStage(created.id, 1, ctx('buyer'));
  assert.equal(result.status, 'attention-required');
  assert.equal(result.failure.code, 'DOWNSTREAM_UNAVAILABLE');
  assert.equal(result.legs.filter((leg) => leg.status === 'exercised').length, 1);
  assert.equal(result.legs.filter((leg) => leg.status === 'held').length, 1);
  assert.equal(await reservedOrderCount(market), 1);
});
