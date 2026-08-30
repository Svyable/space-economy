import { randomUUID } from 'node:crypto';
import { sha256Canonical } from './canonical-json.js';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const PROGRAM_SCHEMA_VERSION = 1;
const MAX_LOTS = 32;

export class MultiAwardProcurementError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MultiAwardProcurementError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new MultiAwardProcurementError(code, message, details);
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
  invariant(typeof value === 'string' || value instanceof Date, 'INVALID_REQUEST', `${field} must be a timestamp`);
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), 'INVALID_REQUEST', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeCapabilities(value = []) {
  invariant(Array.isArray(value), 'INVALID_REQUEST', 'requiredCapabilities must be an array');
  const capabilities = value.map((item, index) => nonEmptyString(item, `requiredCapabilities[${index}]`));
  return [...new Set(capabilities)].sort();
}

function normalizeUnitPrice(value) {
  if (value === null || value === undefined) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'maxUnitPrice must be an object');
  const settlementAsset = nonEmptyString(value.settlementAsset, 'maxUnitPrice.settlementAsset');
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_REQUEST', 'maxUnitPrice.amount must be an unsigned integer string');
  invariant(BigInt(value.amount) > 0n, 'INVALID_REQUEST', 'maxUnitPrice.amount must be positive');
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', 'maxUnitPrice.scale must be an integer from 0 to 18');
  return { settlementAsset, amount: value.amount, scale: value.scale };
}

