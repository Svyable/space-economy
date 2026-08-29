import assert from 'node:assert/strict';
import test from 'node:test';
import { Clearinghouse } from '../src/clearinghouse.js';
import { createHttpServer } from '../src/server.js';

async function withServer(server, run) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('HTTP /v1/capacity can use an injected read projection while market routes stay authoritative', async () => {
  const market = await Clearinghouse.open();
  const source = {
    async search({ filters, offset, limit }) {
      assert.equal(filters.service, 'projected-relay');
      assert.equal(offset, 0);
      assert.equal(limit, 5);
      return {
        revision: 17,
        items: [{
          offer: { id: 'projected-offer', service: 'projected-relay' },
          asset: { id: 'projected-asset', type: 'relay' },
        }],
        hasMore: false,
      };
    },
  };
  const server = createHttpServer({ market, capacitySource: source });

  await withServer(server, async (baseUrl) => {
    const capacity = await fetch(`${baseUrl}/v1/capacity?service=projected-relay&limit=5`);
    assert.equal(capacity.status, 200);
    const body = await capacity.json();
    assert.equal(body.meta.revision, 17);
    assert.equal(body.data[0].offer.id, 'projected-offer');

    const assets = await fetch(`${baseUrl}/v1/assets`);
    assert.equal(assets.status, 200);
    assert.deepEqual(await assets.json(), { data: [] });
  });
});

test('HTTP adapter rejects an invalid injected capacity source at construction', async () => {
  const market = await Clearinghouse.open();
  assert.throws(
    () => createHttpServer({ market, capacitySource: {} }),
    (error) => error.code === 'INVALID_CONFIGURATION' && /source must provide search/.test(error.message),
  );
});
