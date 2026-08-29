import { randomUUID } from 'node:crypto';
import { sha256Canonical } from './canonical-json.js';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const BUNDLE_SCHEMA_VERSION = 1;
const MAX_LEGS = 32;
const RESERVATION_FAILURE_CODES = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_CAPACITY',
  'OFFER_WINDOW_CLOSED',
  'INVALID_REQUEST',
]);

export class MissionBundleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MissionBundleError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MissionBundleError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function normalizeContext(context) {
  invariant(typeof context?.actorId === 'string' && context.actorId.trim().length > 0, 'UNAUTHENTICATED', 'actor identity is required');
  const actorId = context.actorId.trim();
  const idempotencyKey = context?.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    invariant(typeof idempotencyKey === 'string' && idempotencyKey.length >= 1 && idempotencyKey.length <= 255, 'INVALID_REQUEST', 'idempotencyKey must be 1-255 characters');
  }
  const expectedVersion = context?.expectedVersion ?? null;
  if (expectedVersion !== null) positiveInteger(expectedVersion, 'context.expectedVersion');
  return { actorId, idempotencyKey, expectedVersion };
}

function timestamp(value, field) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_REQUEST', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeLegs(value) {
  invariant(Array.isArray(value), 'INVALID_REQUEST', 'legs must be an array');
  invariant(value.length >= 2, 'INVALID_REQUEST', 'mission bundle must contain at least two legs');
  invariant(value.length <= MAX_LEGS, 'INVALID_REQUEST', `mission bundle may contain at most ${MAX_LEGS} legs`);
  const legs = value.map((leg, index) => ({
    legId: optionalLegId(leg?.legId, index),
    offerId: nonEmptyString(leg?.offerId, `legs[${index}].offerId`),
    quantity: positiveInteger(leg?.quantity, `legs[${index}].quantity`),
    metadata: leg?.metadata ?? {},
  }));
  const legIds = new Set(legs.map((leg) => leg.legId));
  invariant(legIds.size === legs.length, 'INVALID_REQUEST', 'legId values must be unique within a bundle');
  return legs;
}

function optionalLegId(value, index) {
  if (value === null || value === undefined || value === '') return `leg-${index + 1}`;
  return nonEmptyString(value, `legs[${index}].legId`);
}

function errorSummary(error) {
  const summary = {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR',
    detail: error instanceof Error ? error.message : String(error),
  };
  if (error?.details !== undefined) summary.details = clone(error.details);
  return summary;
}

function reservationIdempotencyKey(bundleId, legId) {
  return `bundle-reserve:${sha256Canonical({ bundleId, legId, action: 'reserve' })}`;
}

function cancellationIdempotencyKey(bundleId, legId) {
  return `bundle-cancel:${sha256Canonical({ bundleId, legId, action: 'cancel' })}`;
}

/**
 * Coordinates multi-leg mission reservations above the clearinghouse kernel.
 *
 * Every leg remains an ordinary clearinghouse order. This coordinator does not
 * claim distributed atomicity: it uses a durable reserve/compensate saga with
 * stable per-leg idempotency keys and reverse-order cancellation of earlier,
 * still-unfunded reservations when a later leg cannot be reserved.
 */
