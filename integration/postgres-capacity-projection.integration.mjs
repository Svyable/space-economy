import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { CapacityDirectory } from '../src/capacity-query.js';
import { Clearinghouse } from '../src/clearinghouse.js';
import { PostgresCapacityProjection } from '../src/postgres-capacity-projection.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');

const pool = new Pool({ connectionString });
const projection = new PostgresCapacityProjection(pool, {
  tablePrefix: 'space_economy_capacity_it',
  projectionKey: 'integration',
});

await projection.ensureSchema();

async function resetProjection() {
  await pool.query('DELETE FROM public.space_economy_capacity_it_offers WHERE projection_key = $1', ['integration']);
  await pool.query('DELETE FROM public.space_economy_capacity_it_assets WHERE projection_key = $1', ['integration']);
  await pool.query('DELETE FROM public.space_economy_capacity_it_meta WHERE projection_key = $1', ['integration']);
}

async function fixture() {
  const market = await Clearinghouse.open();
  const relay = await market.registerAsset({
    name: 'Relay A',
    type: 'communications-satellite',
    capabilities: ['data-relay', 'store-and-forward'],
  }, { actorId: 'relay-co' });
  const telescope = await market.registerAsset({
    name: 'Scope B',
    type: 'space-telescope',
    capabilities: ['earth-observation'],
  }, { actorId: 'scope-co' });
  const relayOne = await market.createOffer({
    assetId: relay.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 100,
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: '2026-09-02T00:00:00Z',
  }, { actorId: 'relay-co' });
  const relayTwo = await market.createOffer({
    assetId: relay.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '20', scale: 2 },
    capacity: 50,
  }, { actorId: 'relay-co' });
  await market.createOffer({
    assetId: telescope.id,
    service: 'earth-observation',
    unit: 'scene',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '5000', scale: 2 },
    capacity: 8,
  }, { actorId: 'scope-co' });
  return { market, relayOne, relayTwo };
}

test('indexed PostgreSQL projection serves the CapacityDirectory contract', async () => {
  await resetProjection();
  const { market, relayOne } = await fixture();
  const refreshed = await projection.refreshFromMarket(market);
  assert.equal(refreshed.revision, 5);
  assert.equal(refreshed.assetCount, 2);
  assert.equal(refreshed.offerCount, 3);
  assert.equal(await projection.getRevision(), 5);

  const directory = new CapacityDirectory({ source: projection });
  const page = await directory.find({
    service: 'data-relay',
    unit: 'MB',
    settlementAsset: 'iso4217:USD',
    assetType: 'communications-satellite',
    capabilities: ['data-relay'],
    minRemaining: 75,
    availableAt: '2026-09-01T12:00:00Z',
  });
  assert.equal(page.revision, 5);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].offer.id, relayOne.id);
  assert.equal(page.items[0].asset.name, 'Relay A');
});

test('projection cursor remains valid until refresh advances the served revision', async () => {
  await resetProjection();
  const { market, relayOne } = await fixture();
  await projection.refreshFromMarket(market);
  const directory = new CapacityDirectory({ source: projection });

  const first = await directory.find({ service: 'data-relay', limit: 1 });
  assert.equal(first.revision, 5);
  assert.ok(first.nextCursor);

  await market.createOrder({ offerId: relayOne.id, quantity: 1 }, { actorId: 'buyer' });

  const stillPinned = await directory.find({ service: 'data-relay', limit: 1, cursor: first.nextCursor });
  assert.equal(stillPinned.revision, 5);

  await projection.refreshFromMarket(market);
  assert.equal(await projection.getRevision(), 6);
  await assert.rejects(
    directory.find({ service: 'data-relay', limit: 1, cursor: first.nextCursor }),
    (error) => error.code === 'STALE_CURSOR'
      && error.details.cursorRevision === 5
      && error.details.actualRevision === 6,
  );
});

test('projection refresh refuses revision regression and preserves the newer projection', async () => {
  await resetProjection();
  const { market } = await fixture();
  await projection.refreshFromMarket(market);

  const older = await Clearinghouse.open();
  await older.registerAsset({ name: 'Old Asset', type: 'satellite' }, { actorId: 'old-owner' });

  await assert.rejects(
    projection.refreshFromMarket(older),
    (error) => error.code === 'PROJECTION_REGRESSION'
      && error.details.projectedRevision === 5
      && error.details.snapshotRevision === 1,
  );
  assert.equal(await projection.getRevision(), 5);
});

test.after(async () => {
  await resetProjection();
  await pool.end();
});
