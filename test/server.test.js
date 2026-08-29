import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { createHttpServer } from '../src/server.js';

async function withServer(run, serverOptions = {}) {
  const market = serverOptions.market ?? await Clearinghouse.open();
  const { market: _market, ...httpOptions } = serverOptions;
  const server = createHttpServer({ market, ...httpOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, market });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('HTTP adapter returns RFC 9457 problem details when actor identity is missing', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Relay A', type: 'satellite' }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
    const body = await response.json();
    assert.equal(body.code, 'UNAUTHENTICATED');
    assert.equal(body.status, 401);
    assert.ok(body.requestId);
  });
});

test('HTTP idempotency retries return the same created asset', async () => {
  await withServer(async ({ baseUrl, market }) => {
    const request = () => fetch(`${baseUrl}/v1/assets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-participant-id': 'relay-one',
        'idempotency-key': 'asset-001',
      },
      body: JSON.stringify({ name: 'Relay A', type: 'satellite' }),
    });
    const first = await request();
    const second = await request();
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.data.id, secondBody.data.id);
    assert.equal((await market.listAssets()).length, 1);
  });
});

test('injected authenticator determines actor identity instead of caller headers', async () => {
  const authenticate = async () => ({ actorId: 'verified-operator', assurance: { method: 'test' } });
  await withServer(async ({ baseUrl, market }) => {
    const response = await fetch(`${baseUrl}/v1/assets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-participant-id': 'spoofed-operator',
      },
      body: JSON.stringify({ name: 'Relay A', type: 'satellite' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.ownerId, 'verified-operator');
    assert.equal((await market.listAssets())[0].ownerId, 'verified-operator');
  }, { authenticate });
});

test('HTTP adapter rejects lookalike JSON media types', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/assets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json-patch+json',
        'x-participant-id': 'relay-one',
      },
      body: JSON.stringify({ name: 'Relay A', type: 'satellite' }),
    });
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

test('HTTP capacity discovery filters and returns revision-aware page metadata', async () => {
  const market = await Clearinghouse.open();
  const asset = await market.registerAsset({
    name: 'Relay A',
    type: 'communications-satellite',
    capabilities: ['data-relay', 'store-and-forward'],
  }, { actorId: 'seller' });
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '15', scale: 2 },
    capacity: 100,
  }, { actorId: 'seller' });
  await market.createOffer({
    assetId: asset.id,
    service: 'data-relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'urn:example:credit', amount: '1', scale: 0 },
    capacity: 100,
  }, { actorId: 'seller' });

  await withServer(async ({ baseUrl }) => {
    const params = new URLSearchParams({
      service: 'data-relay',
      unit: 'MB',
      settlementAsset: 'iso4217:USD',
      assetType: 'communications-satellite',
      capability: 'data-relay',
      minRemaining: '50',
      limit: '1',
    });
    const response = await fetch(`${baseUrl}/v1/capacity?${params}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].offer.id, offer.id);
    assert.equal(body.data[0].asset.id, asset.id);
    assert.equal(body.meta.revision, 3);
    assert.equal(body.meta.nextCursor, null);
  }, { market });
});

test('HTTP capacity pagination returns conflict when market revision changes', async () => {
  const market = await Clearinghouse.open();
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller' });
  const firstOffer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '1', scale: 0 },
    capacity: 10,
  }, { actorId: 'seller' });
  await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '2', scale: 0 },
    capacity: 10,
  }, { actorId: 'seller' });

  await withServer(async ({ baseUrl }) => {
    const firstResponse = await fetch(`${baseUrl}/v1/capacity?service=relay&limit=1`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.ok(first.meta.nextCursor);

    await market.createOrder({ offerId: firstOffer.id, quantity: 1 }, { actorId: 'buyer' });

    const params = new URLSearchParams({ service: 'relay', limit: '1', cursor: first.meta.nextCursor });
    const staleResponse = await fetch(`${baseUrl}/v1/capacity?${params}`);
    assert.equal(staleResponse.status, 409);
    assert.match(staleResponse.headers.get('content-type'), /^application\/problem\+json/);
    const stale = await staleResponse.json();
    assert.equal(stale.code, 'STALE_CURSOR');
    assert.equal(stale.details.cursorRevision, first.meta.revision);
    assert.equal(stale.details.actualRevision, first.meta.revision + 1);
  }, { market });
});

test('reservation expiry is exposed as an authenticated optimistic-concurrency command', async () => {
  let current = new Date('2026-08-26T20:00:00.000Z');
  const market = await Clearinghouse.open({ clock: () => new Date(current) });
  const asset = await market.registerAsset({ name: 'Relay', type: 'satellite' }, { actorId: 'seller' });
  const offer = await market.createOffer({
    assetId: asset.id,
    service: 'relay',
    unit: 'MB',
    unitPrice: { settlementAsset: 'iso4217:USD', amount: '10', scale: 2 },
    capacity: 10,
    reservationTtlSeconds: 60,
  }, { actorId: 'seller' });
  const order = await market.createOrder({ offerId: offer.id, quantity: 4 }, { actorId: 'buyer' });
  current = new Date('2026-08-26T20:01:00.000Z');

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/orders/${order.id}/expire`, {
      method: 'POST',
      headers: {
        'x-participant-id': 'expiry-worker',
        'idempotency-key': 'expire-http-1',
        'if-match': `"${order.version}"`,
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.status, 'expired');
    assert.equal(body.data.expiration.triggeredBy, 'expiry-worker');
  }, { market });

  assert.equal((await market.listOffers())[0].remaining, 10);
});

test('versioned route surface and health endpoint are reachable', async () => {
  await withServer(async ({ baseUrl }) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, ledgerValid: true, revision: 0 });

    const legacy = await fetch(`${baseUrl}/assets`);
    assert.equal(legacy.status, 404);
    assert.match(legacy.headers.get('content-type'), /^application\/problem\+json/);
  });
});
