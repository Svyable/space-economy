import fs from 'node:fs';
import path from 'node:path';

const clone = (value) => (value === null || value === undefined ? value : structuredClone(value));

export class StoreConflictError extends Error {
  constructor(message = 'store revision changed') {
    super(message);
    this.name = 'StoreConflictError';
    this.code = 'STORE_CONFLICT';
  }
}

export class MemorySnapshotStore {
  constructor(initialState = null) {
    this.state = clone(initialState);
  }

  load() {
    return clone(this.state);
  }

  save(snapshot, { expectedRevision = null } = {}) {
    const currentRevision = this.state?.revision ?? 0;
    if (expectedRevision !== null && currentRevision !== expectedRevision) throw new StoreConflictError();
    this.state = clone(snapshot);
  }
}

/**
 * Atomic local-development store. The rename prevents torn snapshots, but this
 * adapter is intentionally single-writer. Production stores should provide a
 * real compare-and-swap/transaction boundary around `revision`.
 */
export class JsonFileSnapshotStore {
  constructor(statePath) {
    if (!statePath) throw new TypeError('statePath is required');
    this.statePath = statePath;
  }

  load() {
    if (!fs.existsSync(this.statePath)) return null;
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }

  save(snapshot, { expectedRevision = null } = {}) {
    if (fs.existsSync(this.statePath) && expectedRevision !== null) {
      const current = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if ((current.revision ?? 0) !== expectedRevision) throw new StoreConflictError();
    } else if (!fs.existsSync(this.statePath) && expectedRevision !== null && expectedRevision !== 0) {
      throw new StoreConflictError();
    }

    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }
}
