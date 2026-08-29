import { CapacityQueryError } from './capacity-query.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CapacityProjectionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CapacityProjectionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function identifier(value, field, maxLength = 40) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || value.length > maxLength) {
    throw new TypeError(`${field} must be a simple PostgreSQL identifier up to ${maxLength} characters`);
  }
  return value;
}

function postgresText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  if (value.includes('\u0000')) throw new TypeError(`${field} must not contain NUL`);
  return value;
}

function safeRevision(value, field) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return number;
}

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
}

function validateMarket(market) {
  if (!market || typeof market !== 'object') throw new TypeError('market is required');
  for (const method of ['getRevision', 'listAssets', 'listOffers']) {
    if (typeof market[method] !== 'function') throw new TypeError(`market must provide ${method}()`);
  }
}

/**
 * Current-revision PostgreSQL projection for bounded capacity discovery.
 *
 * The projection is refreshed transactionally from one stable clearinghouse
 * revision. Queries execute in REPEATABLE READ transactions and use normalized
 * columns/indexes for filtering while returning the original asset/offer JSON.
 *
 * The module intentionally imports no PostgreSQL driver. Inject a pool with the
 * node-postgres query() + connect() interface (or an equivalent adapter).
 */
export class PostgresCapacityProjection {
  constructor(pool, {
    schema = 'public',
    tablePrefix = 'space_economy_capacity',
    projectionKey = 'default',
    maxSnapshotRetries = 3,
  } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('pool must provide query() and connect()');
    }
    if (!Number.isSafeInteger(maxSnapshotRetries) || maxSnapshotRetries < 1 || maxSnapshotRetries > 20) {
      throw new TypeError('maxSnapshotRetries must be an integer from 1 to 20');
    }

    this.pool = pool;
    this.schema = identifier(schema, 'schema', 63);
    this.tablePrefix = identifier(tablePrefix, 'tablePrefix', 40);
    this.projectionKey = postgresText(projectionKey, 'projectionKey');
    this.maxSnapshotRetries = maxSnapshotRetries;

