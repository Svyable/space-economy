import { randomUUID } from 'node:crypto';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const SCHEMA_VERSION = 1;
const MAX_LEGS = 32;
const ACQUISITION_FAILURE_CODES = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_CAPACITY',
  'OFFER_WINDOW_CLOSED',
  'INVALID_REQUEST',
  'CAPACITY_RIGHT_EXPIRED',
]);

export class MissionPortfolioError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MissionPortfolioError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MissionPortfolioError(code, message, details);
}

function text(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function integer(value, field, minimum = 1) {
  invariant(Number.isSafeInteger(value) && value >= minimum, 'INVALID_REQUEST', `${field} must be an integer >= ${minimum}`);
  return value;
}

function normalizeContext(value) {
  const actorId = text(value?.actorId, 'actorId');
  const expectedVersion = value?.expectedVersion ?? null;
  if (expectedVersion !== null) integer(expectedVersion, 'expectedVersion');
  return { actorId, expectedVersion };
}

function normalizeMoney(value, field) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', `${field} is required`);
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount) && BigInt(value.amount) > 0n, 'INVALID_REQUEST', `${field}.amount must be a positive unsigned integer string`);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', `${field}.scale must be an integer from 0 to 18`);
  return {
    settlementAsset: text(value.settlementAsset, `${field}.settlementAsset`),
    amount: value.amount,
    scale: value.scale,
  };
}

function sameMoney(left, right) {
  return left?.settlementAsset === right?.settlementAsset
    && left?.amount === right?.amount
    && left?.scale === right?.scale;
}

