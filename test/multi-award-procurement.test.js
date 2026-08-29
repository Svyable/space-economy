import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { MultiAwardProcurementCoordinator } from '../src/multi-award-procurement.js';
import { RfqMarket } from '../src/rfq-market.js';
import { MemorySnapshotStore } from '../src/store.js';

async function fixture() {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const market = await Clearinghouse.open({ clock });
  const rfqMarket = await RfqMarket.open({ market, clock });
  const coordinator = await MultiAwardProcurementCoordinator.open({ rfqMarket, clock });
  return {
    market,
    rfqMarket,
    coordinator,
    clock,
    setNow(value) { now = new Date(value); },
  };
}

async function createOffer(market, sellerId, capacity, amount = '25') {
  const asset = await market.registerAsset({
    name: `${sellerId}-relay`,
    type: 'communications-satellite',
    capabilities: ['data-relay', 'store-and-forward'],
  }, { actorId: sellerId });
  return market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount, scale: 2 },
    capacity,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, { actorId: sellerId });
}

function programInput(overrides = {}) {
  return {
    name: 'Resilient relay procurement',
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    maxUnitPrice: { settlementAsset: 'iso4217:USD', amount: '30', scale: 2 },
    requiredCapabilities: ['data-relay'],
    serviceWindowStart: '2026-09-02T06:00:00.000Z',
    serviceWindowEnd: '2026-09-02T12:00:00.000Z',
    expiresAt: '2026-09-01T01:00:00.000Z',
    lots: [
      { lotId: 'primary', quantity: 30 },
      { lotId: 'secondary', quantity: 20 },
      { lotId: 'reserve', quantity: 10 },
    ],
    ...overrides,
  };
}

test('opens one ordinary RFQ per buyer-defined lot without duplicating demand on retry', async () => {
  const { rfqMarket, coordinator } = await fixture();
  const program = await coordinator.createProgram(programInput(), {
    actorId: 'buyer-a',
    idempotencyKey: 'program-a',
  });

  const opened = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });
  assert.equal(opened.status, 'open');
  assert.equal(opened.awardStatus, 'none');
  assert.equal(opened.totalQuantity, 60);
  assert.equal(opened.awardedQuantity, 0);
  assert.equal(opened.remainingQuantity, 60);
  assert.equal(opened.lots.length, 3);
  assert.deepEqual(opened.lots.map((lot) => lot.rfq.quantity), [30, 20, 10]);
  assert.ok(opened.lots.every((lot) => lot.rfq.buyerId === 'buyer-a'));
  assert.ok(opened.lots.every((lot) => lot.rfq.metadata.procurementProgramId === program.id));
  assert.deepEqual(opened.lots.map((lot) => lot.rfq.metadata.procurementLotId), ['primary', 'secondary', 'reserve']);

  const rfqIds = opened.lots.map((lot) => lot.rfqId);
  const revisionBeforeReplay = await rfqMarket.getRevision();
  const replay = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });
  assert.deepEqual(replay.lots.map((lot) => lot.rfqId), rfqIds);
  assert.equal(await rfqMarket.getRevision(), revisionBeforeReplay);
  assert.equal((await rfqMarket.listRfqs({ status: null })).length, 3);
});

test('different providers can win different lots while total awards stay bounded by the partition', async () => {
  const { market, rfqMarket, coordinator } = await fixture();
  const offers = [
    await createOffer(market, 'seller-a', 30, '20'),
    await createOffer(market, 'seller-b', 20, '22'),
    await createOffer(market, 'seller-c', 10, '24'),
  ];
  const program = await coordinator.createProgram(programInput(), { actorId: 'buyer-a' });
  const opened = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });

  const quotes = [];
  for (let index = 0; index < opened.lots.length; index += 1) {
    quotes.push(await rfqMarket.submitQuote(
      opened.lots[index].rfqId,
      { offerId: offers[index].id },
      { actorId: `seller-${String.fromCharCode(97 + index)}` },
    ));
  }

  const first = await coordinator.acceptLotQuote(program.id, 'primary', quotes[0].id, { actorId: 'buyer-a' });
  assert.equal(first.program.awardStatus, 'partial');
  assert.equal(first.program.awardedQuantity, 30);
  assert.equal(first.program.remainingQuantity, 30);

  await coordinator.acceptLotQuote(program.id, 'secondary', quotes[1].id, { actorId: 'buyer-a' });
  const final = await coordinator.acceptLotQuote(program.id, 'reserve', quotes[2].id, { actorId: 'buyer-a' });
  assert.equal(final.program.status, 'awarded');
  assert.equal(final.program.awardStatus, 'complete');
  assert.equal(final.program.awardedQuantity, 60);
  assert.equal(final.program.remainingQuantity, 0);
  assert.deepEqual(new Set(final.program.lots.map((lot) => lot.award.sellerId)), new Set(['seller-a', 'seller-b', 'seller-c']));
  assert.equal(final.program.lots.reduce((sum, lot) => sum + (lot.award ? lot.quantity : 0), 0), final.program.totalQuantity);

  const remaining = await market.listOffers({ status: null });
  assert.deepEqual(remaining.map((offer) => offer.remaining), [0, 0, 0]);
});

