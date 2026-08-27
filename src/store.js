import fs from 'node:fs/promises';
import path from 'node:path';

const clone = (value) => (value === null || value === undefined ? value : structuredClone(value));

export class StoreConflictError extends Error {
  constructor(message = 'store revision changed') {
    super(message);
    this.name = 'StoreConflictError';
    this.code = 'STORE_CONFLICT';
  }
}

/**
 * Snapshot-store contract used by the clearinghouse:
 *
 * - `load()` returns the latest committed snapshot or null.
 * - `save(snapshot, { expectedRevision })` atomically commits only when the
 *   current persisted revision matches `expectedRevision`.
 * - both methods may perform asynchronous I/O.
 *
 * Production adapters should implement the compare-and-swap check and write in
 * one database transaction. The memory adapter is useful for tests and local
 * composition.
 */
export class MemorySnapshotStore {
  constructor(initialState = null) {
    this.state = clone(initialState);
  }

  async load() {
    return clone(this.state);
  }

  async save(snapshot, { expectedRevision = null } = {}) {
    const currentRevision = this.state?.revision ?? 0;
    if (expectedRevision !== null && currentRevision !== expectedRevision) throw new StoreConflictError();
    this.state = clone(snapshot);
  }
}

/**
 * Atomic local-development store. The rename prevents torn snapshots, but this
 * adapter is intentionally single-writer. Production stores should provide a
 * transactional compare-and-swap boundary around `revision`.
 */
export class JsonFileSnapshotStore {
  constructor(statePath) {
    if (!statePath) throw new TypeError('statePath is required');
    this.statePath = statePath;
  }

  async load() {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(snapshot, { expectedRevision = null } = {}) {
    if (expectedRevision !== null) {
      const current = await this.load();
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) throw new StoreConflictError();
    }

    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.statePath);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
