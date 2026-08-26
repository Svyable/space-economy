import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { createHttpServer } from '../src/server.js';

async function withServer(run) {
  const market = new Clearinghouse();
  const server = createHttpServer({ market });
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
    assert.equal(market.listAssets().length, 1);
  });
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