test('a quote cannot be awarded through the wrong procurement lot', async () => {
  const { market, rfqMarket, coordinator } = await fixture();
  const offer = await createOffer(market, 'seller-a', 100);
  const program = await coordinator.createProgram(programInput({
    lots: [{ lotId: 'one', quantity: 5 }, { lotId: 'two', quantity: 5 }],
  }), { actorId: 'buyer-a' });
  const opened = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });
  const quoteOne = await rfqMarket.submitQuote(opened.lots[0].rfqId, { offerId: offer.id }, { actorId: 'seller-a' });
  const quoteTwo = await rfqMarket.submitQuote(opened.lots[1].rfqId, { offerId: offer.id }, { actorId: 'seller-a' });

  await assert.rejects(
    coordinator.acceptLotQuote(program.id, 'one', quoteTwo.id, { actorId: 'buyer-a' }),
    (error) => error.code === 'QUOTE_MISMATCH',
  );
  const accepted = await coordinator.acceptLotQuote(program.id, 'one', quoteOne.id, { actorId: 'buyer-a' });
  assert.equal(accepted.award.order.quantity, 5);
  assert.equal(accepted.program.awardedQuantity, 5);
});

test('opening resumes after a transient child-RFQ failure without duplicating earlier lots', async () => {
  const { market, rfqMarket, clock } = await fixture();
  await createOffer(market, 'seller-a', 100);
  let createCalls = 0;
  let failSecond = true;
  const wrapped = {
    createRfq: async (...args) => {
      createCalls += 1;
      if (failSecond && createCalls === 2) {
        failSecond = false;
        throw new Error('temporary RFQ transport failure');
      }
      return rfqMarket.createRfq(...args);
    },
    getRfq: (...args) => rfqMarket.getRfq(...args),
    listRfqs: (...args) => rfqMarket.listRfqs(...args),
    getQuote: (...args) => rfqMarket.getQuote(...args),
    acceptQuote: (...args) => rfqMarket.acceptQuote(...args),
    getRevision: (...args) => rfqMarket.getRevision(...args),
  };
  const store = new MemorySnapshotStore();
  const coordinator = await MultiAwardProcurementCoordinator.open({ rfqMarket: wrapped, store, clock });
  const program = await coordinator.createProgram(programInput(), { actorId: 'buyer-a' });

  await assert.rejects(
    coordinator.openProgram(program.id, { actorId: 'buyer-a' }),
    /temporary RFQ transport failure/,
  );
  const partial = await coordinator.getProgram(program.id);
  assert.equal(partial.status, 'opening');
  assert.equal(partial.lots.filter((lot) => lot.rfqId !== null).length, 1);
  assert.equal((await rfqMarket.listRfqs({ status: null })).length, 1);

  const resumed = await coordinator.openProgram(program.id, { actorId: 'buyer-a' });
  assert.equal(resumed.status, 'open');
  assert.equal(resumed.lots.filter((lot) => lot.rfqId !== null).length, 3);
  assert.equal((await rfqMarket.listRfqs({ status: null })).length, 3);
});

test('program creation is durably idempotent and survives coordinator restart', async () => {
  const { rfqMarket, clock } = await fixture();
  const store = new MemorySnapshotStore();
  const first = await MultiAwardProcurementCoordinator.open({ rfqMarket, store, clock });
  const input = programInput();
  const context = { actorId: 'buyer-a', idempotencyKey: 'multi-award-program-1' };
  const created = await first.createProgram(input, context);
  assert.equal((await first.createProgram(input, context)).id, created.id);

  const restarted = await MultiAwardProcurementCoordinator.open({ rfqMarket, store, clock });
  assert.equal((await restarted.createProgram(input, context)).id, created.id);
  await assert.rejects(
    restarted.createProgram(programInput({ lots: [{ quantity: 40 }, { quantity: 20 }] }), context),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('expired procurement cannot open new RFQ lots', async () => {
  const { rfqMarket, coordinator, setNow } = await fixture();
  const program = await coordinator.createProgram(programInput({ expiresAt: '2026-09-01T00:01:00.000Z' }), {
    actorId: 'buyer-a',
  });
  setNow('2026-09-01T00:02:00.000Z');

  await assert.rejects(
    coordinator.openProgram(program.id, { actorId: 'buyer-a' }),
    (error) => error.code === 'PROGRAM_EXPIRED',
  );
  assert.equal((await rfqMarket.listRfqs({ status: null })).length, 0);
});

test('lot partition validation rejects ambiguous or unsafe procurement programs', async () => {
  const { coordinator } = await fixture();
  await assert.rejects(
    coordinator.createProgram(programInput({ lots: [{ quantity: 10 }] }), { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    coordinator.createProgram(programInput({ lots: [{ lotId: 'same', quantity: 10 }, { lotId: 'same', quantity: 10 }] }), { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    coordinator.createProgram(programInput({
      lots: [{ quantity: Number.MAX_SAFE_INTEGER }, { quantity: 1 }],
    }), { actorId: 'buyer-a' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});