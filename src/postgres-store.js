import { StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a simple PostgreSQL identifier`);
  }
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

function decodeSnapshot(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return clone(value);
}

/**
 * PostgreSQL-backed snapshot store with transactionally enforced revision CAS.
 *
 * This module intentionally imports no database driver. Pass a pool compatible
 * with node-postgres' `query()` + `connect()` interface (or an equivalent
 * adapter), keeping the clearinghouse package at zero runtime dependencies.
 */
export class PostgresSnapshotStore {
  constructor(pool, {
    schema = 'public',
    table = 'space_economy_snapshots',
    storeKey = 'default',
  } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('pool must provide query() and connect()');
    }
    this.pool = pool;
    this.schema = identifier(schema, 'schema');
    this.table = identifier(table, 'table');
    this.storeKey = postgresText(storeKey, 'storeKey');
    this.qualifiedTable = `"${this.schema}"."${this.table}"`;
    this.lockKey = JSON.stringify([this.schema, this.table, this.storeKey]);
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
        store_key TEXT PRIMARY KEY,
        revision BIGINT NOT NULL CHECK (revision >= 0),
        snapshot JSONB NOT NULL CHECK (snapshot ? 'revision'),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((snapshot->>'revision')::BIGINT = revision)
      )
    `);
  }

  async load() {
    const result = await this.pool.query(
      `SELECT snapshot FROM ${this.qualifiedTable} WHERE store_key = $1`,
      [this.storeKey],
    );
    if (result.rows.length === 0) return null;
    return decodeSnapshot(result.rows[0].snapshot);
  }

  async save(snapshot, { expectedRevision = null } = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('snapshot must be an object');
    }
    const nextRevision = revision(snapshot.revision, 'snapshot.revision');
    const expected = expectedRevision === null ? null : revision(expectedRevision, 'expectedRevision');
    const serialized = JSON.stringify(snapshot);
    const client = await this.pool.connect();
    let began = false;

    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.lockKey]);
      const currentResult = await client.query(
        `SELECT revision FROM ${this.qualifiedTable} WHERE store_key = $1 FOR UPDATE`,
        [this.storeKey],
      );
      const currentRevision = currentResult.rows.length === 0
        ? 0
        : revision(currentResult.rows[0].revision, 'persisted revision');

      if (expected !== null && currentRevision !== expected) throw new StoreConflictError();

      if (currentResult.rows.length === 0) {
        await client.query(
          `INSERT INTO ${this.qualifiedTable} (store_key, revision, snapshot) VALUES ($1, $2, $3::jsonb)`,
          [this.storeKey, nextRevision, serialized],
        );
      } else {
        await client.query(
          `UPDATE ${this.qualifiedTable}
             SET revision = $2, snapshot = $3::jsonb, updated_at = now()
           WHERE store_key = $1`,
          [this.storeKey, nextRevision, serialized],
        );
      }

      await client.query('COMMIT');
      began = false;
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
