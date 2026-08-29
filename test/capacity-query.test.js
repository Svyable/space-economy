import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { CapacityDirectory } from '../src/capacity-query.js';

const ctx = (actorId) => ({ actorId });

function sequentialIds() {
  let value = 0;
  return () => `id-${String(++value).padStart(4, '0')}`;
}

async function marketFixture() {
  const market = await Clearinghouse.open({
    idGenerator: sequentialIds(),
    clock: () => new Date('2026-09-01T00:00:00.000Z'),
  });

  const relay = await market.registerAsset({
    name: 'Relay A',
    type: 'communications-satellite',
    capabilities: ['data-relay', 'store-and-forward'],
    location: { orbit: 'LEO' },
  }, ctx('relay-co'));
  const telescope = await market.registerAsset({
    name: 'Scope B',
    type: 'space-telescope',
    capabilities: ['earth-observation', 'multispectral'],
    location: { orbit: 'SSO' },
  }, ctx('scope-co'));

  const relayUsd = await market.createOffer({
    assetId: relay.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '25', scale: 2 },
    capacity: 100,
    windowStart: '2026-09-02T00:00:00.000Z',
    windowEnd: '2026-09-03T00:00:00.000Z',
  }, ctx('relay-co'));
  const relayCredits = await market.createOffer({
    assetId: relay.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'urn:example:relay-credit', amount: '3', scale: 0 },
    capacity: 20,
  }, ctx('relay-co'));
  const imaging = await market.createOffer({
    assetId: telescope.id,
    service: 'earth-observation',
    unit: 'scene',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '12500', scale: 2 },
    capacity: 8,
    windowStart: '2026-09-04T00:00:00.000Z',
    windowEnd: '2026-09-05T00:00:00.000Z',
  }, ctx('scope-co'));

  return { market, relay, telescope, relayUsd, relayCredits, imaging };
}

test('filters capacity by economic and asset dimensions without inventing ranking', async () => {
  const { market, relayUsd } = await marketFixture();
  const directory = new CapacityDirectory({ market });

  const result = await directory.find({
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    assetType: 'communications-satellite',
    capabilities: ['data-relay'],
    minRemaining: 50,
    availableAt: '2026-09-02T12:00:00Z',
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].offer.id, relayUsd.id);
  assert.equal(result.items[0].asset.name, 'Relay A');
  assert.equal(result.items[0].offer.remaining, 100);
  assert.equal(result.nextCursor, null);
  assert.equal(result.revision, await market.getRevision());
});

test('availability filtering treats null windows as unbounded and window end as exclusive', async () => {
  const { market, relayUsd, relayCredits } = await marketFixture();
  const directory = new CapacityDirectory({ market });

  const inside = await directory.find({ service: 'data-relay', availableAt: '2026-09-02T12:00:00Z', status: 'all' });
  assert.deepEqual(new Set(inside.items.map(({ offer }) => offer.id)), new Set([relayUsd.id, relayCredits.id]));

  const atEnd = await directory.find({ service: 'data-relay', availableAt: '2026-09-03T00:00:00Z', status: 'all' });
  assert.deepEqual(atEnd.items.map(({ offer }) => offer.id), [relayCredits.id]);
});

test('cursor pagination is deterministic and pinned to one market revision', async () => {
  const { market } = await marketFixture();
  const directory = new CapacityDirectory({ market });

  const first = await directory.find({ status: 'all', limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);

  const second = await directory.find({ status: 'all', limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.revision, first.revision);

  const ids = [...first.items, ...second.items].map(({ offer }) => offer.id);
  assert.equal(new Set(ids).size, 3);
});

test('cursor cannot be reused with different filters', async () => {
  const { market } = await marketFixture();
  const directory = new CapacityDirectory({ market });
  const first = await directory.find({ status: 'all', limit: 1 });

  await assert.rejects(
    directory.find({ service: 'data-relay', status: 'all', limit: 1, cursor: first.nextCursor }),
    (error) => error.code === 'CURSOR_QUERY_MISMATCH',
  );
});

test('market mutation invalidates a pagination cursor rather than silently shifting pages', async () => {
  const { market, relayUsd } = await marketFixture();
  const directory = new CapacityDirectory({ market });
  const first = await directory.find({ status: 'all', limit: 1 });

  await market.createOrder({ offerId: relayUsd.id, quantity: 1 }, ctx('buyer'));

  await assert.rejects(
    directory.find({ status: 'all', limit: 1, cursor: first.nextCursor }),
    (error) => error.code === 'STALE_CURSOR'
      && error.details.cursorRevision === first.revision
      && error.details.actualRevision === first.revision + 1,
  );
});

test('filled offers can be included explicitly while open remains the safe default', async () => {
  const { market, relayCredits } = await marketFixture();
  const directory = new CapacityDirectory({ market });
  await market.createOrder({ offerId: relayCredits.id, quantity: relayCredits.capacity }, ctx('buyer'));

  const defaultPage = await directory.find({ service: 'data-relay' });
  assert.ok(defaultPage.items.every(({ offer }) => offer.status === 'open'));
  assert.ok(!defaultPage.items.some(({ offer }) => offer.id === relayCredits.id));

  const all = await directory.find({ service: 'data-relay', status: 'all' });
  assert.ok(all.items.some(({ offer }) => offer.id === relayCredits.id && offer.status === 'filled'));
});

test('invalid query and cursor inputs fail closed', async () => {
  const { market } = await marketFixture();
  const directory = new CapacityDirectory({ market });

  await assert.rejects(directory.find({ limit: 101 }), (error) => error.code === 'INVALID_QUERY');
  await assert.rejects(directory.find({ minRemaining: 0 }), (error) => error.code === 'INVALID_QUERY');
  await assert.rejects(directory.find({ availableAt: 'tomorrow-ish' }), (error) => error.code === 'INVALID_QUERY');
  await assert.rejects(directory.find({ cursor: 'not-a-cursor' }), (error) => error.code === 'INVALID_CURSOR');
});

test('repeated concurrent mutations fail snapshot acquisition explicitly', async () => {
  let revision = 0;
  const unstableMarket = {
    async getRevision() { return revision++; },
    async listAssets() { return []; },
    async listOffers() { return []; },
  };
  const directory = new CapacityDirectory({ market: unstableMarket, maxSnapshotRetries: 2 });

  await assert.rejects(
    directory.find(),
    (error) => error.code === 'READ_SNAPSHOT_CONFLICT',
  );
});