export class MissionBundleCoordinator {
  constructor({
    market,
    statePath = null,
    store = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    maxSnapshotRetries = 3,
  } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['createOrder', 'getOrder', 'cancelOrder']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(!(statePath && store), 'INVALID_CONFIGURATION', 'provide either statePath or store, not both');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');

    this.market = market;
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
    return new MissionBundleCoordinator(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  createBundle(input, context) {
    return this.#command('bundle.create', context, input, ({ actorId }) => {
      const now = this.#now();
      const expiresAt = timestamp(input?.expiresAt, 'expiresAt');
      if (expiresAt !== null) {
        invariant(Date.parse(expiresAt) > Date.parse(now), 'INVALID_REQUEST', 'expiresAt must be in the future');
      }
      const legs = normalizeLegs(input?.legs).map((leg) => ({
        ...leg,
        status: 'pending',
        orderId: null,
        failure: null,
        updatedAt: now,
      }));
      const bundle = {
        id: this.idGenerator(),
        buyerId: actorId,
        name: input?.name == null ? null : nonEmptyString(input.name, 'name'),
        legs,
        expiresAt,
        status: 'planned',
        failure: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      this.bundles.set(bundle.id, bundle);
      return bundle;
    });
  }

  getBundle(bundleId) {
    return this.#read(() => this.#publicBundle(this.#bundle(bundleId)));
  }

  listBundles({ buyerId, status } = {}) {
    return this.#read(() => [...this.bundles.values()]
      .filter((bundle) => (!buyerId || bundle.buyerId === buyerId) && (!status || bundle.status === status))
      .map((bundle) => this.#publicBundle(bundle)));
  }

  cancelBundle(bundleId, context) {
    return this.#command('bundle.cancel', context, { bundleId }, ({ actorId, expectedVersion }) => {
      const bundle = this.#bundle(bundleId);
      this.#expectVersion(bundle, expectedVersion);
      invariant(actorId === bundle.buyerId, 'FORBIDDEN', 'only the bundle buyer may cancel it');
      invariant(bundle.status === 'planned', 'CONFLICT', 'only a planned bundle may be cancelled directly');
      const now = this.#now();
      bundle.status = 'cancelled';
      bundle.version += 1;
      bundle.updatedAt = now;
      bundle.completedAt = now;
      return bundle;
    });
  }

