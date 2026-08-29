import { sha256Canonical } from './canonical-json.js';

const CURSOR_SCHEMA = 'spaceeconomy.capacity.cursor.v1';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class CapacityQueryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CapacityQueryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new CapacityQueryError(code, message, details);
}

function optionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_QUERY', `${field} must be a non-empty string`);
  return value.trim();
}

function optionalPositiveInteger(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  invariant(Number.isSafeInteger(normalized) && normalized > 0, 'INVALID_QUERY', `${field} must be a positive safe integer`);
  return normalized;
}

function normalizeLimit(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_LIMIT;
  const normalized = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  invariant(Number.isSafeInteger(normalized) && normalized >= 1 && normalized <= MAX_LIMIT, 'INVALID_QUERY', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  return normalized;
}

function normalizeCapabilities(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map((item, index) => {
    invariant(typeof item === 'string' && item.trim().length > 0, 'INVALID_QUERY', `capabilities[${index}] must be a non-empty string`);
    return item.trim();
  });
  return [...new Set(normalized)].sort();
}

function normalizeAvailableAt(value) {
  const normalized = optionalString(value, 'availableAt');
  if (normalized === null) return null;
  const millis = Date.parse(normalized);
  invariant(Number.isFinite(millis), 'INVALID_QUERY', 'availableAt must be a valid timestamp');
  return new Date(millis).toISOString();
}

function normalizeStatus(value) {
  if (value === undefined || value === '') return 'open';
  if (value === null || value === 'all') return null;
  invariant(value === 'open' || value === 'filled', 'INVALID_QUERY', 'status must be open, filled, all, or null');
  return value;
}

function normalizeQuery(input = {}) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_QUERY', 'capacity query must be an object');
  return {
    service: optionalString(input.service, 'service'),
    unit: optionalString(input.unit, 'unit'),
    settlementAsset: optionalString(input.settlementAsset, 'settlementAsset'),
    sellerId: optionalString(input.sellerId, 'sellerId'),
    assetType: optionalString(input.assetType, 'assetType'),
    capabilities: normalizeCapabilities(input.capabilities),
    minRemaining: optionalPositiveInteger(input.minRemaining, 'minRemaining'),
    availableAt: normalizeAvailableAt(input.availableAt),
    status: normalizeStatus(input.status),
    limit: normalizeLimit(input.limit),
    cursor: optionalString(input.cursor, 'cursor'),
  };
}

function filterShape(query) {
  return {
    service: query.service,
    unit: query.unit,
    settlementAsset: query.settlementAsset,
    sellerId: query.sellerId,
    assetType: query.assetType,
    capabilities: query.capabilities,
    minRemaining: query.minRemaining,
    availableAt: query.availableAt,
    status: query.status,
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_CURSOR', 'cursor payload must be an object');
    invariant(parsed.schema === CURSOR_SCHEMA, 'INVALID_CURSOR', 'cursor schema is not supported');
    invariant(Number.isSafeInteger(parsed.revision) && parsed.revision >= 0, 'INVALID_CURSOR', 'cursor revision is invalid');
    invariant(Number.isSafeInteger(parsed.offset) && parsed.offset >= 0, 'INVALID_CURSOR', 'cursor offset is invalid');
    invariant(typeof parsed.queryHash === 'string' && /^[0-9a-f]{64}$/.test(parsed.queryHash), 'INVALID_CURSOR', 'cursor query hash is invalid');
    return parsed;
  } catch (error) {
    if (error instanceof CapacityQueryError) throw error;
    throw new CapacityQueryError('INVALID_CURSOR', 'cursor is not valid base64url JSON');
  }
}

function matchesAvailableAt(offer, availableAt) {
  if (availableAt === null) return true;
  const instant = Date.parse(availableAt);
  if (offer.windowStart !== null && instant < Date.parse(offer.windowStart)) return false;
  if (offer.windowEnd !== null && instant >= Date.parse(offer.windowEnd)) return false;
  return true;
}

function compareOffers(left, right) {
  const timeOrder = String(left.offer.createdAt).localeCompare(String(right.offer.createdAt));
  if (timeOrder !== 0) return timeOrder;
  return String(left.offer.id).localeCompare(String(right.offer.id));
}

/**
 * Read-only market discovery above the clearinghouse kernel.
 *
 * The directory obtains a stable snapshot by bracketing public market reads with
 * the monotonic clearinghouse revision. Pagination cursors are pinned to that
 * revision and to the exact filter set so a caller never silently paginates
 * across a changing market or reuses a cursor with different search semantics.
 */
export class CapacityDirectory {
  constructor({ market, maxSnapshotRetries = 3 } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'listAssets', 'listOffers']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');
    this.market = market;
    this.maxSnapshotRetries = maxSnapshotRetries;
  }

  async find(input = {}) {
    const query = normalizeQuery(input);
    const queryHash = sha256Canonical(filterShape(query));
    const cursor = decodeCursor(query.cursor);
    const snapshot = await this.#snapshot();

    if (cursor !== null) {
      invariant(cursor.queryHash === queryHash, 'CURSOR_QUERY_MISMATCH', 'cursor was created for different capacity filters');
      invariant(cursor.revision === snapshot.revision, 'STALE_CURSOR', 'market changed after the previous page; restart the query', {
        cursorRevision: cursor.revision,
        actualRevision: snapshot.revision,
      });
    }

    const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
    const matches = snapshot.offers
      .map((offer) => ({ offer, asset: assets.get(offer.assetId) ?? null }))
      .filter(({ offer, asset }) => {
        if (asset === null) return false;
        if (query.service !== null && offer.service !== query.service) return false;
        if (query.unit !== null && offer.unit !== query.unit) return false;
        if (query.settlementAsset !== null && offer.unitPrice?.settlementAsset !== query.settlementAsset) return false;
        if (query.sellerId !== null && offer.sellerId !== query.sellerId) return false;
        if (query.assetType !== null && asset.type !== query.assetType) return false;
        if (query.status !== null && offer.status !== query.status) return false;
        if (query.minRemaining !== null && offer.remaining < query.minRemaining) return false;
        if (!query.capabilities.every((capability) => asset.capabilities?.includes(capability))) return false;
        if (!matchesAvailableAt(offer, query.availableAt)) return false;
        return true;
      })
      .sort(compareOffers);

    const offset = cursor?.offset ?? 0;
    invariant(offset <= matches.length, 'INVALID_CURSOR', 'cursor offset exceeds the current result set');
    const items = matches.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < matches.length
      ? encodeCursor({ schema: CURSOR_SCHEMA, revision: snapshot.revision, offset: nextOffset, queryHash })
      : null;

    return {
      revision: snapshot.revision,
      items: structuredClone(items),
      nextCursor,
    };
  }

  async #snapshot() {
    for (let attempt = 1; attempt <= this.maxSnapshotRetries; attempt += 1) {
      const before = await this.market.getRevision();
      const [assets, offers] = await Promise.all([
        this.market.listAssets(),
        this.market.listOffers({ status: null }),
      ]);
      const after = await this.market.getRevision();
      if (before === after) return { revision: after, assets, offers };
    }
    throw new CapacityQueryError('READ_SNAPSHOT_CONFLICT', 'market changed repeatedly while building the capacity read snapshot; retry the query');
  }
}
