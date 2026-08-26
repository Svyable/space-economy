import http from 'node:http';
import { URL } from 'node:url';
import { Clearinghouse } from './clearinghouse.js';

const port = Number(process.env.PORT ?? 8787);
const statePath = process.env.STATE_PATH ?? './data/state.json';
const market = new Clearinghouse({ statePath });

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
};

const route = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, ledgerValid: market.verifyLedger() });
  }
  if (req.method === 'GET' && url.pathname === '/assets') {
    return json(res, 200, { data: market.listAssets() });
  }
  if (req.method === 'POST' && url.pathname === '/assets') {
    return json(res, 201, { data: market.registerAsset(await readBody(req)) });
  }
  if (req.method === 'GET' && url.pathname === '/offers') {
    return json(res, 200, { data: market.listOffers({ service: url.searchParams.get('service') ?? undefined }) });
  }
  if (req.method === 'POST' && url.pathname === '/offers') {
    return json(res, 201, { data: market.createOffer(await readBody(req)) });
  }
  if (req.method === 'POST' && url.pathname === '/orders') {
    return json(res, 201, { data: market.createOrder(await readBody(req)) });
  }
  if (req.method === 'GET' && parts[0] === 'orders' && parts.length === 2) {
    return json(res, 200, { data: market.getOrder(parts[1]) });
  }
  if (req.method === 'POST' && parts[0] === 'orders' && parts.length === 3) {
    const body = await readBody(req);
    const orderId = parts[1];
    const action = parts[2];
    if (action === 'fund') return json(res, 200, { data: market.fundOrder(orderId, body) });
    if (action === 'deliver') return json(res, 200, { data: market.recordDelivery(orderId, body) });
    if (action === 'settle') return json(res, 200, { data: market.settleOrder(orderId, body) });
    if (action === 'cancel') return json(res, 200, { data: market.cancelOrder(orderId, body) });
  }
  if (req.method === 'GET' && url.pathname === '/ledger') {
    return json(res, 200, { valid: market.verifyLedger(), data: market.getLedger() });
  }

  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
};

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const statusByCode = {
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      CONFLICT: 409,
      INSUFFICIENT_CAPACITY: 409,
      CORRUPT_STATE: 500,
    };
    json(res, statusByCode[error.code] ?? 400, {
      error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
    });
  }
});

server.listen(port, () => {
  console.log(`Space Economy Clearinghouse listening on http://localhost:${port}`);
  console.log(`Persistent state: ${statePath}`);
});
