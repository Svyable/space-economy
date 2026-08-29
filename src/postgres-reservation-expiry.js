import { CURRENT_SCHEMA_VERSION } from './schema.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_BATCH = 1000;

export class PostgresReservationExpiryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PostgresReservationExpiryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a simple PostgreSQL identifier`);
  }
  return value;
}

function indexIdentifier(table) {
  const value = `${table}_due_idx`;
  if (value.length > 63) throw new TypeError('projectionTable is too long to derive a PostgreSQL index name');
  return value;
}

function postgresText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  if (value.includes('\u0000')) throw new TypeError(`${field} must not contain NUL`);
  return value;
}

function revision(value, field) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return number;
}

function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TypeError(`${field} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

/**
 * Indexed PostgreSQL source for ReservationExpiryWorker.
 *
 * The projection is derived from the authoritative PostgresSnapshotStore row.
 * refresh() rebuilds candidate rows transactionally at one source revision;
 * listDue() then performs an indexed deadline scan without loading the ledger or
 * issuing one getOrder() call per historical reservation.
 *
 * Projection lag is safe: ReservationExpiryWorker still executes the kernel's
 * expireOrder() transition with expectedVersion + stable idempotency, so stale
 * rows become attributable race skips rather than unsafe state changes.
 */
export class PostgresReservationExpirySource {
  constructor(pool, {
    schema = 'public',
    snapshotTable = 'space_economy_snapshots',
    projectionTable = 'space_economy_due_reservations',
    metaTable = 'space_economy_due_reservation_meta',
    storeKey = 'default',
  } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('pool must provide query() and connect()');
    }
    this.pool = pool;
    this.schema = identifier(schema, 'schema');
    this.snapshotTable = identifier(snapshotTable, 'snapshotTable');
    this.projectionTable = identifier(projectionTable, 'projectionTable');
    this.metaTable = identifier(metaTable, 'metaTable');
    this.indexName = indexIdentifier(this.projectionTable);
    this.storeKey = postgresText(storeKey, 'storeKey');
    this.qualifiedSnapshot = `"${this.schema}"."${this.snapshotTable}"`;
    this.qualifiedProjection = `"${this.schema}"."${this.projectionTable}"`;
    this.qualifiedMeta = `"${this.schema}"."${this.metaTable}"`;
    this.lockKey = JSON.stringify([
      'reservation-expiry-projection',
      this.schema,
      this.projectionTable,
      this.storeKey,
    ]);
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedProjection} (
        store_key TEXT NOT NULL,
        order_id TEXT NOT NULL,
        funding_due_at TIMESTAMPTZ NOT NULL,
        version BIGINT NOT NULL CHECK (version > 0),
        PRIMARY KEY (store_key, order_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS "${this.indexName}"
      ON ${this.qualifiedProjection} (store_key, funding_due_at, order_id)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedMeta} (
        store_key TEXT PRIMARY KEY,
        source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async refresh() {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      began = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.lockKey]);

      const sourceResult = await client.query(
        `SELECT revision, snapshot->>'schemaVersion' AS schema_version
           FROM ${this.qualifiedSnapshot}
          WHERE store_key = $1`,
        [this.storeKey],
      );
      const sourceRevision = sourceResult.rows.length === 0
        ? 0
        : revision(sourceResult.rows[0].revision, 'snapshot revision');
      const sourceSchemaVersion = sourceResult.rows.length === 0
        ? CURRENT_SCHEMA_VERSION
        : positiveInteger(sourceResult.rows[0].schema_version, 'snapshot schemaVersion');

      if (sourceSchemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new PostgresReservationExpiryError(
          'UNSUPPORTED_EXPIRY_PROJECTION_SCHEMA',
          'authoritative snapshot schema is newer than this expiry projection understands',
          { sourceSchemaVersion, supportedSchemaVersion: CURRENT_SCHEMA_VERSION },
        );
      }

      const metaResult = await client.query(
        `SELECT source_revision FROM ${this.qualifiedMeta} WHERE store_key = $1 FOR UPDATE`,
        [this.storeKey],
      );
      const projectedRevision = metaResult.rows.length === 0
        ? null
        : revision(metaResult.rows[0].source_revision, 'projection revision');

      if (projectedRevision !== null && projectedRevision > sourceRevision) {
        throw new PostgresReservationExpiryError(
          'EXPIRY_PROJECTION_REGRESSION',
          'authoritative snapshot revision is older than the expiry projection',
          { projectedRevision, sourceRevision },
        );
      }

      await client.query(`DELETE FROM ${this.qualifiedProjection} WHERE store_key = $1`, [this.storeKey]);

      let candidateCount = 0;
      if (sourceResult.rows.length !== 0) {
        const inserted = await client.query(`
          INSERT INTO ${this.qualifiedProjection} (store_key, order_id, funding_due_at, version)
          SELECT
            $1,
            order_json->>'id',
            (order_json->>'fundingDueAt')::timestamptz,
            (order_json->>'version')::bigint
          FROM ${this.qualifiedSnapshot} snapshot_row
          CROSS JOIN LATERAL jsonb_array_elements(snapshot_row.snapshot->'orders') AS order_json
          WHERE snapshot_row.store_key = $1
            AND order_json->>'status' = 'reserved'
            AND order_json->>'fundingDueAt' IS NOT NULL
        `, [this.storeKey]);
        candidateCount = inserted.rowCount ?? 0;
      }

      await client.query(`
        INSERT INTO ${this.qualifiedMeta} (store_key, source_revision, refreshed_at)
        VALUES ($1, $2, now())
        ON CONFLICT (store_key) DO UPDATE
          SET source_revision = EXCLUDED.source_revision,
              refreshed_at = EXCLUDED.refreshed_at
      `, [this.storeKey, sourceRevision]);

      await client.query('COMMIT');
      began = false;
      return { sourceRevision, sourceSchemaVersion, candidateCount };
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listDue({ now, limit }) {
    const observedAt = timestamp(now, 'now');
    const maxItems = positiveInteger(limit, 'limit', MAX_BATCH);
    const result = await this.pool.query(`
      SELECT order_id, funding_due_at, version
      FROM ${this.qualifiedProjection}
      WHERE store_key = $1
        AND funding_due_at <= $2::timestamptz
      ORDER BY funding_due_at ASC, order_id ASC
      LIMIT $3
    `, [this.storeKey, observedAt, maxItems]);

    return result.rows.map((row) => ({
      id: postgresText(row.order_id, 'projected order_id'),
      fundingDueAt: timestamp(row.funding_due_at, 'projected funding_due_at'),
      version: positiveInteger(row.version, 'projected version'),
    }));
  }

  async getStatus() {
    const meta = await this.pool.query(
      `SELECT source_revision, refreshed_at FROM ${this.qualifiedMeta} WHERE store_key = $1`,
      [this.storeKey],
    );
    const count = await this.pool.query(
      `SELECT COUNT(*)::bigint AS candidate_count FROM ${this.qualifiedProjection} WHERE store_key = $1`,
      [this.storeKey],
    );
    return {
      sourceRevision: meta.rows.length === 0 ? null : revision(meta.rows[0].source_revision, 'projection revision'),
      refreshedAt: meta.rows.length === 0 ? null : timestamp(meta.rows[0].refreshed_at, 'refreshed_at'),
      candidateCount: revision(count.rows[0]?.candidate_count ?? 0, 'candidate count'),
    };
  }
}
