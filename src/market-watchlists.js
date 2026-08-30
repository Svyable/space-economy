import { randomUUID } from 'node:crypto';
import { sha256Canonical } from './canonical-json.js';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const WATCH_SCHEMA_VERSION = 1;
const MAX_PENDING_TRIGGERS = 100;
const MAX_BATCH = 100;
const WATCH_KINDS = new Set(['capacity-available', 'rfq-opportunity-available', 'liquidity-balance']);

export class MarketWatchError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MarketWatchError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MarketWatchError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return nonEmptyString(value, field);
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_REQUEST', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function plainObject(value, field) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `${field} must be an object`);
  return value;
}

function validateMetadata(value) {
  const metadata = value ?? {};
  plainObject(metadata, 'metadata');
  try {
    sha256Canonical(metadata);
  } catch (error) {
    throw new MarketWatchError('INVALID_REQUEST', `metadata must be canonical JSON: ${error.message}`);
  }
  return clone(metadata);
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    invariant(allowed.has(key), 'INVALID_REQUEST', `${field}.${key} is not supported`);
  }
}

function normalizeCapacityQuery(value = {}) {
  const query = plainObject(value, 'query');
  assertAllowedKeys(query, new Set([
    'service', 'unit', 'settlementAsset', 'sellerId', 'assetType', 'capabilities',
    'minRemaining', 'availableAt', 'status',
  ]), 'query');
  const normalized = {};
  for (const field of ['service', 'unit', 'settlementAsset', 'sellerId', 'assetType']) {
    const candidate = optionalString(query[field], `query.${field}`);
    if (candidate !== null) normalized[field] = candidate;
  }
  if (query.capabilities !== undefined) {
    invariant(Array.isArray(query.capabilities) && query.capabilities.length <= 20, 'INVALID_REQUEST', 'query.capabilities must be an array of at most 20 values');
    normalized.capabilities = [...new Set(query.capabilities.map((item, index) => nonEmptyString(item, `query.capabilities[${index}]`)))].sort();
  }
  if (query.minRemaining !== undefined) normalized.minRemaining = positiveInteger(query.minRemaining, 'query.minRemaining');
  if (query.availableAt !== undefined && query.availableAt !== null) normalized.availableAt = timestamp(query.availableAt, 'query.availableAt');
  if (query.status !== undefined) {
    invariant(['open', 'filled', 'all'].includes(query.status), 'INVALID_REQUEST', 'query.status must be open, filled, or all');
    normalized.status = query.status;
  }
  return normalized;
}

function normalizeOpportunityQuery(value = {}) {
  const query = plainObject(value, 'query');
  assertAllowedKeys(query, new Set(['service', 'settlementAsset']), 'query');
  const normalized = {};
  for (const field of ['service', 'settlementAsset']) {
    const candidate = optionalString(query[field], `query.${field}`);
    if (candidate !== null) normalized[field] = candidate;
  }
  return normalized;
}

function normalizeSignedInteger(value, field) {
  invariant(typeof value === 'string' && /^-?[0-9]+$/.test(value), 'INVALID_REQUEST', `${field} must be a signed integer string`);
  return BigInt(value).toString();
}

function normalizeLiquidityInput(input) {
  const market = plainObject(input?.market, 'market');
  assertAllowedKeys(market, new Set(['service', 'unit', 'settlementAsset']), 'market');
  invariant(['lte', 'gte'].includes(input?.operator), 'INVALID_REQUEST', 'operator must be lte or gte');
  return {
    market: {
      service: nonEmptyString(market.service, 'market.service'),
      unit: nonEmptyString(market.unit, 'market.unit'),
      settlementAsset: nonEmptyString(market.settlementAsset, 'market.settlementAsset'),
    },
    operator: input.operator,
    threshold: normalizeSignedInteger(input?.threshold, 'threshold'),
  };
}

function normalizeWatchInput(input) {
  plainObject(input, 'watch');
  invariant(WATCH_KINDS.has(input.kind), 'INVALID_REQUEST', 'unsupported watch kind');
  const base = {
    kind: input.kind,
    name: input.name == null ? null : nonEmptyString(input.name, 'name'),
    metadata: validateMetadata(input.metadata),
  };
  if (input.kind === 'capacity-available') return { ...base, query: normalizeCapacityQuery(input.query) };
  if (input.kind === 'rfq-opportunity-available') return { ...base, query: normalizeOpportunityQuery(input.query) };
  return { ...base, ...normalizeLiquidityInput(input) };
}