function normalizeTimestamp(value, field) {
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), 'INVALID_REQUEST', `${field} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function errorSummary(error) {
  const summary = {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR',
    detail: error instanceof Error ? error.message : String(error),
  };
  if (error?.details !== undefined) summary.details = clone(error.details);
  return summary;
}

function idempotencyKey(portfolioId, legId, action) {
  return `mission-portfolio:${portfolioId}:${legId}:${action}`;
}

function normalizeLegs(value, now) {
  invariant(Array.isArray(value) && value.length >= 2 && value.length <= MAX_LEGS, 'INVALID_REQUEST', `legs must contain 2-${MAX_LEGS} entries`);
  const legs = value.map((leg, index) => {
    const expiresAt = normalizeTimestamp(leg?.expiresAt, `legs[${index}].expiresAt`);
    invariant(Date.parse(expiresAt) > Date.parse(now), 'INVALID_REQUEST', `legs[${index}].expiresAt must be in the future`);
    const reservationTtlSeconds = leg?.reservationTtlSeconds ?? null;
    if (reservationTtlSeconds !== null) integer(reservationTtlSeconds, `legs[${index}].reservationTtlSeconds`);
    const metadata = leg?.metadata ?? {};
    invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'INVALID_REQUEST', `legs[${index}].metadata must be an object`);
    return {
      legId: leg?.legId ? text(leg.legId, `legs[${index}].legId`) : `leg-${index + 1}`,
      offerId: text(leg?.offerId, `legs[${index}].offerId`),
      quantity: integer(leg?.quantity, `legs[${index}].quantity`),
      exerciseUnitPrice: normalizeMoney(leg?.exerciseUnitPrice, `legs[${index}].exerciseUnitPrice`),
      expiresAt,
      reservationTtlSeconds,
      stage: leg?.stage == null ? 1 : integer(leg.stage, `legs[${index}].stage`),
      metadata: clone(metadata),
      status: 'pending',
      rightId: null,
      termsHash: null,
      orderId: null,
      failure: null,
    };
  });
  invariant(new Set(legs.map((leg) => leg.legId)).size === legs.length, 'INVALID_REQUEST', 'legId values must be unique');
  return legs.sort((left, right) => left.stage - right.stage || left.legId.localeCompare(right.legId));
}

function validateAcquiredRight(right, portfolio, leg) {
  invariant(right && typeof right === 'object', 'INVALID_ACQUISITION', 'capacity-right acquirer returned no right');
  invariant(right.status === 'held' && right.expiryDue !== true, 'INVALID_ACQUISITION', 'acquired capacity right is not live and held');
  invariant(right.holderId === portfolio.buyerId, 'INVALID_ACQUISITION', 'acquired capacity right is not held by portfolio buyer');
  invariant(right.offerId === leg.offerId, 'INVALID_ACQUISITION', 'acquired capacity right offer does not match portfolio leg');
  invariant(right.quantity === leg.quantity, 'INVALID_ACQUISITION', 'acquired capacity right quantity does not match portfolio leg');
  invariant(sameMoney(right.exerciseUnitPrice, leg.exerciseUnitPrice), 'INVALID_ACQUISITION', 'acquired capacity right exercise price does not match portfolio leg');
  invariant(right.expiresAt === leg.expiresAt, 'INVALID_ACQUISITION', 'acquired capacity right expiry does not match portfolio leg');
  invariant((right.reservationTtlSeconds ?? null) === leg.reservationTtlSeconds, 'INVALID_ACQUISITION', 'acquired capacity right reservation TTL does not match portfolio leg');
  invariant(typeof right.id === 'string' && right.id.length > 0, 'INVALID_ACQUISITION', 'acquired capacity right is missing id');
  invariant(typeof right.termsHash === 'string' && right.termsHash.length > 0, 'INVALID_ACQUISITION', 'acquired capacity right is missing terms hash');
}

export class MissionPortfolioCoordinator {
  constructor({
    market,
    capacityRightAcquirer,
    store = null,
    statePath = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    maxSnapshotRetries = 3,
  } = {}) {
    invariant(market && typeof market === 'object', 'INVALID_CONFIGURATION', 'market is required');
    for (const method of ['getCapacityRight', 'releaseCapacityRight', 'exerciseCapacityRight']) {
      invariant(typeof market[method] === 'function', 'INVALID_CONFIGURATION', `market must provide ${method}()`);
    }
    invariant(capacityRightAcquirer && typeof capacityRightAcquirer.acquireCapacityRight === 'function', 'INVALID_CONFIGURATION', 'capacityRightAcquirer.acquireCapacityRight() is required');
    invariant(!(store && statePath), 'INVALID_CONFIGURATION', 'provide store or statePath, not both');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');

    this.market = market;
    this.capacityRightAcquirer = capacityRightAcquirer;
    this.store = store ?? (statePath ? new JsonFileSnapshotStore(statePath) : new MemorySnapshotStore());
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.maxSnapshotRetries = maxSnapshotRetries;
    this.commandQueue = Promise.resolve();
    this.state = { schemaVersion: SCHEMA_VERSION, revision: 0, portfolios: [] };
    this.initialization = this.#load();
    this.initialization.catch(() => {});
  }

  static async open(options = {}) {
    return new MissionPortfolioCoordinator(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  createPortfolio(input, rawContext) {
    return this.#command(async () => {
      const { actorId } = normalizeContext(rawContext);
      const now = this.#now();
      const portfolio = {
        id: this.idGenerator(),
        buyerId: actorId,
        name: input?.name == null ? null : text(input.name, 'name'),
        status: 'planned',
        legs: normalizeLegs(input?.legs, now),
        failure: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.#persist(() => this.state.portfolios.push(portfolio));
      return clone(this.#portfolio(portfolio.id));
    });
  }

  getPortfolio(portfolioId) {
    return this.#command(async () => {
      await this.#refresh();
      return clone(this.#portfolio(portfolioId));
    });
  }

  listPortfolios({ buyerId = null, status = null } = {}) {
    return this.#command(async () => {
      await this.#refresh();
      return clone(this.state.portfolios.filter((portfolio) => (
        (!buyerId || portfolio.buyerId === buyerId)
        && (!status || portfolio.status === status)
      )));
    });
  }

  acquirePortfolio(portfolioId, rawContext) {
    return this.#command(async () => {
      const { actorId, expectedVersion } = normalizeContext(rawContext);
      await this.#refresh();
      let portfolio = this.#portfolio(portfolioId);
      invariant(actorId === portfolio.buyerId, 'FORBIDDEN', 'only the portfolio buyer may acquire it');
      if (expectedVersion !== null) invariant(expectedVersion === portfolio.version, 'STALE_VERSION', 'portfolio version changed');
      if (['secured', 'unwound', 'attention-required'].includes(portfolio.status)) return clone(portfolio);
      invariant(['planned', 'acquiring', 'unwinding'].includes(portfolio.status), 'CONFLICT', 'portfolio cannot be acquired from its current state', { status: portfolio.status });

      if (portfolio.status === 'planned') {
        await this.#persist(() => {
          const current = this.#portfolio(portfolioId);
          current.status = 'acquiring';
          current.version += 1;
          current.updatedAt = this.#now();
        });
      }

      portfolio = this.#portfolio(portfolioId);
      if (portfolio.status === 'acquiring') {
        for (const snapshotLeg of clone(portfolio.legs)) {
          if (snapshotLeg.status === 'held') continue;
          invariant(snapshotLeg.status === 'pending', 'CONFLICT', 'portfolio leg is not pending during acquisition', { legId: snapshotLeg.legId, status: snapshotLeg.status });
          let right;
          try {
            right = await this.capacityRightAcquirer.acquireCapacityRight({
              portfolioId: portfolio.id,
              legId: snapshotLeg.legId,
              buyerId: portfolio.buyerId,
              terms: {
                offerId: snapshotLeg.offerId,
                quantity: snapshotLeg.quantity,
                exerciseUnitPrice: clone(snapshotLeg.exerciseUnitPrice),
                reservationTtlSeconds: snapshotLeg.reservationTtlSeconds,
                expiresAt: snapshotLeg.expiresAt,
                metadata: {
                  ...clone(snapshotLeg.metadata),
                  missionPortfolioId: portfolio.id,
                  missionPortfolioLegId: snapshotLeg.legId,
                },
              },
              idempotencyKey: idempotencyKey(portfolio.id, snapshotLeg.legId, 'acquire'),
            });
            validateAcquiredRight(right, portfolio, snapshotLeg);
          } catch (error) {
            if (!ACQUISITION_FAILURE_CODES.has(error?.code) && error?.code !== 'INVALID_ACQUISITION') throw error;
            await this.#persist(() => {
              const current = this.#portfolio(portfolioId);
              const leg = current.legs.find((candidate) => candidate.legId === snapshotLeg.legId);
              leg.status = 'failed';
              leg.failure = errorSummary(error);
              current.status = 'unwinding';
              current.failure = { phase: 'acquire', legId: leg.legId, ...errorSummary(error) };
              current.version += 1;
              current.updatedAt = this.#now();
            });
            break;
          }

          await this.#persist(() => {
            const current = this.#portfolio(portfolioId);
            const leg = current.legs.find((candidate) => candidate.legId === snapshotLeg.legId);
            if (leg.status === 'held') {
              invariant(leg.rightId === right.id && leg.termsHash === right.termsHash, 'CONFLICT', 'acquisition replay returned a different capacity right');
              return;
            }
            invariant(leg.status === 'pending', 'CONFLICT', 'portfolio leg changed during acquisition');
            leg.status = 'held';
            leg.rightId = right.id;
            leg.termsHash = right.termsHash;
            leg.failure = null;
            current.version += 1;
            current.updatedAt = this.#now();
          });
        }

        portfolio = this.#portfolio(portfolioId);
        if (portfolio.status === 'acquiring' && portfolio.legs.every((leg) => leg.status === 'held')) {
          await this.#persist(() => {
            const current = this.#portfolio(portfolioId);
            current.status = 'secured';
            current.failure = null;
            current.version += 1;
            current.updatedAt = this.#now();
          });
        }
      }

      if (this.#portfolio(portfolioId).status === 'unwinding') await this.#unwind(portfolioId);
      return clone(this.#portfolio(portfolioId));
    });
  }

  exerciseStage(portfolioId, stage, rawContext) {
    return this.#command(async () => {
      const { actorId } = normalizeContext(rawContext);
      integer(stage, 'stage');
      await this.#refresh();
      let portfolio = this.#portfolio(portfolioId);
      invariant(actorId === portfolio.buyerId, 'FORBIDDEN', 'only the portfolio buyer may exercise it');
      invariant(['secured', 'exercising'].includes(portfolio.status), 'CONFLICT', 'portfolio is not secured for exercise');
      const target = portfolio.legs.filter((leg) => leg.stage === stage);
      invariant(target.length > 0, 'NOT_FOUND', 'portfolio stage not found');
      invariant(!portfolio.legs.some((leg) => leg.stage < stage && leg.status !== 'exercised'), 'CONFLICT', 'prior stages must be exercised first');

      for (const snapshotLeg of clone(target)) {
        if (snapshotLeg.status === 'exercised') continue;
        const right = await this.market.getCapacityRight(snapshotLeg.rightId, { actorId: portfolio.buyerId });
        if (
          right.status !== 'held'
          || right.holderId !== portfolio.buyerId
          || right.termsHash !== snapshotLeg.termsHash
          || right.expiryDue === true
        ) {
          await this.#attention(portfolioId, snapshotLeg.legId, 'RIGHT_NOT_EXERCISABLE', 'capacity right no longer satisfies the secured portfolio');
          return clone(this.#portfolio(portfolioId));
        }

        let order;
        try {
          order = await this.market.exerciseCapacityRight(right.id, {
            actorId: portfolio.buyerId,
            idempotencyKey: idempotencyKey(portfolioId, snapshotLeg.legId, 'exercise'),
            expectedVersion: right.version,
          });
        } catch (error) {
          await this.#attention(portfolioId, snapshotLeg.legId, error?.code ?? 'EXERCISE_FAILED', error instanceof Error ? error.message : String(error));
          return clone(this.#portfolio(portfolioId));
        }

        await this.#persist(() => {
          const current = this.#portfolio(portfolioId);
          const leg = current.legs.find((candidate) => candidate.legId === snapshotLeg.legId);
          if (leg.status === 'exercised') {
            invariant(leg.orderId === order.id, 'CONFLICT', 'exercise replay returned a different order');
            return;
          }
          invariant(leg.status === 'held', 'CONFLICT', 'portfolio leg changed during exercise');
          leg.status = 'exercised';
          leg.orderId = order.id;
          current.status = 'exercising';
          current.version += 1;
          current.updatedAt = this.#now();
        });
      }

      portfolio = this.#portfolio(portfolioId);
      if (portfolio.legs.every((leg) => leg.status === 'exercised')) {
        await this.#persist(() => {
          const current = this.#portfolio(portfolioId);
          current.status = 'active';
          current.failure = null;
          current.version += 1;
          current.updatedAt = this.#now();
        });
      }
      return clone(this.#portfolio(portfolioId));
    });
  }

  async #unwind(portfolioId) {
    const portfolio = clone(this.#portfolio(portfolioId));
    for (const snapshotLeg of [...portfolio.legs].reverse()) {
      if (snapshotLeg.status !== 'held') continue;
      const right = await this.market.getCapacityRight(snapshotLeg.rightId, { actorId: portfolio.buyerId });
      if (right.status === 'released' || right.status === 'expired') {
        await this.#markReleased(portfolioId, snapshotLeg.legId, right.status);
        continue;
      }
      if (right.status !== 'held' || right.holderId !== portfolio.buyerId || right.termsHash !== snapshotLeg.termsHash) {
        await this.#attention(portfolioId, snapshotLeg.legId, 'RIGHT_NOT_RELEASABLE', 'capacity right is no longer releasable by the portfolio buyer');
        return;
      }
      try {
        await this.market.releaseCapacityRight(right.id, {
          actorId: portfolio.buyerId,
          idempotencyKey: idempotencyKey(portfolioId, snapshotLeg.legId, 'release'),
          expectedVersion: right.version,
        });
        await this.#markReleased(portfolioId, snapshotLeg.legId, 'released');
      } catch (error) {
        if (error?.code === 'CAPACITY_RIGHT_EXPIRED') {
          await this.#attention(portfolioId, snapshotLeg.legId, error.code, error.message);
          return;
        }
        throw error;
      }
    }

    await this.#persist(() => {
      const current = this.#portfolio(portfolioId);
      invariant(current.legs.every((leg) => leg.status !== 'held'), 'CONFLICT', 'portfolio still has held rights after unwind');
      current.status = 'unwound';
      current.version += 1;
      current.updatedAt = this.#now();
    });
  }

  async #markReleased(portfolioId, legId, outcome) {
    await this.#persist(() => {
      const current = this.#portfolio(portfolioId);
      const leg = current.legs.find((candidate) => candidate.legId === legId);
      leg.status = 'released';
      leg.releaseOutcome = outcome;
      current.version += 1;
      current.updatedAt = this.#now();
    });
  }

  async #attention(portfolioId, legId, code, detail) {
    await this.#persist(() => {
      const current = this.#portfolio(portfolioId);
      current.status = 'attention-required';
      current.failure = { phase: 'portfolio', legId, code, detail };
      current.version += 1;
      current.updatedAt = this.#now();
    });
  }

  async #refresh() {
    const persisted = await this.store.load();
    if (persisted) {
      invariant(persisted.schemaVersion === SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', 'unsupported mission portfolio schema');
      this.state = persisted;
    }
  }

  async #load() {
    await this.#refresh();
  }

  async #persist(mutator) {
    for (let attempt = 0; attempt < this.maxSnapshotRetries; attempt += 1) {
      await this.#refresh();
      const before = clone(this.state);
      const expectedRevision = before.revision;
      try {
        mutator();
        this.state.revision = expectedRevision + 1;
        await this.store.save(this.state, { expectedRevision });
        return;
      } catch (error) {
        this.state = before;
        if (error instanceof StoreConflictError && attempt + 1 < this.maxSnapshotRetries) continue;
        throw error;
      }
    }
  }

  #portfolio(portfolioId) {
    const value = this.state.portfolios.find((portfolio) => portfolio.id === portfolioId);
    invariant(value, 'NOT_FOUND', 'mission portfolio not found');
    return value;
  }

  #command(fn) {
    const run = async () => {
      await this.initialization;
      return fn();
    };
    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}