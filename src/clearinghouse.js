import { randomUUID } from 'node:crypto';
import { sha256Canonical } from './canonical-json.js';
import { MigratingSnapshotStore } from './migrations.js';
import { CURRENT_SCHEMA_VERSION, createClearinghouseMigrationRegistry } from './schema.js';
import { JsonFileSnapshotStore, MemorySnapshotStore, StoreConflictError } from './store.js';

const clone = (value) => structuredClone(value);
const EVENT_SPEC_VERSION = '1.0';

export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new DomainError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_REQUEST', `${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_REQUEST', `${field} must be a positive safe integer`);
  return value;
}

function optionalPositiveInteger(value, field) {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, field);
}

function normalizeUnitPrice(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', 'unitPrice is required');
  const settlementAsset = nonEmptyString(value.settlementAsset, 'unitPrice.settlementAsset');
  invariant(typeof value.amount === 'string' && /^[0-9]+$/.test(value.amount), 'INVALID_REQUEST', 'unitPrice.amount must be an unsigned integer string');
  invariant(BigInt(value.amount) > 0n, 'INVALID_REQUEST', 'unitPrice.amount must be positive');
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18, 'INVALID_REQUEST', 'unitPrice.scale must be an integer from 0 to 18');
  return { settlementAsset, amount: value.amount, scale: value.scale };
}

function normalizeMetadata(value) {
  const metadata = value ?? {};
  invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'INVALID_REQUEST', 'metadata must be an object');
  try {
    sha256Canonical(metadata);
  } catch (error) {
    throw new DomainError('INVALID_REQUEST', `metadata must be canonical JSON: ${error.message}`);
  }
  return clone(metadata);
}

function multiplyAmount(amount, quantity) {
  return (BigInt(amount) * BigInt(quantity)).toString();
}

function sameAmount(left, right) {
  return left.settlementAsset === right.settlementAsset && left.amount === right.amount && left.scale === right.scale;
}

