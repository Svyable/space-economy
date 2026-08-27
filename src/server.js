import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { developmentHeaderAuthenticator } from './auth.js';
import { Clearinghouse } from './clearinghouse.js';

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

const problem = (req, res, status, error, requestId) => {
  const code = error.code ?? 'BAD_REQUEST';
  const body = {
    type: `urn:space-economy:problem:${code.toLowerCase().replaceAll('_', '-')}`,
    title: code.replaceAll('_', ' ').toLowerCase(),
    status,
    detail: error.message,
    instance: req.url,
    code,
    requestId,
  };
  if (error.details !== undefined) body.details = error.details;
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
  });
  res.end(payload);
};

const readBody = async (req, maxBodyBytes) => {
  const contentType = req.headers['content-type'] ?? '';
  const mediaType = String(contentType).split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    const error = new Error('content-type must be application/json');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBodyBytes) {
      const error = new Error(`request body exceeds ${maxBodyBytes} bytes`);
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
};

const parseIfMatch = (req) => {
  const value = req.headers['if-match'];
  if (!value) return null;
  const match = String(value).match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) {
    const error = new Error('If-Match must contain a numeric resource version');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  return Number(match[1]);
};

const requestContext = async (req, authenticate) => {
  const identity = await authenticate(req);
  if (identity !== null && identity !== undefined && (typeof identity !== 'object' || typeof identity.actorId !== 'string')) {
    const error = new Error('authenticator must return null or an object containing actorId');
    error.code = 'INVALID_CONFIGURATION';
    throw error;
  }
  return {
    actorId: identity?.actorId,
    idempotencyKey: req.headers['idempotency-key'] ?? null,
    expectedVersion: parseIfMatch(req),
  };
};

const statusByCode = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_CAPACITY: 409,
  STALE_VERSION: 412,
  STORE_CONFLICT: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  CORRUPT_STATE: 500,
  UNSUPPORTED_SCHEMA: 500,
  INVALID_CONFIGURATION: 500,
};

async function route(req, res, requestId, market, maxBodyBytes, authenticate) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, ledgerValid: market.verifyLedger(), revision: market.getRevision() }, { 'x-request-id': requestId });
  }
  if (req.method === 'GET' && url.pathname === '/v1/assets') {
    return json(res, 200, { data: market.listAssets() }, { 'x-request-id': requestId });
  }
  if (req.method === 'POST' && url.pathname === '/v1/assets') {
    return json(res, 201, { data: market.registerAsset(await readBody(req, maxBodyBytes), await requestContext(req, authenticate)) }, { 'x-request-id': requestId });
  }
  if (req.method === 'GET' && url.pathname === '/v1/offers') {
    return json(res, 200, { data: market.listOffers({ service: url.searchParams.get('service') ?? undefined, status: url.searchParams.get('status') ?? 'open' }) }, { 'x-request-id': requestId });
  }
  if (req.method === 'POST' && url.pathname === '/v1/offers') {
    return json(res, 201, { data: market.createOffer(await readBody(req, maxBodyBytes), await requestContext(req, authenticate)) }, { 'x-request-id': requestId });
  }
  if (req.method === 'POST' && url.pathname === '/v1/orders') {
    return json(res, 201, { data: market.createOrder(await readBody(req, maxBodyBytes), await requestContext(req, authenticate)) }, { 'x-request-id': requestId });
  }
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'orders' && parts.length === 3) {
    const order = market.getOrder(parts[2]);
    return json(res, 200, { data: order }, { etag: `"${order.version}"`, 'x-request-id': requestId });
  }
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'orders' && parts.length === 4) {
    const orderId = parts[2];
    const action = parts[3];
    const body = action === 'cancel' ? {} : await readBody(req, maxBodyBytes);
    const commandContext = await requestContext(req, authenticate);
    if (action === 'fund') return json(res, 200, { data: market.fundOrder(orderId, body, commandContext) }, { 'x-request-id': requestId });
    if (action === 'deliver') return json(res, 200, { data: market.recordDelivery(orderId, body, commandContext) }, { 'x-request-id': requestId });
    if (action === 'settle') return json(res, 200, { data: market.settleOrder(orderId, body, commandContext) }, { 'x-request-id': requestId });
    if (action === 'cancel') return json(res, 200, { data: market.cancelOrder(orderId, commandContext) }, { 'x-request-id': requestId });
  }
  if (req.method === 'GET' && url.pathname === '/v1/ledger') {
    return json(res, 200, { valid: market.verifyLedger(), data: market.getLedger() }, { 'x-request-id': requestId });
  }

  const error = new Error('route not found');
  error.code = 'NOT_FOUND';
  throw error;
}

export function createHttpServer({
  market = new Clearinghouse(),
  maxBodyBytes = 1_048_576,
  authenticate = developmentHeaderAuthenticator,
} = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError('maxBodyBytes must be a positive safe integer');
  if (typeof authenticate !== 'function') throw new TypeError('authenticate must be a function');
  return http.createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    try {
      await route(req, res, requestId, market, maxBodyBytes, authenticate);
    } catch (error) {
      problem(req, res, statusByCode[error.code] ?? 400, error, requestId);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const statePath = process.env.STATE_PATH ?? './data/state.json';
  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 1_048_576);
  const market = new Clearinghouse({ statePath });
  const server = createHttpServer({ market, maxBodyBytes });
  server.listen(port, () => {
    console.log(`Space Economy Clearinghouse listening on http://localhost:${port}`);
    console.log(`Persistent state: ${statePath}`);
    console.log('Development identity adapter: x-participant-id header (do not use as production authentication)');
  });
}
