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

function matchesFilters({ offer, asset }, filters) {
  if (asset === null) return false;
  if (filters.service !== null && offer.service !== filters.service) return false;
  if (filters.unit !== null && offer.unit !== filters.unit) return false;
  if (filters.settlementAsset !== null && offer.unitPrice?.settlementAsset !== filters.settlementAsset) return false;
  if (filters.sellerId !== null && offer.sellerId !== filters.sellerId) return false;
  if (filters.assetType !== null && asset.type !== filters.assetType) return false;
  if (filters.status !== null && offer.status !== filters.status) return false;
  if (filters.minRemaining !== null && offer.remaining < filters.minRemaining) return false;
  if (!filters.capabilities.every((capability) => asset.capabilities?.includes(capability))) return false;
  if (!matchesAvailableAt(offer, filters.availableAt)) return false;
  return true;
}

/**
 * Reference query source backed directly by the live clearinghouse read surface.
 *
 * It assembles one stable snapshot by bracketing public reads with the monotonic
 * clearinghouse revision. More scalable sources can implement the same search()
 * contract without changing CapacityDirectory or its cursor semantics.
 */
export class MarketCapacitySource {
  constructor({ market, maxSnapshotRetries = 3 } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getRevision', 'listAssets', 'listOffers']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');
    this.market = market;
    this.maxSnapshotRetries = maxSnapshotRetries;
  }

  async search({ filters, offset, limit }) {
    const snapshot = await this.#snapshot();
    const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
    const matches = snapshot.offers
      .map((offer) => ({ offer, asset: assets.get(offer.assetId) ?? null }))
      .filter((item) => matchesFilters(item, filters))
      .sort(compareOffers);

    invariant(offset <= matches.length, 'INVALID_CURSOR', 'cursor offset exceeds the current result set');
    const window = matches.slice(offset, offset + limit + 1);
    return {
      revision: snapshot.revision,
      items: structuredClone(window.slice(0, limit)),
      hasMore: window.length > limit,
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

/**
 * Bounded read-side market discovery with backend-neutral cursor semantics.
 *
 * A source must provide:
 *
 *   search({ filters, expectedRevision, offset, limit })
 *     -> { revision, items: [{ offer, asset }], hasMore }
 *
 * The directory owns query normalization, filter hashing, opaque cursors, and
 * stale-cursor behavior. Sources own efficient retrieval from one attributable
 * clearinghouse revision.
 */
export class CapacityDirectory {
  constructor({ market = null, source = null, maxSnapshotRetries = 3 } = {}) {
    invariant((market === null) !== (source === null), 'INVALID_CONFIGURATION', 'provide exactly one of market or source');
    if (source !== null) {
      invariant(source && typeof source.search === 'function', 'INVALID_CONFIGURATION', 'source must provide search()');
      this.source = source;
    } else {
      this.source = new MarketCapacitySource({ market, maxSnapshotRetries });
    }
  }

  async find(input = {}) {
    const query = normalizeQuery(input);
    const filters = filterShape(query);
    const queryHash = sha256Canonical(filters);
    const cursor = decodeCursor(query.cursor);

    if (cursor !== null) {
      invariant(cursor.queryHash === queryHash, 'CURSOR_QUERY_MISMATCH', 'cursor was created for different capacity filters');
    }

    const offset = cursor?.offset ?? 0;
    const page = await this.source.search({
      filters,
      expectedRevision: cursor?.revision ?? null,
      offset,
      limit: query.limit,
    });

    invariant(page && typeof page === 'object' && !Array.isArray(page), 'INVALID_QUERY_SOURCE', 'capacity source returned an invalid page');
    invariant(Number.isSafeInteger(page.revision) && page.revision >= 0, 'INVALID_QUERY_SOURCE', 'capacity source revision is invalid');
    invariant(Array.isArray(page.items), 'INVALID_QUERY_SOURCE', 'capacity source items must be an array');
    invariant(typeof page.hasMore === 'boolean', 'INVALID_QUERY_SOURCE', 'capacity source hasMore must be boolean');
    invariant(page.items.length <= query.limit, 'INVALID_QUERY_SOURCE', 'capacity source returned more items than requested');

    if (cursor !== null) {
      invariant(cursor.revision === page.revision, 'STALE_CURSOR', 'market changed after the previous page; restart the query', {
        cursorRevision: cursor.revision,
        actualRevision: page.revision,
      });
    }

    const nextOffset = offset + page.items.length;
    const nextCursor = page.hasMore
      ? encodeCursor({ schema: CURSOR_SCHEMA, revision: page.revision, offset: nextOffset, queryHash })
      : null;

    return {
      revision: page.revision,
      items: structuredClone(page.items),
      nextCursor,
    };
  }
}