function normalizeIdentifiers(identifiers = []) {
  invariant(Array.isArray(identifiers), 'INVALID_REQUEST', 'identifiers must be an array');
  const normalized = identifiers.map((identifier, index) => ({
    scheme: nonEmptyString(identifier?.scheme, `identifiers[${index}].scheme`),
    value: nonEmptyString(identifier?.value, `identifiers[${index}].value`),
  }));
  const unique = new Set(normalized.map((item) => `${item.scheme}\u0000${item.value}`));
  invariant(unique.size === normalized.length, 'INVALID_REQUEST', 'asset identifiers must be unique');
  return normalized;
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

export class Clearinghouse {
  constructor({
    statePath = null,
    store = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    eventSource = 'urn:space-economy:clearinghouse',
  } = {}) {
    invariant(!(statePath && store), 'INVALID_CONFIGURATION', 'provide either statePath or store, not both');
    const baseStore = store ?? (statePath ? new JsonFileSnapshotStore(statePath) : new MemorySnapshotStore());
    this.store = new MigratingSnapshotStore(baseStore, createClearinghouseMigrationRegistry());
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.eventSource = eventSource;
    this.commandQueue = Promise.resolve();
    this.#initializeEmpty();
    this.initialization = this.#loadPersisted();
    this.initialization.catch(() => {});
  }

  static async open(options = {}) {
    return new Clearinghouse(options).ready();
  }

  async ready() {
    await this.initialization;
    return this;
  }

  registerAsset(input, context) {
    return this.#command('asset.register', context, input, ({ actorId }) => {
      const timestamp = this.#now();
      const asset = {
        id: this.idGenerator(),
        ownerId: actorId,
        name: nonEmptyString(input?.name, 'name'),
        type: nonEmptyString(input?.type, 'type'),
        capabilities: Array.isArray(input?.capabilities) ? clone(input.capabilities) : [],
        identifiers: normalizeIdentifiers(input?.identifiers),
        location: input?.location ?? null,
        metadata: input?.metadata ?? {},
        status: 'active',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.assets.set(asset.id, asset);
      this.#record('spaceeconomy.asset.registered.v1', `asset/${asset.id}`, {
        assetId: asset.id,
        ownerId: asset.ownerId,
        assetType: asset.type,
        identifiers: asset.identifiers,
      });
      return asset;
    });
  }

  listAssets() {
    return this.#read(() => [...this.assets.values()].map((asset) => clone(asset)));
  }

  createOffer(input, context) {
    return this.#command('offer.create', context, input, ({ actorId }) => {
      const asset = this.assets.get(input?.assetId);
      invariant(asset, 'NOT_FOUND', 'asset not found');
      invariant(asset.status === 'active', 'CONFLICT', 'asset is not active');
      invariant(actorId === asset.ownerId, 'FORBIDDEN', 'only the asset owner may publish capacity');

      const timestamp = this.#now();
      const capacity = positiveInteger(input?.capacity, 'capacity');
      const reservationTtlSeconds = optionalPositiveInteger(input?.reservationTtlSeconds, 'reservationTtlSeconds');
      if (reservationTtlSeconds !== null) this.#addSeconds(timestamp, reservationTtlSeconds, 'reservationTtlSeconds');
      const offer = {
        id: this.idGenerator(),
        assetId: asset.id,
        sellerId: actorId,
        service: nonEmptyString(input?.service, 'service'),
        unit: nonEmptyString(input?.unit, 'unit'),
        unitPrice: normalizeUnitPrice(input?.unitPrice),
        capacity,
        remaining: capacity,
        windowStart: input?.windowStart ?? null,
        windowEnd: input?.windowEnd ?? null,
        reservationTtlSeconds,
        metadata: input?.metadata ?? {},
        status: 'open',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.#validateWindow(offer.windowStart, offer.windowEnd);
      this.offers.set(offer.id, offer);
      this.#record('spaceeconomy.offer.created.v1', `offer/${offer.id}`, {
        offerId: offer.id,
        assetId: offer.assetId,
        sellerId: offer.sellerId,
        service: offer.service,
        unit: offer.unit,
        capacity: offer.capacity,
        unitPrice: offer.unitPrice,
        reservationTtlSeconds: offer.reservationTtlSeconds,
      });
      return offer;
    });
  }

  listOffers({ service, status = 'open' } = {}) {
    return this.#read(() => [...this.offers.values()]
      .filter((offer) => (!service || offer.service === service) && (!status || offer.status === status))
      .map((offer) => clone(offer)));
  }

  createCommercialCommitment(input, context) {
    return this.#command('commercial-commitment.create', context, input, ({ actorId }) => {
      const offer = this.offers.get(input?.offerId);
      invariant(offer, 'NOT_FOUND', 'offer not found');
      invariant(offer.sellerId === actorId, 'FORBIDDEN', 'only the offer seller may issue commercial terms');
      invariant(offer.status === 'open', 'CONFLICT', 'offer is not open');

      const timestamp = this.#now();
      if (offer.windowEnd !== null) {
        invariant(Date.parse(timestamp) < Date.parse(offer.windowEnd), 'OFFER_WINDOW_CLOSED', 'offer service window has ended');
      }
      const buyerId = nonEmptyString(input?.buyerId, 'buyerId');
      invariant(buyerId !== actorId, 'INVALID_REQUEST', 'buyer and seller must be different participants');
      const quantity = positiveInteger(input?.quantity, 'quantity');
      invariant(quantity <= offer.remaining, 'INSUFFICIENT_CAPACITY', 'commitment quantity exceeds current remaining capacity', {
        remaining: offer.remaining,
      });
      const unitPrice = normalizeUnitPrice(input?.unitPrice);
      const expiresAt = nonEmptyString(input?.expiresAt, 'expiresAt');
      const expiresMs = Date.parse(expiresAt);
      invariant(Number.isFinite(expiresMs), 'INVALID_REQUEST', 'expiresAt must be an RFC 3339 timestamp');
      invariant(expiresMs > Date.parse(timestamp), 'INVALID_REQUEST', 'expiresAt must be in the future');
      if (offer.windowEnd !== null) {
        invariant(expiresMs <= Date.parse(offer.windowEnd), 'INVALID_REQUEST', 'commitment may not outlive the offer service window');
      }

      let reservationTtlSeconds;
      if (Object.prototype.hasOwnProperty.call(input ?? {}, 'reservationTtlSeconds')) {
        reservationTtlSeconds = optionalPositiveInteger(input.reservationTtlSeconds, 'reservationTtlSeconds');
      } else {
        reservationTtlSeconds = offer.reservationTtlSeconds;
      }
      if (reservationTtlSeconds !== null) this.#addSeconds(timestamp, reservationTtlSeconds, 'reservationTtlSeconds');
      const metadata = normalizeMetadata(input?.metadata);
      const immutableTerms = {
        offerId: offer.id,
        assetId: offer.assetId,
        sellerId: actorId,
        buyerId,
        service: offer.service,
        unit: offer.unit,
        quantity,
        unitPrice,
        reservationTtlSeconds,
        expiresAt: new Date(expiresMs).toISOString(),
        metadata,
      };
      const commitment = {
        id: this.idGenerator(),
        ...immutableTerms,
        termsHash: `sha256:${sha256Canonical(immutableTerms)}`,
        status: 'active',
        orderId: null,
        revocation: null,
        exercisedAt: null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.commercialCommitments.set(commitment.id, commitment);
      this.#record('spaceeconomy.commercial-commitment.created.v1', `commercial-commitment/${commitment.id}`, {
        commitmentId: commitment.id,
        offerId: offer.id,
        sellerId: actorId,
        buyerId,
        quantity,
        unitPrice,
        reservationTtlSeconds,
        expiresAt: commitment.expiresAt,
        termsHash: commitment.termsHash,
      });
      return this.#viewCommercialCommitment(commitment, timestamp);
    });
  }

  getCommercialCommitment(commitmentId, context) {
    return this.#read(() => {
      const { actorId } = normalizeContext(context);
      const commitment = this.#commercialCommitment(commitmentId);
      invariant(actorId === commitment.sellerId || actorId === commitment.buyerId, 'FORBIDDEN', 'actor is not a party to the commitment');
      return this.#viewCommercialCommitment(commitment);
    });
  }

  listCommercialCommitments(context, { status = null } = {}) {
    return this.#read(() => {
      const { actorId } = normalizeContext(context);
      if (status !== null) {
        invariant(['active', 'expired', 'revoked', 'exercised'].includes(status), 'INVALID_REQUEST', 'unsupported commitment status');
      }
      const timestamp = this.#now();
      return [...this.commercialCommitments.values()]
        .filter((commitment) => actorId === commitment.sellerId || actorId === commitment.buyerId)
        .map((commitment) => this.#viewCommercialCommitment(commitment, timestamp))
        .filter((commitment) => status === null || commitment.status === status)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    });
  }

  revokeCommercialCommitment(commitmentId, context) {
    return this.#command('commercial-commitment.revoke', context, { commitmentId }, ({ actorId, expectedVersion }) => {
      const commitment = this.#commercialCommitment(commitmentId);
      invariant(actorId === commitment.sellerId, 'FORBIDDEN', 'only the seller may revoke the commitment');
      this.#expectVersion(commitment, expectedVersion);
      invariant(commitment.status === 'active', 'CONFLICT', 'only an active commitment may be revoked');
      const timestamp = this.#now();
      invariant(Date.parse(timestamp) < Date.parse(commitment.expiresAt), 'COMMITMENT_EXPIRED', 'commercial commitment has expired');
      commitment.status = 'revoked';
      commitment.revocation = { revokedAt: timestamp, revokedBy: actorId };
      commitment.version += 1;
      commitment.updatedAt = timestamp;
      this.#record('spaceeconomy.commercial-commitment.revoked.v1', `commercial-commitment/${commitment.id}`, {
        commitmentId: commitment.id,
        offerId: commitment.offerId,
        sellerId: commitment.sellerId,
        buyerId: commitment.buyerId,
        termsHash: commitment.termsHash,
      });
      return this.#viewCommercialCommitment(commitment, timestamp);
    });
  }

  exerciseCommercialCommitment(commitmentId, context) {
    return this.#command('commercial-commitment.exercise', context, { commitmentId }, ({ actorId, expectedVersion }) => {
      const commitment = this.#commercialCommitment(commitmentId);
      invariant(actorId === commitment.buyerId, 'FORBIDDEN', 'only the designated buyer may exercise the commitment');
      if (commitment.status === 'exercised') {
        invariant(commitment.orderId !== null, 'CORRUPT_STATE', 'exercised commitment is missing its order');
        return this.#order(commitment.orderId);
      }
      this.#expectVersion(commitment, expectedVersion);
      invariant(commitment.status === 'active', 'CONFLICT', 'commercial commitment is not active');

      const timestamp = this.#now();
      invariant(Date.parse(timestamp) < Date.parse(commitment.expiresAt), 'COMMITMENT_EXPIRED', 'commercial commitment has expired');
      const offer = this.offers.get(commitment.offerId);
      invariant(offer, 'CORRUPT_STATE', 'commercial commitment references a missing offer');
      invariant(offer.sellerId === commitment.sellerId, 'CORRUPT_STATE', 'commercial commitment seller no longer matches its offer');
      invariant(offer.status === 'open', 'CONFLICT', 'offer is not open');
      if (offer.windowEnd !== null) {
        invariant(Date.parse(timestamp) < Date.parse(offer.windowEnd), 'OFFER_WINDOW_CLOSED', 'offer service window has ended');
      }
      invariant(commitment.quantity <= offer.remaining, 'INSUFFICIENT_CAPACITY', 'insufficient capacity to exercise commercial commitment', {
        remaining: offer.remaining,
      });

      offer.remaining -= commitment.quantity;
      offer.status = offer.remaining === 0 ? 'filled' : 'open';
      offer.version += 1;
      offer.updatedAt = timestamp;

      const total = {
        ...commitment.unitPrice,
        amount: multiplyAmount(commitment.unitPrice.amount, commitment.quantity),
      };
      const fundingDueAt = commitment.reservationTtlSeconds === null
        ? null
        : this.#addSeconds(timestamp, commitment.reservationTtlSeconds, 'reservationTtlSeconds');
      const order = {
        id: this.idGenerator(),
        offerId: offer.id,
        assetId: offer.assetId,
        sellerId: commitment.sellerId,
        buyerId: commitment.buyerId,
        service: commitment.service,
        unit: commitment.unit,
        quantity: commitment.quantity,
        unitPrice: clone(commitment.unitPrice),
        total,
        status: 'reserved',
        fundingDueAt,
        funding: null,
        deliveryProof: null,
        settlement: null,
        expiration: null,
        commercialCommitment: {
          id: commitment.id,
          termsHash: commitment.termsHash,
        },
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.orders.set(order.id, order);

      commitment.status = 'exercised';
      commitment.orderId = order.id;
      commitment.exercisedAt = timestamp;
      commitment.version += 1;
      commitment.updatedAt = timestamp;

      this.#record('spaceeconomy.order.reserved.v1', `order/${order.id}`, {
        orderId: order.id,
        offerId: offer.id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        quantity: order.quantity,
        total: order.total,
        fundingDueAt: order.fundingDueAt,
        commercialCommitmentId: commitment.id,
        commercialTermsHash: commitment.termsHash,
      });
      this.#record('spaceeconomy.commercial-commitment.exercised.v1', `commercial-commitment/${commitment.id}`, {
        commitmentId: commitment.id,
        orderId: order.id,
        offerId: offer.id,
        sellerId: commitment.sellerId,
        buyerId: commitment.buyerId,
        termsHash: commitment.termsHash,
      });
      return order;
    });
  }

  createOrder(input, context) {
    return this.#command('order.reserve', context, input, ({ actorId, expectedVersion }) => {
      const offer = this.offers.get(input?.offerId);
      invariant(offer, 'NOT_FOUND', 'offer not found');
      invariant(offer.status === 'open', 'CONFLICT', 'offer is not open');
      this.#expectVersion(offer, expectedVersion);

      const timestamp = this.#now();
      if (offer.windowEnd !== null) {
        invariant(Date.parse(timestamp) < Date.parse(offer.windowEnd), 'OFFER_WINDOW_CLOSED', 'offer service window has ended');
      }
      const quantity = positiveInteger(input?.quantity, 'quantity');
      invariant(quantity <= offer.remaining, 'INSUFFICIENT_CAPACITY', 'insufficient capacity', { remaining: offer.remaining });
      invariant(actorId !== offer.sellerId, 'INVALID_REQUEST', 'buyer and seller must be different participants');

      offer.remaining -= quantity;
      offer.status = offer.remaining === 0 ? 'filled' : 'open';
      offer.version += 1;
      offer.updatedAt = timestamp;

      const total = { ...offer.unitPrice, amount: multiplyAmount(offer.unitPrice.amount, quantity) };
      const fundingDueAt = offer.reservationTtlSeconds === null
        ? null
        : this.#addSeconds(timestamp, offer.reservationTtlSeconds, 'reservationTtlSeconds');
      const order = {
        id: this.idGenerator(),
        offerId: offer.id,
        assetId: offer.assetId,
        sellerId: offer.sellerId,
        buyerId: actorId,
        service: offer.service,
        unit: offer.unit,
        quantity,
        unitPrice: clone(offer.unitPrice),
        total,
        status: 'reserved',
        fundingDueAt,
        funding: null,
        deliveryProof: null,
        settlement: null,
        expiration: null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.orders.set(order.id, order);
      this.#record('spaceeconomy.order.reserved.v1', `order/${order.id}`, {
        orderId: order.id,
        offerId: offer.id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        quantity: order.quantity,
        total: order.total,
        fundingDueAt: order.fundingDueAt,
      });
      return order;
    });
  }

  fundOrder(orderId, input, context) {
    return this.#command('order.fund', context, { orderId, ...input }, ({ actorId, expectedVersion }) => {
      const order = this.#order(orderId);
      this.#expectVersion(order, expectedVersion);
      invariant(order.status === 'reserved', 'CONFLICT', 'order is not awaiting funding');
      invariant(actorId === order.buyerId, 'FORBIDDEN', 'only the buyer may fund the order');
      const timestamp = this.#now();
      if (order.fundingDueAt !== null) {
        invariant(Date.parse(timestamp) < Date.parse(order.fundingDueAt), 'RESERVATION_EXPIRED', 'reservation funding deadline has passed', {
          fundingDueAt: order.fundingDueAt,
        });
      }
      const reference = nonEmptyString(input?.reference, 'reference');
      const supplied = { ...order.total, amount: nonEmptyString(input?.amount, 'amount') };
      invariant(sameAmount(supplied, order.total), 'INVALID_REQUEST', 'funding amount must equal the order total');

      order.funding = { amount: clone(order.total), reference, recordedAt: timestamp };
      order.status = 'funded';
      order.version += 1;
      order.updatedAt = timestamp;
      this.#record('spaceeconomy.order.funded.v1', `order/${order.id}`, {
        orderId: order.id,
        buyerId: actorId,
        amount: order.total,
        reference,
      });
      return order;
    });
  }

  recordDelivery(orderId, input, context) {
    return this.#command('order.deliver', context, { orderId, ...input }, ({ actorId, expectedVersion }) => {
      const order = this.#order(orderId);
      this.#expectVersion(order, expectedVersion);
      invariant(order.status === 'funded', 'CONFLICT', 'order must be funded before delivery');
      invariant(actorId === order.sellerId, 'FORBIDDEN', 'only the seller may record delivery');
      invariant(input?.proof && typeof input.proof === 'object' && !Array.isArray(input.proof), 'INVALID_REQUEST', 'proof is required');
      const type = nonEmptyString(input.proof.type, 'proof.type');
      const proofData = input.proof.data ?? {};
      const proofHash = sha256Canonical({ type, data: proofData });

      order.deliveryProof = {
        type,
        data: clone(proofData),
        hash: `sha256:${proofHash}`,
        verification: { status: 'unverified' },
        recordedAt: this.#now(),
      };
      order.status = 'delivered';
      order.version += 1;
      order.updatedAt = this.#now();
      this.#record('spaceeconomy.order.delivered.v1', `order/${order.id}`, {
        orderId: order.id,
        sellerId: actorId,
        proofType: type,
        proofHash: order.deliveryProof.hash,
      });
      return order;
    });
  }

  settleOrder(orderId, input, context) {
    return this.#command('order.settle', context, { orderId, ...input }, ({ actorId, expectedVersion }) => {
      const order = this.#order(orderId);
      this.#expectVersion(order, expectedVersion);
      invariant(order.status === 'delivered', 'CONFLICT', 'order is not ready to settle');
      invariant(actorId === order.buyerId, 'FORBIDDEN', 'only the buyer may approve settlement');
      const reference = nonEmptyString(input?.reference, 'reference');

      order.status = 'settled';
      order.version += 1;
      order.updatedAt = this.#now();
      order.settlement = {
        amount: clone(order.total),
        reference,
        approvedBy: actorId,
        settledAt: order.updatedAt,
      };
      this.#record('spaceeconomy.order.settled.v1', `order/${order.id}`, {
        orderId: order.id,
        buyerId: actorId,
        sellerId: order.sellerId,
        amount: order.total,
        reference,
      });
      return order;
    });
  }

  cancelOrder(orderId, context) {
    return this.#command('order.cancel', context, { orderId }, ({ actorId, expectedVersion }) => {
      const order = this.#order(orderId);
      this.#expectVersion(order, expectedVersion);
      invariant(order.status === 'reserved', 'CONFLICT', 'only an unfunded reservation may be cancelled');
      invariant(actorId === order.buyerId || actorId === order.sellerId, 'FORBIDDEN', 'actor is not a party to the order');
      const timestamp = this.#now();
      this.#releaseReservation(order, timestamp);
      order.status = 'cancelled';
      order.version += 1;
      order.updatedAt = timestamp;
      this.#record('spaceeconomy.order.cancelled.v1', `order/${order.id}`, { orderId: order.id, actorId });
      return order;
    });
  }

  expireOrder(orderId, context) {
    return this.#command('order.expire', context, { orderId }, ({ actorId, expectedVersion }) => {
      const order = this.#order(orderId);
      this.#expectVersion(order, expectedVersion);
      invariant(order.status === 'reserved', 'CONFLICT', 'only an unfunded reservation may expire');
      invariant(order.fundingDueAt !== null, 'RESERVATION_NOT_EXPIRABLE', 'reservation has no funding deadline');
      const timestamp = this.#now();
      invariant(Date.parse(timestamp) >= Date.parse(order.fundingDueAt), 'RESERVATION_NOT_DUE', 'reservation funding deadline has not been reached', {
        fundingDueAt: order.fundingDueAt,
      });

      this.#releaseReservation(order, timestamp);
      order.status = 'expired';
      order.version += 1;
      order.updatedAt = timestamp;
      order.expiration = {
        reason: 'funding-deadline',
        fundingDueAt: order.fundingDueAt,
        expiredAt: timestamp,
        triggeredBy: actorId,
      };
      this.#record('spaceeconomy.order.expired.v1', `order/${order.id}`, {
        orderId: order.id,
        offerId: order.offerId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        fundingDueAt: order.fundingDueAt,
        triggeredBy: actorId,
      });
      return order;
    });
  }

  getOrder(orderId) {
    return this.#read(() => clone(this.#order(orderId)));
  }

  getLedger() {
    return this.#read(() => clone(this.ledger));
  }

  getRevision() {
    return this.#read(() => this.revision);
  }

  verifyLedger() {
    return this.#read(() => this.#verifyLedgerNow());
  }

  #initializeEmpty() {
    this.assets = new Map();
    this.offers = new Map();
    this.orders = new Map();
    this.commercialCommitments = new Map();
    this.ledger = [];
    this.idempotency = new Map();
    this.revision = 0;
  }

  async #loadPersisted() {
    const persisted = await this.store.load();
    if (persisted) this.#restore(persisted);
  }

  #command(operation, rawContext, fingerprintData, mutator) {
    const execute = async () => {
      await this.initialization;
      const context = normalizeContext(rawContext);
      const fingerprint = sha256Canonical({ operation, actorId: context.actorId, input: fingerprintData });
      const idempotencyId = context.idempotencyKey ? `${context.actorId}\u0000${operation}\u0000${context.idempotencyKey}` : null;

      if (idempotencyId && this.idempotency.has(idempotencyId)) {
        const prior = this.idempotency.get(idempotencyId);
        invariant(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'idempotency key was already used with a different request');
        return clone(prior.result);
      }

      const before = this.#snapshot();
      const expectedRevision = this.revision;
      try {
        const result = await mutator(context);
        this.revision += 1;
        if (idempotencyId) {
          this.idempotency.set(idempotencyId, {
            fingerprint,
            result: clone(result),
            createdAt: this.#now(),
          });
        }
        await this.store.save(this.#snapshot(), { expectedRevision });
        return clone(result);
      } catch (error) {
        this.#restore(before, { verify: false });
        if (error instanceof StoreConflictError) {
          const latest = await this.store.load();
          if (latest) this.#restore(latest);
          else this.#initializeEmpty();
          throw new DomainError('STORE_CONFLICT', 'state changed concurrently; retry the command');
        }
        throw error;
      }
    };

    const pending = this.commandQueue.then(execute);
    this.commandQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #read(reader) {
    await this.initialization;
    const pendingCommands = this.commandQueue;
    await pendingCommands;
    return reader();
  }

  #expectVersion(resource, expectedVersion) {
    if (expectedVersion === null) return;
    invariant(resource.version === expectedVersion, 'STALE_VERSION', 'resource version changed', {
      expectedVersion,
      actualVersion: resource.version,
    });
  }

  #releaseReservation(order, timestamp) {
    const offer = this.offers.get(order.offerId);
    invariant(offer, 'CORRUPT_STATE', 'order references a missing offer');
    offer.remaining += order.quantity;
    invariant(offer.remaining <= offer.capacity, 'CORRUPT_STATE', 'offer capacity invariant violated');
    offer.status = 'open';
    offer.version += 1;
    offer.updatedAt = timestamp;
  }

  #record(type, subject, data) {
    const previoushash = this.ledger.at(-1)?.hash ?? 'GENESIS';
    const unsigned = {
      specversion: EVENT_SPEC_VERSION,
      id: this.idGenerator(),
      source: this.eventSource,
      type,
      subject,
      time: this.#now(),
      datacontenttype: 'application/json',
      sequence: this.ledger.length + 1,
      previoushash,
      data: clone(data),
    };
    this.ledger.push({ ...unsigned, hash: `sha256:${sha256Canonical(unsigned)}` });
  }

  #verifyLedgerNow() {
    let previousHash = 'GENESIS';
    for (let index = 0; index < this.ledger.length; index += 1) {
      const entry = this.ledger[index];
      const { hash, ...unsigned } = entry;
      if (entry.sequence !== index + 1) return false;
      if (entry.previoushash !== previousHash) return false;
      if (`sha256:${sha256Canonical(unsigned)}` !== hash) return false;
      previousHash = hash;
    }
    return true;
  }

  #order(id) {
    const order = this.orders.get(id);
    invariant(order, 'NOT_FOUND', 'order not found');
    return order;
  }

  #commercialCommitment(id) {
    const commitment = this.commercialCommitments.get(id);
    invariant(commitment, 'NOT_FOUND', 'commercial commitment not found');
    return commitment;
  }

  #viewCommercialCommitment(commitment, timestamp = null) {
    const view = clone(commitment);
    const observedAt = timestamp ?? this.#now();
    if (view.status === 'active' && Date.parse(observedAt) >= Date.parse(view.expiresAt)) {
      view.status = 'expired';
    }
    return view;
  }

  #validateWindow(start, end) {
    if (start === null && end === null) return;
    invariant(typeof start === 'string' && typeof end === 'string', 'INVALID_REQUEST', 'windowStart and windowEnd must both be RFC 3339 timestamps');
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    invariant(Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs, 'INVALID_REQUEST', 'offer window must have valid start < end');
  }

  #addSeconds(timestamp, seconds, field) {
    invariant(seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000), 'INVALID_REQUEST', `${field} is too large`);
    const milliseconds = Date.parse(timestamp) + (seconds * 1000);
    const value = new Date(milliseconds);
    invariant(Number.isFinite(value.getTime()), 'INVALID_REQUEST', `${field} produces an invalid funding deadline`);
    return value.toISOString();
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }

  #snapshot() {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: this.revision,
      assets: [...this.assets.values()].map((item) => clone(item)),
      offers: [...this.offers.values()].map((item) => clone(item)),
      orders: [...this.orders.values()].map((item) => clone(item)),
      commercialCommitments: [...this.commercialCommitments.values()].map((item) => clone(item)),
      ledger: clone(this.ledger),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]),
    };
  }

  #restore(state, { verify = true } = {}) {
    invariant(state?.schemaVersion === CURRENT_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', `unsupported state schema version: ${state?.schemaVersion ?? 'missing'}`);
    invariant(Number.isSafeInteger(state.revision) && state.revision >= 0, 'CORRUPT_STATE', 'state revision is invalid');
    this.assets = new Map((state.assets ?? []).map((item) => [item.id, item]));
    this.offers = new Map((state.offers ?? []).map((item) => [item.id, item]));
    this.orders = new Map((state.orders ?? []).map((item) => [item.id, item]));
    this.commercialCommitments = new Map((state.commercialCommitments ?? []).map((item) => [item.id, item]));
    this.ledger = state.ledger ?? [];
    this.idempotency = new Map(state.idempotency ?? []);
    this.revision = state.revision;
    if (verify) invariant(this.#verifyLedgerNow(), 'CORRUPT_STATE', 'persisted ledger failed integrity verification');
  }
}