  executeBundle(bundleId, rawContext) {
    const run = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      let bundle = this.#bundle(bundleId);
      invariant(context.actorId === bundle.buyerId, 'FORBIDDEN', 'only the bundle buyer may execute it');
      if (context.expectedVersion !== null) this.#expectVersion(bundle, context.expectedVersion);

      if (bundle.status === 'reserved' || bundle.status === 'compensated' || bundle.status === 'attention-required') {
        return this.#executionResult(bundle);
      }
      invariant(bundle.status === 'planned' || bundle.status === 'reserving' || bundle.status === 'compensating', 'CONFLICT', 'bundle cannot be executed from its current state', {
        status: bundle.status,
      });
      if (bundle.status !== 'compensating') this.#assertBundleLive(bundle);

      if (bundle.status === 'planned') {
        await this.#persistTransition(() => {
          const claimed = this.#bundle(bundleId);
          invariant(claimed.status === 'planned', 'CONFLICT', 'bundle execution was already claimed');
          const now = this.#now();
          claimed.status = 'reserving';
          claimed.version += 1;
          claimed.updatedAt = now;
        });
      }

      bundle = this.#bundle(bundleId);
      if (bundle.status === 'reserving') {
        const reservationResult = await this.#reservePendingLegs(bundle);
        bundle = this.#bundle(bundleId);
        if (reservationResult === 'complete') {
          await this.#persistTransition(() => {
            const current = this.#bundle(bundleId);
            invariant(current.legs.every((leg) => leg.status === 'reserved'), 'CONFLICT', 'bundle legs are not fully reserved');
            const now = this.#now();
            current.status = 'reserved';
            current.failure = null;
            current.version += 1;
            current.updatedAt = now;
            current.completedAt = now;
          });
          return this.#executionResult(this.#bundle(bundleId));
        }
      }

      bundle = this.#bundle(bundleId);
      if (bundle.status === 'compensating') {
        await this.#compensate(bundle);
      }
      return this.#executionResult(this.#bundle(bundleId));
    };

    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #reservePendingLegs(bundle) {
    for (const leg of bundle.legs) {
      if (leg.status === 'reserved' || leg.status === 'compensated') continue;
      if (leg.status === 'failed') return 'failed';
      invariant(leg.status === 'pending', 'CONFLICT', 'bundle leg is in an invalid reservation state', {
        legId: leg.legId,
        status: leg.status,
      });

      let order;
      try {
        order = await this.market.createOrder(
          { offerId: leg.offerId, quantity: leg.quantity },
          {
            actorId: bundle.buyerId,
            idempotencyKey: reservationIdempotencyKey(bundle.id, leg.legId),
          },
        );
      } catch (error) {
        if (!RESERVATION_FAILURE_CODES.has(error?.code)) throw error;
        await this.#persistTransition(() => {
          const current = this.#bundle(bundle.id);
          const failedLeg = current.legs.find((candidate) => candidate.legId === leg.legId);
          invariant(failedLeg, 'NOT_FOUND', 'bundle leg not found during failure transition');
          const now = this.#now();
          failedLeg.status = 'failed';
          failedLeg.failure = errorSummary(error);
          failedLeg.updatedAt = now;
          current.status = 'compensating';
          current.failure = {
            phase: 'reserve',
            legId: leg.legId,
            ...errorSummary(error),
          };
          current.version += 1;
          current.updatedAt = now;
        });
        return 'failed';
      }

      await this.#persistTransition(() => {
        const current = this.#bundle(bundle.id);
        const reservedLeg = current.legs.find((candidate) => candidate.legId === leg.legId);
        invariant(reservedLeg, 'NOT_FOUND', 'bundle leg not found during reservation transition');
        if (reservedLeg.status === 'reserved') {
          invariant(reservedLeg.orderId === order.id, 'CONFLICT', 'bundle leg replay returned a different order');
          return;
        }
        invariant(reservedLeg.status === 'pending', 'CONFLICT', 'bundle leg is not pending');
        const now = this.#now();
        reservedLeg.status = 'reserved';
        reservedLeg.orderId = order.id;
        reservedLeg.failure = null;
        reservedLeg.updatedAt = now;
        current.version += 1;
        current.updatedAt = now;
      });
    }
    return 'complete';
  }

  async #compensate(bundle) {
    const reservedLegs = [...bundle.legs].reverse().filter((leg) => leg.status === 'reserved');
    for (const leg of reservedLegs) {
      const order = await this.market.getOrder(leg.orderId);
      if (order.status === 'cancelled' || order.status === 'expired') {
        await this.#markLegCompensated(bundle.id, leg.legId, order.status);
        continue;
      }
      if (order.status !== 'reserved') {
        await this.#persistTransition(() => {
          const current = this.#bundle(bundle.id);
          const now = this.#now();
          current.status = 'attention-required';
          current.failure = {
            phase: 'compensate',
            legId: leg.legId,
            code: 'NON_COMPENSATABLE_ORDER',
            detail: `order ${order.id} is ${order.status} and cannot be automatically cancelled`,
            orderId: order.id,
            orderStatus: order.status,
          };
          current.version += 1;
          current.updatedAt = now;
          current.completedAt = now;
        });
        return;
      }

      try {
        const cancelled = await this.market.cancelOrder(order.id, {
          actorId: bundle.buyerId,
          idempotencyKey: cancellationIdempotencyKey(bundle.id, leg.legId),
          expectedVersion: order.version,
        });
        await this.#markLegCompensated(bundle.id, leg.legId, cancelled.status);
      } catch (error) {
        if (error?.code !== 'CONFLICT' && error?.code !== 'STALE_VERSION') throw error;
        const currentOrder = await this.market.getOrder(order.id);
        if (currentOrder.status === 'cancelled' || currentOrder.status === 'expired') {
          await this.#markLegCompensated(bundle.id, leg.legId, currentOrder.status);
          continue;
        }
        if (currentOrder.status !== 'reserved') {
          await this.#persistTransition(() => {
            const current = this.#bundle(bundle.id);
            const now = this.#now();
            current.status = 'attention-required';
            current.failure = {
              phase: 'compensate',
              legId: leg.legId,
              code: 'NON_COMPENSATABLE_ORDER',
              detail: `order ${currentOrder.id} changed to ${currentOrder.status} during compensation`,
              orderId: currentOrder.id,
              orderStatus: currentOrder.status,
            };
            current.version += 1;
            current.updatedAt = now;
            current.completedAt = now;
          });
          return;
        }
        throw error;
      }
    }

    await this.#persistTransition(() => {
      const current = this.#bundle(bundle.id);
      invariant(current.legs.every((leg) => leg.status !== 'reserved'), 'CONFLICT', 'bundle still has reserved legs after compensation');
      const now = this.#now();
      current.status = 'compensated';
      current.version += 1;
      current.updatedAt = now;
      current.completedAt = now;
    });
  }

  async #markLegCompensated(bundleId, legId, orderStatus) {
    await this.#persistTransition(() => {
      const current = this.#bundle(bundleId);
      const leg = current.legs.find((candidate) => candidate.legId === legId);
      invariant(leg, 'NOT_FOUND', 'bundle leg not found during compensation');
      if (leg.status === 'compensated') return;
      invariant(leg.status === 'reserved', 'CONFLICT', 'only a reserved bundle leg may be compensated');
      const now = this.#now();
      leg.status = 'compensated';
      leg.failure = { code: 'COMPENSATED', detail: `order ended as ${orderStatus}` };
      leg.updatedAt = now;
      current.version += 1;
      current.updatedAt = now;
    });
  }

  async #executionResult(bundle) {
    const orders = [];
    for (const leg of bundle.legs) {
      if (leg.orderId !== null) orders.push(await this.market.getOrder(leg.orderId));
    }
    return { bundle: this.#publicBundle(bundle), orders };
  }

  #command(operation, rawContext, input, mutate) {
    const run = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      const fingerprint = sha256Canonical({ operation, actorId: context.actorId, input });
      const identity = context.idempotencyKey === null ? null : `${context.actorId}\u0000${context.idempotencyKey}`;
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
        if (identity !== null) {
          this.idempotency.set(identity, { fingerprint, result: clone(result) });
        }
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
    throw new MissionBundleError('STORE_CONFLICT', 'bundle store kept changing during update', {
      cause: lastConflict?.message,
    });
  }

  #initializeEmpty() {
    this.#restore(this.#emptySnapshot());
  }

  #emptySnapshot() {
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      revision: 0,
      bundles: [],
      idempotency: [],
    };
  }

  async #loadPersisted() {
    const state = await this.store.load();
    if (state === null) return;
    this.#restore(state);
  }

  #snapshot() {
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      revision: this.revision,
      bundles: [...this.bundles.values()].map((bundle) => clone(bundle)),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]),
    };
  }

  #restore(state) {
    invariant(state && typeof state === 'object', 'INVALID_STATE', 'bundle state must be an object');
    invariant(state.schemaVersion === BUNDLE_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA_VERSION', `unsupported bundle schema version: ${state.schemaVersion}`);
    invariant(Number.isSafeInteger(state.revision) && state.revision >= 0, 'INVALID_STATE', 'bundle revision must be a non-negative safe integer');
    invariant(Array.isArray(state.bundles), 'INVALID_STATE', 'bundle state bundles must be an array');
    invariant(Array.isArray(state.idempotency), 'INVALID_STATE', 'bundle state idempotency must be an array');
    this.revision = state.revision;
    this.bundles = new Map(state.bundles.map((bundle) => [bundle.id, clone(bundle)]));
    this.idempotency = new Map(state.idempotency.map(([key, value]) => [key, clone(value)]));
  }

  #bundle(bundleId) {
    const bundle = this.bundles.get(bundleId);
    invariant(bundle, 'NOT_FOUND', 'mission bundle not found');
    return bundle;
  }

  #expectVersion(resource, expectedVersion) {
    if (expectedVersion === null) return;
    invariant(resource.version === expectedVersion, 'STALE_VERSION', 'resource version does not match expectation', {
      expectedVersion,
      actualVersion: resource.version,
    });
  }

  #assertBundleLive(bundle) {
    if (bundle.expiresAt === null) return;
    invariant(Date.parse(this.#now()) < Date.parse(bundle.expiresAt), 'BUNDLE_EXPIRED', 'mission bundle execution window has expired', {
      expiresAt: bundle.expiresAt,
    });
  }

  #publicBundle(bundle) {
    return clone(bundle);
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}
