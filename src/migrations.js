const clone = (value) => structuredClone(value);

export class SnapshotMigrationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SnapshotMigrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new SnapshotMigrationError(code, message, details);
}

function schemaVersion(snapshot) {
  const version = snapshot?.schemaVersion;
  invariant(Number.isSafeInteger(version) && version >= 1, 'INVALID_SCHEMA_VERSION', 'snapshot schemaVersion must be a positive safe integer');
  return version;
}

/**
 * Ordered one-version-at-a-time migration registry.
 *
 * Every migration is explicit: N -> N+1. Skipping versions is rejected so a
 * deployment can reason about exactly which transformations ran and attach
 * tests/rollback policy to each step.
 */
export class SnapshotMigrationRegistry {
  constructor({ currentVersion }) {
    invariant(Number.isSafeInteger(currentVersion) && currentVersion >= 1, 'INVALID_CONFIGURATION', 'currentVersion must be a positive safe integer');
    this.currentVersion = currentVersion;
    this.steps = new Map();
  }

  register(fromVersion, migrate) {
    invariant(Number.isSafeInteger(fromVersion) && fromVersion >= 1, 'INVALID_CONFIGURATION', 'fromVersion must be a positive safe integer');
    invariant(fromVersion < this.currentVersion, 'INVALID_CONFIGURATION', 'migration source must be older than currentVersion');
    invariant(typeof migrate === 'function', 'INVALID_CONFIGURATION', 'migration must be a function');
    invariant(!this.steps.has(fromVersion), 'MIGRATION_EXISTS', `migration already registered for schema version ${fromVersion}`);
    this.steps.set(fromVersion, migrate);
    return this;
  }

  async migrate(snapshot, context = {}) {
    invariant(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'INVALID_SNAPSHOT', 'snapshot must be an object');
    let current = clone(snapshot);
    let version = schemaVersion(current);

    invariant(version <= this.currentVersion, 'UNSUPPORTED_SCHEMA', `snapshot schema version ${version} is newer than supported version ${this.currentVersion}`, {
      snapshotVersion: version,
      currentVersion: this.currentVersion,
    });

    while (version < this.currentVersion) {
      const step = this.steps.get(version);
      invariant(step, 'MIGRATION_MISSING', `no migration registered from schema version ${version}`, {
        fromVersion: version,
        targetVersion: this.currentVersion,
      });

      const input = clone(current);
      const migrated = await step(input, {
        ...clone(context),
        fromVersion: version,
        toVersion: version + 1,
      });
      invariant(migrated && typeof migrated === 'object' && !Array.isArray(migrated), 'INVALID_MIGRATION_RESULT', `migration ${version} -> ${version + 1} must return a snapshot object`);
      const migratedVersion = schemaVersion(migrated);
      invariant(migratedVersion === version + 1, 'INVALID_MIGRATION_RESULT', `migration ${version} -> ${version + 1} returned schema version ${migratedVersion}`);

      current = clone(migrated);
      version = migratedVersion;
    }

    return current;
  }
}

/**
 * Store decorator that migrates historical snapshots on load.
 *
 * It intentionally does not write migrated state during `load()`: startup must
 * remain a read operation. The next successful domain mutation persists the
 * current schema through the wrapped store's normal transactional/CAS path.
 */
export class MigratingSnapshotStore {
  constructor(store, registry, { context = {} } = {}) {
    invariant(store && typeof store.load === 'function' && typeof store.save === 'function', 'INVALID_CONFIGURATION', 'store must implement load() and save()');
    invariant(registry instanceof SnapshotMigrationRegistry, 'INVALID_CONFIGURATION', 'registry must be a SnapshotMigrationRegistry');
    this.store = store;
    this.registry = registry;
    this.context = clone(context);
  }

  async load() {
    const snapshot = await this.store.load();
    if (snapshot === null || snapshot === undefined) return null;
    return this.registry.migrate(snapshot, this.context);
  }

  async save(snapshot, options = {}) {
    invariant(schemaVersion(snapshot) === this.registry.currentVersion, 'INVALID_SCHEMA_VERSION', `store only accepts current schema version ${this.registry.currentVersion}`);
    return this.store.save(snapshot, options);
  }
}