    this.metaTable = `"${this.schema}"."${this.tablePrefix}_meta"`;
    this.assetsTable = `"${this.schema}"."${this.tablePrefix}_assets"`;
    this.offersTable = `"${this.schema}"."${this.tablePrefix}_offers"`;
    this.lockKey = JSON.stringify([this.schema, this.tablePrefix, this.projectionKey]);
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.metaTable} (
        projection_key TEXT PRIMARY KEY,
        revision BIGINT NOT NULL CHECK (revision >= 0),
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ${this.assetsTable} (
        projection_key TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        capabilities JSONB NOT NULL,
        asset JSONB NOT NULL,
        PRIMARY KEY (projection_key, asset_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.offersTable} (
        projection_key TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        service TEXT NOT NULL,
        unit TEXT NOT NULL,
        settlement_asset TEXT NOT NULL,
        remaining BIGINT NOT NULL CHECK (remaining >= 0),
        status TEXT NOT NULL,
        window_start TIMESTAMPTZ,
        window_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        offer JSONB NOT NULL,
        PRIMARY KEY (projection_key, offer_id)
      );

      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_offer_lookup_idx"
        ON ${this.offersTable} (projection_key, service, status, unit, settlement_asset);
      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_offer_seller_idx"
        ON ${this.offersTable} (projection_key, seller_id);
      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_offer_remaining_idx"
        ON ${this.offersTable} (projection_key, remaining);
      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_offer_window_idx"
        ON ${this.offersTable} (projection_key, window_start, window_end);
      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_asset_type_idx"
        ON ${this.assetsTable} (projection_key, asset_type);
      CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_asset_caps_idx"
        ON ${this.assetsTable} USING GIN (capabilities jsonb_path_ops);
    `);
  }

  async refreshFromMarket(market) {
    validateMarket(market);
    const snapshot = await this.#captureMarketSnapshot(market);
    const client = await this.pool.connect();
    let began = false;

    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.lockKey]);

      const current = await client.query(
        `SELECT revision FROM ${this.metaTable} WHERE projection_key = $1 FOR UPDATE`,
        [this.projectionKey],
      );
      if (current.rows.length > 0) {
        const currentRevision = safeRevision(current.rows[0].revision, 'projection revision');
        if (snapshot.revision < currentRevision) {
          throw new CapacityProjectionError('PROJECTION_REGRESSION', 'refusing to replace a newer projection with an older clearinghouse revision', {
            projectedRevision: currentRevision,
            snapshotRevision: snapshot.revision,
          });
        }
      }

      await client.query(`DELETE FROM ${this.offersTable} WHERE projection_key = $1`, [this.projectionKey]);
      await client.query(`DELETE FROM ${this.assetsTable} WHERE projection_key = $1`, [this.projectionKey]);

      for (const asset of snapshot.assets) {
        await client.query(
          `INSERT INTO ${this.assetsTable}
             (projection_key, asset_id, asset_type, capabilities, asset)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            this.projectionKey,
            asset.id,
            asset.type,
            JSON.stringify(asset.capabilities ?? []),
            JSON.stringify(asset),
          ],
        );
      }

      for (const offer of snapshot.offers) {
        await client.query(
          `INSERT INTO ${this.offersTable}
             (projection_key, offer_id, asset_id, seller_id, service, unit, settlement_asset,
              remaining, status, window_start, window_end, created_at, offer)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz,
                   $11::timestamptz, $12::timestamptz, $13::jsonb)`,
          [
            this.projectionKey,
            offer.id,
            offer.assetId,
            offer.sellerId,
            offer.service,
            offer.unit,
            offer.unitPrice.settlementAsset,
            offer.remaining,
            offer.status,
            offer.windowStart,
            offer.windowEnd,
            offer.createdAt,
            JSON.stringify(offer),
          ],
        );
      }

      await client.query(
        `INSERT INTO ${this.metaTable} (projection_key, revision, refreshed_at)
         VALUES ($1, $2, now())
         ON CONFLICT (projection_key)
         DO UPDATE SET revision = EXCLUDED.revision, refreshed_at = now()`,
        [this.projectionKey, snapshot.revision],
      );

      await client.query('COMMIT');
      began = false;
      return {
        revision: snapshot.revision,
        assetCount: snapshot.assets.length,
        offerCount: snapshot.offers.length,
      };
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getRevision() {
    const result = await this.pool.query(
      `SELECT revision FROM ${this.metaTable} WHERE projection_key = $1`,
      [this.projectionKey],
    );
    if (result.rows.length === 0) return null;
    return safeRevision(result.rows[0].revision, 'projection revision');
  }

  async search({ filters, expectedRevision = null, offset, limit }) {
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      throw new TypeError('filters must be an object');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');

    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      began = true;

      const meta = await client.query(
        `SELECT revision FROM ${this.metaTable} WHERE projection_key = $1`,
        [this.projectionKey],
      );
      if (meta.rows.length === 0) {
        throw new CapacityProjectionError('PROJECTION_EMPTY', 'capacity projection has not been refreshed yet');
      }
      const revision = safeRevision(meta.rows[0].revision, 'projection revision');
      if (expectedRevision !== null && revision !== expectedRevision) {
        throw new CapacityQueryError('STALE_CURSOR', 'capacity projection advanced after the previous page; restart the query', {
          cursorRevision: expectedRevision,
          actualRevision: revision,
        });
      }

      const params = [this.projectionKey];
      const where = ['o.projection_key = $1', 'a.projection_key = o.projection_key', 'a.asset_id = o.asset_id'];
      const bind = (value) => {
        params.push(value);
        return `$${params.length}`;
      };

      if (filters.service !== null) where.push(`o.service = ${bind(filters.service)}`);
      if (filters.unit !== null) where.push(`o.unit = ${bind(filters.unit)}`);
      if (filters.settlementAsset !== null) where.push(`o.settlement_asset = ${bind(filters.settlementAsset)}`);
      if (filters.sellerId !== null) where.push(`o.seller_id = ${bind(filters.sellerId)}`);
      if (filters.assetType !== null) where.push(`a.asset_type = ${bind(filters.assetType)}`);
      if (filters.status !== null) where.push(`o.status = ${bind(filters.status)}`);
      if (filters.minRemaining !== null) where.push(`o.remaining >= ${bind(filters.minRemaining)}`);
      if (filters.capabilities.length > 0) where.push(`a.capabilities @> ${bind(JSON.stringify(filters.capabilities))}::jsonb`);
      if (filters.availableAt !== null) {
        const instant = bind(filters.availableAt);
        where.push(`(o.window_start IS NULL OR o.window_start <= ${instant}::timestamptz)`);
        where.push(`(o.window_end IS NULL OR o.window_end > ${instant}::timestamptz)`);
      }

      const fromWhere = `FROM ${this.offersTable} o, ${this.assetsTable} a WHERE ${where.join(' AND ')}`;
      const count = await client.query(`SELECT COUNT(*) AS total ${fromWhere}`, params);
      const total = Number(count.rows[0]?.total ?? 0);
      if (!Number.isSafeInteger(total) || total < 0) throw new CapacityProjectionError('CORRUPT_PROJECTION', 'projection count is invalid');
      if (offset > total) throw new CapacityQueryError('INVALID_CURSOR', 'cursor offset exceeds the current result set');

      const pageParams = [...params, offset, limit + 1];
      const offsetParam = `$${pageParams.length - 1}`;
      const limitParam = `$${pageParams.length}`;
      const rows = await client.query(
        `SELECT o.offer, a.asset
           ${fromWhere}
          ORDER BY o.created_at ASC, o.offer_id ASC
          OFFSET ${offsetParam}
          LIMIT ${limitParam}`,
        pageParams,
      );

      await client.query('COMMIT');
      began = false;
      return {
        revision,
        items: rows.rows.slice(0, limit).map((row) => ({
          offer: json(row.offer),
          asset: json(row.asset),
        })),
        hasMore: rows.rows.length > limit,
      };
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #captureMarketSnapshot(market) {
    for (let attempt = 1; attempt <= this.maxSnapshotRetries; attempt += 1) {
      const before = await market.getRevision();
      const [assets, offers] = await Promise.all([
        market.listAssets(),
        market.listOffers({ status: null }),
      ]);
      const after = await market.getRevision();
      if (before === after) return { revision: after, assets, offers };
    }
    throw new CapacityProjectionError('READ_SNAPSHOT_CONFLICT', 'market changed repeatedly while refreshing the capacity projection; retry refresh');
  }
}