function normalizeLots(value) {
  invariant(Array.isArray(value), 'INVALID_REQUEST', 'lots must be an array');
  invariant(value.length >= 2, 'INVALID_REQUEST', 'multi-award procurement requires at least two lots');
  invariant(value.length <= MAX_LOTS, 'INVALID_REQUEST', `multi-award procurement may contain at most ${MAX_LOTS} lots`);

  const lots = value.map((lot, index) => ({
    lotId: lot?.lotId == null || lot.lotId === '' ? `lot-${index + 1}` : nonEmptyString(lot.lotId, `lots[${index}].lotId`),
    quantity: positiveInteger(lot?.quantity, `lots[${index}].quantity`),
    metadata: lot?.metadata ?? {},
  }));
  invariant(new Set(lots.map((lot) => lot.lotId)).size === lots.length, 'INVALID_REQUEST', 'lotId values must be unique');

  const total = lots.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n);
  invariant(total <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_REQUEST', 'total lot quantity exceeds safe integer range');
  return { lots, totalQuantity: Number(total) };
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

function validateServiceWindow(start, end) {
  if (start === null && end === null) return;
  invariant(start !== null && end !== null, 'INVALID_REQUEST', 'serviceWindowStart and serviceWindowEnd must be supplied together');
  invariant(Date.parse(start) < Date.parse(end), 'INVALID_REQUEST', 'service window must have start < end');
}

function lotRfqIdempotencyKey(programId, lotId) {
  return `multi-award-lot:${sha256Canonical({ programId, lotId, action: 'open-rfq' })}`;
}

/**
 * Buyer-defined lot coordinator for multi-provider procurement.
 *
 * The coordinator deliberately does not change RfqMarket quote semantics. A
 * buyer partitions one requirement into fixed lots; each lot becomes an ordinary
 * single-award RFQ. Different providers can win different lots while the sum of
 * possible awards is mathematically bounded by the predeclared lot partition.
 *
 * State ownership remains separated:
 * - this store owns the partition plan and child RFQ identities;
 * - RfqMarket owns quote/award state for each child RFQ;
 * - the clearinghouse owns resulting capacity orders.
 */
export class MultiAwardProcurementCoordinator {
  constructor({
    rfqMarket,
    statePath = null,
    store = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    maxSnapshotRetries = 3,
    maxViewRetries = 3,
  } = {}) {
    invariant(rfqMarket && typeof rfqMarket === 'object', 'INVALID_CONFIGURATION', 'rfqMarket is required');
    for (const method of ['createRfq', 'getRfq', 'listRfqs', 'getQuote', 'acceptQuote', 'getRevision']) {
      invariant(typeof rfqMarket[method] === 'function', 'INVALID_CONFIGURATION', `rfqMarket must provide ${method}()`);
    }
    invariant(!(statePath && store), 'INVALID_CONFIGURATION', 'provide either statePath or store, not both');
    invariant(typeof clock === 'function', 'INVALID_CONFIGURATION', 'clock must be a function');
    invariant(Number.isSafeInteger(maxSnapshotRetries) && maxSnapshotRetries >= 1 && maxSnapshotRetries <= 20, 'INVALID_CONFIGURATION', 'maxSnapshotRetries must be an integer from 1 to 20');
    invariant(Number.isSafeInteger(maxViewRetries) && maxViewRetries >= 1 && maxViewRetries <= 20, 'INVALID_CONFIGURATION', 'maxViewRetries must be an integer from 1 to 20');

    this.rfqMarket = rfqMarket;
    this.store = store ?? (statePath ? new JsonFileSnapshotStore(statePath) : new MemorySnapshotStore());
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.maxSnapshotRetries = maxSnapshotRetries;
    this.maxViewRetries = maxViewRetries;
    this.commandQueue = Promise.resolve();
    this.#initializeEmpty();
    this.initialization = this.#loadPersisted();
    this.initialization.catch(() => {});
  }

  static async open(options = {}) {
    return new MultiAwardProcurementCoordinator(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  createProgram(input, context) {
    return this.#command('program.create', context, input, ({ actorId }) => {
      const now = this.#now();
      const expiresAt = timestamp(input?.expiresAt, 'expiresAt');
      invariant(Date.parse(expiresAt) > Date.parse(now), 'INVALID_REQUEST', 'expiresAt must be in the future');

      const serviceWindowStart = input?.serviceWindowStart == null ? null : timestamp(input.serviceWindowStart, 'serviceWindowStart');
      const serviceWindowEnd = input?.serviceWindowEnd == null ? null : timestamp(input.serviceWindowEnd, 'serviceWindowEnd');
      validateServiceWindow(serviceWindowStart, serviceWindowEnd);

      const settlementAsset = optionalString(input?.settlementAsset, 'settlementAsset');
      const maxUnitPrice = normalizeUnitPrice(input?.maxUnitPrice);
      if (settlementAsset !== null && maxUnitPrice !== null) {
        invariant(maxUnitPrice.settlementAsset === settlementAsset, 'INVALID_REQUEST', 'maxUnitPrice settlement asset must match settlementAsset');
      }

      const { lots, totalQuantity } = normalizeLots(input?.lots);
      const program = {
        id: this.idGenerator(),
        buyerId: actorId,
        name: input?.name == null ? null : nonEmptyString(input.name, 'name'),
        totalQuantity,
        rfqTemplate: {
          service: nonEmptyString(input?.service, 'service'),
          unit: nonEmptyString(input?.unit, 'unit'),
          settlementAsset: settlementAsset ?? maxUnitPrice?.settlementAsset ?? null,
          maxUnitPrice,
          requiredCapabilities: normalizeCapabilities(input?.requiredCapabilities),
          serviceWindowStart,
          serviceWindowEnd,
          expiresAt,
          metadata: input?.metadata ?? {},
        },
        lots: lots.map((lot) => ({
          ...lot,
          rfqId: null,
          openedAt: null,
        })),
        status: 'planned',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.programs.set(program.id, program);
      return program;
    });
  }

  getProgram(programId) {
    return this.#read(async () => this.#hydrateProgram(this.#program(programId)));
  }

  listPrograms({ buyerId } = {}) {
    return this.#read(async () => {
      const programs = [...this.programs.values()].filter((program) => !buyerId || program.buyerId === buyerId);
      const hydrated = [];
      for (const program of programs) hydrated.push(await this.#hydrateProgram(program));
      return hydrated;
    });
  }

  openProgram(programId, rawContext) {
    const run = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      let program = this.#program(programId);
      invariant(context.actorId === program.buyerId, 'FORBIDDEN', 'only the program buyer may open its RFQ lots');

      if (program.status === 'open') return this.#hydrateProgram(program);
      invariant(program.status === 'planned' || program.status === 'opening', 'CONFLICT', 'program cannot be opened from its current state', {
        status: program.status,
      });
      this.#assertProgramLive(program);

      if (program.status === 'planned') {
        await this.#persistTransition(() => {
          const current = this.#program(programId);
          invariant(current.status === 'planned', 'CONFLICT', 'program opening was already claimed');
          const now = this.#now();
          current.status = 'opening';
          current.version += 1;
          current.updatedAt = now;
        });
      }

      program = this.#program(programId);
      for (const lot of program.lots) {
        if (lot.rfqId !== null) continue;
        this.#assertProgramLive(program);
        const child = await this.rfqMarket.createRfq({
          service: program.rfqTemplate.service,
          unit: program.rfqTemplate.unit,
          quantity: lot.quantity,
          settlementAsset: program.rfqTemplate.settlementAsset,
          maxUnitPrice: clone(program.rfqTemplate.maxUnitPrice),
          requiredCapabilities: clone(program.rfqTemplate.requiredCapabilities),
          serviceWindowStart: program.rfqTemplate.serviceWindowStart,
          serviceWindowEnd: program.rfqTemplate.serviceWindowEnd,
          expiresAt: program.rfqTemplate.expiresAt,
          metadata: {
            ...clone(program.rfqTemplate.metadata),
            procurementProgramId: program.id,
            procurementLotId: lot.lotId,
            procurementLotMetadata: clone(lot.metadata),
          },
        }, {
          actorId: program.buyerId,
          idempotencyKey: lotRfqIdempotencyKey(program.id, lot.lotId),
        });

        await this.#persistTransition(() => {
          const current = this.#program(programId);
          const currentLot = current.lots.find((candidate) => candidate.lotId === lot.lotId);
          invariant(currentLot, 'NOT_FOUND', 'procurement lot disappeared during opening');
          if (currentLot.rfqId !== null) {
            invariant(currentLot.rfqId === child.id, 'CONFLICT', 'procurement lot was bound to a different RFQ');
            return;
          }
          currentLot.rfqId = child.id;
          currentLot.openedAt = this.#now();
          current.version += 1;
          current.updatedAt = currentLot.openedAt;
        });
        program = this.#program(programId);
      }

      await this.#persistTransition(() => {
        const current = this.#program(programId);
        invariant(current.lots.every((lot) => lot.rfqId !== null), 'CONFLICT', 'program still contains unopened lots');
        if (current.status === 'open') return;
        invariant(current.status === 'opening', 'CONFLICT', 'program opening state changed before finalization');
        const now = this.#now();
        current.status = 'open';
        current.version += 1;
        current.updatedAt = now;
      });

      return this.#hydrateProgram(this.#program(programId));
    };

    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  acceptLotQuote(programId, lotId, quoteId, rawContext) {
    const run = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      const program = this.#program(programId);
      invariant(context.actorId === program.buyerId, 'FORBIDDEN', 'only the program buyer may award a lot');
      invariant(program.status === 'open', 'CONFLICT', 'program RFQ lots are not fully open');
      const lot = program.lots.find((candidate) => candidate.lotId === lotId);
      invariant(lot, 'NOT_FOUND', 'procurement lot not found');
      invariant(lot.rfqId !== null, 'CONFLICT', 'procurement lot has no RFQ');

      const quote = await this.rfqMarket.getQuote(quoteId);
      invariant(quote.rfqId === lot.rfqId, 'QUOTE_MISMATCH', 'quote belongs to a different procurement lot', {
        expectedRfqId: lot.rfqId,
        actualRfqId: quote.rfqId,
      });

      const award = await this.rfqMarket.acceptQuote(quoteId, { actorId: program.buyerId });
      return {
        program: await this.#hydrateProgram(program),
        lotId,
        award,
      };
    };

    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  getRevision() {
    return this.#read(() => this.revision);
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

  async #hydrateProgram(program) {
    for (let attempt = 1; attempt <= this.maxViewRetries; attempt += 1) {
      const before = await this.rfqMarket.getRevision();
      const publicLots = [];
      let awardedQuantity = 0;

      for (const lot of program.lots) {
        if (lot.rfqId === null) {
          publicLots.push({ ...clone(lot), rfq: null, award: null });
          continue;
        }
        const rfq = await this.rfqMarket.getRfq(lot.rfqId);
        let award = null;
        if (rfq.status === 'awarded' && rfq.acceptedQuoteId !== null) {
          const quote = await this.rfqMarket.getQuote(rfq.acceptedQuoteId);
          award = {
            quoteId: quote.id,
            sellerId: quote.sellerId,
            offerId: quote.offerId,
            orderId: rfq.orderId,
            unitPrice: clone(quote.unitPrice),
            total: clone(quote.total),
          };
          awardedQuantity += lot.quantity;
        }
        publicLots.push({ ...clone(lot), rfq, award });
      }

      const after = await this.rfqMarket.getRevision();
      if (before !== after) continue;

      const awardStatus = awardedQuantity === 0
        ? 'none'
        : awardedQuantity === program.totalQuantity ? 'complete' : 'partial';
      let status = program.status;
      if (program.status === 'open') {
        if (awardStatus === 'complete') status = 'awarded';
        else if (Date.parse(this.#now()) >= Date.parse(program.rfqTemplate.expiresAt)) status = 'expired';
      }

      return {
        ...clone(program),
        status,
        awardStatus,
        awardedQuantity,
        remainingQuantity: program.totalQuantity - awardedQuantity,
        rfqRevision: before,
        lots: publicLots,
      };
    }
    throw new MultiAwardProcurementError('PROGRAM_VIEW_CHANGED', 'RFQ book changed repeatedly while assembling the procurement program');
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
    throw new MultiAwardProcurementError('STORE_CONFLICT', 'procurement program store kept changing during update', {
      cause: lastConflict?.message,
    });
  }

  #initializeEmpty() {
    this.#restore(this.#emptySnapshot());
  }

  #emptySnapshot() {
    return {
      schemaVersion: PROGRAM_SCHEMA_VERSION,
      revision: 0,
      programs: [],
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
      schemaVersion: PROGRAM_SCHEMA_VERSION,
      revision: this.revision,
      programs: [...this.programs.values()].map((program) => clone(program)),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]),
    };
  }

  #restore(state) {
    invariant(state && typeof state === 'object', 'INVALID_STATE', 'procurement program state must be an object');
    invariant(state.schemaVersion === PROGRAM_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA_VERSION', `unsupported procurement schema version: ${state.schemaVersion}`);
    invariant(Number.isSafeInteger(state.revision) && state.revision >= 0, 'INVALID_STATE', 'procurement revision must be a non-negative safe integer');
    invariant(Array.isArray(state.programs), 'INVALID_STATE', 'procurement state programs must be an array');
    invariant(Array.isArray(state.idempotency), 'INVALID_STATE', 'procurement state idempotency must be an array');
    this.revision = state.revision;
    this.programs = new Map(state.programs.map((program) => [program.id, clone(program)]));
    this.idempotency = new Map(state.idempotency.map(([key, value]) => [key, clone(value)]));
  }

  #program(programId) {
    const program = this.programs.get(programId);
    invariant(program, 'NOT_FOUND', 'procurement program not found');
    return program;
  }

  #assertProgramLive(program) {
    invariant(Date.parse(this.#now()) < Date.parse(program.rfqTemplate.expiresAt), 'PROGRAM_EXPIRED', 'procurement program RFQ window has expired', {
      expiresAt: program.rfqTemplate.expiresAt,
    });
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}