function normalizeContext(context) {
  invariant(typeof context?.actorId === 'string' && context.actorId.trim().length > 0, 'UNAUTHENTICATED', 'actor identity is required');
  const actorId = context.actorId.trim();
  const idempotencyKey = context?.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    invariant(typeof idempotencyKey === 'string' && idempotencyKey.length >= 1 && idempotencyKey.length <= 255, 'INVALID_REQUEST', 'idempotencyKey must be 1-255 characters');
  }
  return { actorId, idempotencyKey };
}

function sourceCursor(evidence) {
  if (evidence.kind === 'capacity-available') return { marketRevision: evidence.revision };
  return { marketRevision: evidence.marketRevision, rfqRevision: evidence.rfqRevision };
}

function errorSummary(error) {
  const result = {
    code: typeof error?.code === 'string' ? error.code : 'WATCH_EVALUATION_ERROR',
    detail: error instanceof Error ? error.message : String(error),
  };
  if (error?.details !== undefined) result.details = clone(error.details);
  return result;
}

/**
 * Persistent, edge-triggered watches over read-only market evidence.
 *
 * This module deliberately contains no timer and sends no notifications. A
 * deployment scheduler invokes evaluateWatch() or runOnce(), then delivers and
 * acknowledges durable trigger records through its own notification boundary.
 */
export class MarketWatchRegistry {
  constructor({
    capacityDirectory = null,
    rfqOpportunityDirectory = null,
    marketLiquidityDirectory = null,
    statePath = null,
    store = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    maxSnapshotRetries = 3,
  } = {}) {
    if (capacityDirectory !== null) {
      invariant(typeof capacityDirectory?.find === 'function', 'INVALID_CONFIGURATION', 'capacityDirectory must provide find()');
    }
    if (rfqOpportunityDirectory !== null) {
      invariant(typeof rfqOpportunityDirectory?.listOpportunities === 'function', 'INVALID_CONFIGURATION', 'rfqOpportunityDirectory must provide listOpportunities()');
    }
    if (marketLiquidityDirectory !== null) {
      invariant(typeof marketLiquidityDirectory?.snapshot === 'function', 'INVALID_CONFIGURATION', 'marketLiquidityDirectory must provide snapshot()');
    }
    invariant(!(statePath && store), 'INVALID_CONFIGURATION', 'provide either statePath or store, not both');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');

    this.capacityDirectory = capacityDirectory;
    this.rfqOpportunityDirectory = rfqOpportunityDirectory;
    this.marketLiquidityDirectory = marketLiquidityDirectory;
    this.store = store ?? (statePath ? new JsonFileSnapshotStore(statePath) : new MemorySnapshotStore());
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.maxSnapshotRetries = maxSnapshotRetries;
    this.commandQueue = Promise.resolve();
    this.#initializeEmpty();
    this.initialization = this.#loadPersisted();
    this.initialization.catch(() => {});
  }

  static async open(options = {}) {
    return new MarketWatchRegistry(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  createWatch(input, context) {
    const normalized = normalizeWatchInput(input);
    return this.#command('watch.create', context, normalized, ({ actorId }) => {
      this.#assertSourceAvailable(normalized.kind);
      const now = this.#now();
      const watch = {
        id: this.idGenerator(),
        ownerId: actorId,
        ...clone(normalized),
        status: 'active',
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastObservation: null,
        lastTriggeredAt: null,
        pendingTriggers: [],
      };
      this.watches.set(watch.id, watch);
      return watch;
    });
  }

  getWatch(watchId, context) {
    return this.#read(() => {
      const { actorId } = normalizeContext(context);
      const watch = this.#watch(watchId);
      invariant(watch.ownerId === actorId, 'FORBIDDEN', 'only the watch owner may read it');
      return clone(watch);
    });
  }

  listWatches(context, { status = null } = {}) {
    return this.#read(() => {
      const { actorId } = normalizeContext(context);
      if (status !== null) invariant(['active', 'disabled'].includes(status), 'INVALID_REQUEST', 'status must be active, disabled, or null');
      return [...this.watches.values()]
        .filter((watch) => watch.ownerId === actorId && (status === null || watch.status === status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((watch) => clone(watch));
    });
  }

  setWatchEnabled(watchId, enabled, context) {
    invariant(typeof enabled === 'boolean', 'INVALID_REQUEST', 'enabled must be boolean');
    return this.#command('watch.enabled.set', context, { watchId, enabled }, ({ actorId }) => {
      const watch = this.#watch(watchId);
      invariant(watch.ownerId === actorId, 'FORBIDDEN', 'only the watch owner may change it');
      const next = enabled ? 'active' : 'disabled';
      if (watch.status === next) return watch;
      const now = this.#now();
      watch.status = next;
      watch.version += 1;
      watch.updatedAt = now;
      if (enabled) watch.lastObservation = null;
      return watch;
    });
  }

  evaluateWatch(watchId, context) {
    const run = async () => {
      await this.initialization;
      const { actorId } = normalizeContext(context);
      const initial = this.#watch(watchId);
      invariant(initial.ownerId === actorId, 'FORBIDDEN', 'only the watch owner may evaluate it');
      invariant(initial.status === 'active', 'WATCH_DISABLED', 'watch is disabled');
      const evidence = await this.#observe(initial);
      return this.#recordObservation(watchId, actorId, evidence);
    };
    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  listPendingTriggers(context, { limit = 100 } = {}) {
    return this.#read(() => {
      const { actorId } = normalizeContext(context);
      const bounded = positiveInteger(limit, 'limit');
      invariant(bounded <= 500, 'INVALID_REQUEST', 'limit may not exceed 500');
      const triggers = [];
      for (const watch of this.watches.values()) {
        if (watch.ownerId !== actorId) continue;
        for (const trigger of watch.pendingTriggers) triggers.push(clone(trigger));
      }
      return triggers
        .sort((left, right) => left.triggeredAt.localeCompare(right.triggeredAt) || left.id.localeCompare(right.id))
        .slice(0, bounded);
    });
  }

  acknowledgeTrigger(watchId, triggerId, context) {
    return this.#command('watch.trigger.acknowledge', context, { watchId, triggerId }, ({ actorId }) => {
      const watch = this.#watch(watchId);
      invariant(watch.ownerId === actorId, 'FORBIDDEN', 'only the watch owner may acknowledge its trigger');
      const index = watch.pendingTriggers.findIndex((trigger) => trigger.id === triggerId);
      invariant(index >= 0, 'NOT_FOUND', 'pending trigger not found');
      const [trigger] = watch.pendingTriggers.splice(index, 1);
      watch.version += 1;
      watch.updatedAt = this.#now();
      return { watchId, triggerId: trigger.id, acknowledgedAt: watch.updatedAt };
    });
  }

  /**
   * Trusted scheduler surface. It evaluates active watches sequentially and
   * returns per-watch failures rather than hiding them. Deployments must apply
   * their own authorization and notification-routing policy around this method.
   */
  async runOnce({ limit = 100, ownerId = null } = {}) {
    await this.initialization;
    await this.commandQueue;
    const bounded = positiveInteger(limit, 'limit');
    invariant(bounded <= MAX_BATCH, 'INVALID_REQUEST', `limit may not exceed ${MAX_BATCH}`);
    const normalizedOwner = optionalString(ownerId, 'ownerId');
    const selected = [...this.watches.values()]
      .filter((watch) => watch.status === 'active' && (normalizedOwner === null || watch.ownerId === normalizedOwner))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, bounded)
      .map((watch) => ({ id: watch.id, ownerId: watch.ownerId }));

    const evaluations = [];
    const failures = [];
    for (const item of selected) {
      try {
        evaluations.push(await this.evaluateWatch(item.id, { actorId: item.ownerId }));
      } catch (error) {
        failures.push({ watchId: item.id, ownerId: item.ownerId, error: errorSummary(error) });
      }
    }
    return { evaluated: evaluations.length, failed: failures.length, evaluations, failures };
  }

  getRevision() {
    return this.#read(() => this.revision);
  }

  async #observe(watch) {
    if (watch.kind === 'capacity-available') {
      this.#assertSourceAvailable(watch.kind);
      const page = await this.capacityDirectory.find({ ...clone(watch.query), limit: 1 });
      invariant(Number.isSafeInteger(page?.revision) && page.revision >= 0 && Array.isArray(page.items), 'INVALID_SOURCE_RESPONSE', 'capacityDirectory returned an invalid page');
      return {
        kind: watch.kind,
        active: page.items.length > 0,
        revision: page.revision,
        match: page.items[0] ?? null,
      };
    }

    if (watch.kind === 'rfq-opportunity-available') {
      this.#assertSourceAvailable(watch.kind);
      const result = await this.rfqOpportunityDirectory.listOpportunities({
        sellerId: watch.ownerId,
        ...clone(watch.query),
        limit: 1,
      });
      invariant(Number.isSafeInteger(result?.rfqRevision) && result.rfqRevision >= 0
        && Number.isSafeInteger(result?.marketRevision) && result.marketRevision >= 0
        && Array.isArray(result.opportunities), 'INVALID_SOURCE_RESPONSE', 'rfqOpportunityDirectory returned an invalid result');
      return {
        kind: watch.kind,
        active: result.opportunities.length > 0,
        rfqRevision: result.rfqRevision,
        marketRevision: result.marketRevision,
        total: Number.isSafeInteger(result.total) ? result.total : result.opportunities.length,
        opportunity: result.opportunities[0] ?? null,
      };
    }

    this.#assertSourceAvailable(watch.kind);
    const snapshot = await this.marketLiquidityDirectory.snapshot({
      service: watch.market.service,
      settlementAsset: watch.market.settlementAsset,
      limit: 500,
    });
    invariant(Number.isSafeInteger(snapshot?.rfqRevision) && snapshot.rfqRevision >= 0
      && Number.isSafeInteger(snapshot?.marketRevision) && snapshot.marketRevision >= 0
      && Array.isArray(snapshot.markets), 'INVALID_SOURCE_RESPONSE', 'marketLiquidityDirectory returned an invalid snapshot');
    const row = snapshot.markets.find((candidate) => candidate.service === watch.market.service
      && candidate.unit === watch.market.unit
      && candidate.settlementAsset === watch.market.settlementAsset) ?? null;
    const balance = normalizeSignedInteger(row?.constrainedBalance ?? '0', 'constrainedBalance');
    const left = BigInt(balance);
    const right = BigInt(watch.threshold);
    const active = watch.operator === 'lte' ? left <= right : left >= right;
    return {
      kind: watch.kind,
      active,
      rfqRevision: snapshot.rfqRevision,
      marketRevision: snapshot.marketRevision,
      balance,
      market: row === null ? null : clone(row),
      operator: watch.operator,
      threshold: watch.threshold,
    };
  }

  async #recordObservation(watchId, ownerId, evidence) {
    const evidenceDigest = sha256Canonical(evidence);
    let lastConflict = null;
    for (let attempt = 0; attempt < this.maxSnapshotRetries; attempt += 1) {
      const before = this.#snapshot();
      const expectedRevision = this.revision;
      try {
        const watch = this.#watch(watchId);
        invariant(watch.ownerId === ownerId, 'FORBIDDEN', 'only the watch owner may evaluate it');
        invariant(watch.status === 'active', 'WATCH_DISABLED', 'watch is disabled');
        const wasActive = watch.lastObservation?.active === true;
        const triggered = evidence.active === true && !wasActive;
        const unchanged = !triggered
          && watch.lastObservation?.active === (evidence.active === true)
          && watch.lastObservation?.evidenceDigest === evidenceDigest;
        if (unchanged) {
          return { watch: clone(watch), triggered: false, trigger: null, evidence: clone(evidence) };
        }
        if (triggered) {
          invariant(watch.pendingTriggers.length < MAX_PENDING_TRIGGERS, 'TRIGGER_BACKLOG_FULL', 'watch has too many unacknowledged triggers');
        }

        const now = this.#now();
        let trigger = null;
        if (triggered) {
          trigger = {
            id: this.idGenerator(),
            watchId: watch.id,
            ownerId: watch.ownerId,
            kind: watch.kind,
            triggeredAt: now,
            evidenceDigest,
            sourceCursor: sourceCursor(evidence),
            evidence: clone(evidence),
          };
          watch.pendingTriggers.push(trigger);
          watch.lastTriggeredAt = now;
        }
        watch.lastObservation = {
          active: evidence.active === true,
          observedAt: now,
          evidenceDigest,
          sourceCursor: sourceCursor(evidence),
        };
        watch.version += 1;
        watch.updatedAt = now;
        this.revision += 1;
        await this.store.save(this.#snapshot(), { expectedRevision });
        return {
          watch: clone(watch),
          triggered,
          trigger: trigger === null ? null : clone(trigger),
          evidence: clone(evidence),
        };
      } catch (error) {
        this.#restore(before);
        if (!(error instanceof StoreConflictError) && error?.code !== 'STORE_CONFLICT') throw error;
        lastConflict = error;
        const latest = await this.store.load();
        this.#restore(latest ?? this.#emptySnapshot());
      }
    }
    throw new MarketWatchError('STORE_CONFLICT', 'watch state kept changing during evaluation', {
      cause: lastConflict?.message,
    });
  }

  #command(operation, rawContext, input, mutate) {
    const run = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      const fingerprint = sha256Canonical({ operation, actorId: context.actorId, input });
      const identity = context.idempotencyKey === null ? null : `${context.actorId}\u0000${operation}\u0000${context.idempotencyKey}`;
      if (identity !== null) {
        const existing = this.idempotency.get(identity);
        if (existing) {
          invariant(existing.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'idempotency key was already used with different input');
          return clone(existing.result);
        }
      }

      let result;
      await this.#persistTransition(async () => {
        result = await mutate(context);
        if (identity !== null) this.idempotency.set(identity, { fingerprint, result: clone(result) });
      });
      return clone(result);
    };
    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #read(read) {
    return this.commandQueue.then(async () => {
      await this.initialization;
      return clone(await read());
    });
  }

  async #persistTransition(mutate) {
    let lastConflict = null;
    for (let attempt = 0; attempt < this.maxSnapshotRetries; attempt += 1) {
      const before = this.#snapshot();
      const expectedRevision = this.revision;
      try {
        const result = await mutate();
        this.revision += 1;
        await this.store.save(this.#snapshot(), { expectedRevision });
        return result;
      } catch (error) {
        this.#restore(before);
        if (!(error instanceof StoreConflictError) && error?.code !== 'STORE_CONFLICT') throw error;
        lastConflict = error;
        const latest = await this.store.load();
        this.#restore(latest ?? this.#emptySnapshot());
      }
    }
    throw new MarketWatchError('STORE_CONFLICT', 'watch store kept changing during update', {
      cause: lastConflict?.message,
    });
  }

  #assertSourceAvailable(kind) {
    if (kind === 'capacity-available') invariant(this.capacityDirectory !== null, 'SOURCE_UNAVAILABLE', 'capacity watch source is not configured');
    if (kind === 'rfq-opportunity-available') invariant(this.rfqOpportunityDirectory !== null, 'SOURCE_UNAVAILABLE', 'RFQ opportunity watch source is not configured');
    if (kind === 'liquidity-balance') invariant(this.marketLiquidityDirectory !== null, 'SOURCE_UNAVAILABLE', 'market liquidity watch source is not configured');
  }

  #initializeEmpty() {
    this.#restore(this.#emptySnapshot());
  }

  #emptySnapshot() {
    return { schemaVersion: WATCH_SCHEMA_VERSION, revision: 0, watches: [], idempotency: [] };
  }

  async #loadPersisted() {
    const state = await this.store.load();
    if (state !== null) this.#restore(state);
  }

  #snapshot() {
    return {
      schemaVersion: WATCH_SCHEMA_VERSION,
      revision: this.revision,
      watches: [...this.watches.values()].map((watch) => clone(watch)),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]),
    };
  }

  #restore(state) {
    invariant(state && typeof state === 'object', 'INVALID_STATE', 'watch state must be an object');
    invariant(state.schemaVersion === WATCH_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA_VERSION', `unsupported watch schema version: ${state.schemaVersion}`);
    invariant(Number.isSafeInteger(state.revision) && state.revision >= 0, 'INVALID_STATE', 'watch revision must be a non-negative safe integer');
    invariant(Array.isArray(state.watches), 'INVALID_STATE', 'watch state watches must be an array');
    invariant(Array.isArray(state.idempotency), 'INVALID_STATE', 'watch state idempotency must be an array');
    this.revision = state.revision;
    this.watches = new Map(state.watches.map((watch) => [watch.id, clone(watch)]));
    this.idempotency = new Map(state.idempotency.map(([key, value]) => [key, clone(value)]));
  }

  #watch(watchId) {
    const watch = this.watches.get(watchId);
    invariant(watch, 'NOT_FOUND', 'market watch not found');
    return watch;
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}