import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();

function assert(condition, message, code = 'INVALID_REQUEST') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function hashEvent(event) {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export class Clearinghouse {
  constructor({ statePath = null } = {}) {
    this.statePath = statePath;
    this.assets = new Map();
    this.offers = new Map();
    this.orders = new Map();
    this.ledger = [];
    if (statePath && fs.existsSync(statePath)) this.#load();
  }

  registerAsset(input) {
    assert(input?.owner, 'owner is required');
    assert(input?.name, 'name is required');
    assert(input?.type, 'type is required');
    const asset = {
      id: randomUUID(),
      owner: input.owner,
      name: input.name,
      type: input.type,
      capabilities: input.capabilities ?? [],
      location: input.location ?? null,
      metadata: input.metadata ?? {},
      status: 'active',
      createdAt: now(),
    };
    this.assets.set(asset.id, asset);
    this.#record('asset.registered', { assetId: asset.id, owner: asset.owner, type: asset.type });
    this.#persist();
    return clone(asset);
  }

  listAssets() {
    return [...this.assets.values()].map(clone);
  }

  createOffer(input) {
    const asset = this.assets.get(input?.assetId);
    assert(asset, 'asset not found', 'NOT_FOUND');
    assert(input.seller === asset.owner, 'seller must own the asset', 'FORBIDDEN');
    assert(input.service, 'service is required');
    assert(input.unit, 'unit is required');
    assert(Number.isFinite(input.pricePerUnit) && input.pricePerUnit > 0, 'pricePerUnit must be positive');
    assert(Number.isFinite(input.capacity) && input.capacity > 0, 'capacity must be positive');
    assert(input.currency, 'currency is required');

    const offer = {
      id: randomUUID(),
      assetId: asset.id,
      seller: input.seller,
      service: input.service,
      unit: input.unit,
      pricePerUnit: input.pricePerUnit,
      currency: input.currency,
      capacity: input.capacity,
      remaining: input.capacity,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      metadata: input.metadata ?? {},
      status: 'open',
      createdAt: now(),
    };
    this.offers.set(offer.id, offer);
    this.#record('offer.created', { offerId: offer.id, assetId: offer.assetId, service: offer.service });
    this.#persist();
    return clone(offer);
  }

  listOffers({ service, status = 'open' } = {}) {
    return [...this.offers.values()]
      .filter((offer) => (!service || offer.service === service) && (!status || offer.status === status))
      .map(clone);
  }

  createOrder(input) {
    const offer = this.offers.get(input?.offerId);
    assert(offer, 'offer not found', 'NOT_FOUND');
    assert(offer.status === 'open', 'offer is not open', 'CONFLICT');
    assert(input?.buyer, 'buyer is required');
    assert(Number.isFinite(input.quantity) && input.quantity > 0, 'quantity must be positive');
    assert(input.quantity <= offer.remaining, 'insufficient capacity', 'INSUFFICIENT_CAPACITY');

    offer.remaining -= input.quantity;
    if (offer.remaining === 0) offer.status = 'filled';

    const order = {
      id: randomUUID(),
      offerId: offer.id,
      assetId: offer.assetId,
      seller: offer.seller,
      buyer: input.buyer,
      service: offer.service,
      unit: offer.unit,
      quantity: input.quantity,
      pricePerUnit: offer.pricePerUnit,
      currency: offer.currency,
      total: Number((input.quantity * offer.pricePerUnit).toFixed(8)),
      escrowed: 0,
      status: 'reserved',
      deliveryProof: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.orders.set(order.id, order);
    this.#record('order.reserved', { orderId: order.id, offerId: offer.id, quantity: order.quantity, buyer: order.buyer });
    this.#persist();
    return clone(order);
  }

  fundOrder(orderId, { buyer, amount }) {
    const order = this.#order(orderId);
    assert(order.status === 'reserved', 'order is not awaiting funding', 'CONFLICT');
    assert(buyer === order.buyer, 'only the buyer may fund the order', 'FORBIDDEN');
    assert(Number.isFinite(amount) && amount === order.total, `amount must equal ${order.total}`);
    order.escrowed = amount;
    order.status = 'funded';
    order.updatedAt = now();
    this.#record('order.funded', { orderId, buyer, amount, currency: order.currency });
    this.#persist();
    return clone(order);
  }

  recordDelivery(orderId, { seller, proof }) {
    const order = this.#order(orderId);
    assert(order.status === 'funded', 'order must be funded before delivery', 'CONFLICT');
    assert(seller === order.seller, 'only the seller may record delivery', 'FORBIDDEN');
    assert(proof && typeof proof === 'object', 'proof is required');
    order.deliveryProof = { ...proof, recordedAt: now() };
    order.status = 'delivered';
    order.updatedAt = now();
    this.#record('order.delivered', { orderId, seller, proofHash: hashEvent(proof) });
    this.#persist();
    return clone(order);
  }

  settleOrder(orderId, { buyer }) {
    const order = this.#order(orderId);
    assert(order.status === 'delivered', 'order is not ready to settle', 'CONFLICT');
    assert(buyer === order.buyer, 'only the buyer may approve settlement', 'FORBIDDEN');
    const settlement = {
      amount: order.escrowed,
      currency: order.currency,
      from: order.buyer,
      to: order.seller,
      settledAt: now(),
    };
    order.status = 'settled';
    order.updatedAt = settlement.settledAt;
    order.settlement = settlement;
    this.#record('order.settled', { orderId, ...settlement });
    this.#persist();
    return clone(order);
  }

  cancelOrder(orderId, { actor }) {
    const order = this.#order(orderId);
    assert(['reserved', 'funded'].includes(order.status), 'order can no longer be cancelled', 'CONFLICT');
    assert(actor === order.buyer || actor === order.seller, 'actor is not a party to the order', 'FORBIDDEN');
    const offer = this.offers.get(order.offerId);
    offer.remaining += order.quantity;
    offer.status = 'open';
    order.status = 'cancelled';
    order.updatedAt = now();
    this.#record('order.cancelled', { orderId, actor });
    this.#persist();
    return clone(order);
  }

  getOrder(orderId) {
    return clone(this.#order(orderId));
  }

  getLedger() {
    return clone(this.ledger);
  }

  verifyLedger() {
    let previousHash = 'GENESIS';
    for (const entry of this.ledger) {
      const { hash, ...unsigned } = entry;
      if (unsigned.previousHash !== previousHash) return false;
      if (hashEvent(unsigned) !== hash) return false;
      previousHash = hash;
    }
    return true;
  }

  #order(id) {
    const order = this.orders.get(id);
    assert(order, 'order not found', 'NOT_FOUND');
    return order;
  }

  #record(type, payload) {
    const previousHash = this.ledger.at(-1)?.hash ?? 'GENESIS';
    const unsigned = {
      sequence: this.ledger.length + 1,
      type,
      payload,
      timestamp: now(),
      previousHash,
    };
    this.ledger.push({ ...unsigned, hash: hashEvent(unsigned) });
  }

  #persist() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      assets: [...this.assets.values()],
      offers: [...this.offers.values()],
      orders: [...this.orders.values()],
      ledger: this.ledger,
    }, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  #load() {
    const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    this.assets = new Map((state.assets ?? []).map((item) => [item.id, item]));
    this.offers = new Map((state.offers ?? []).map((item) => [item.id, item]));
    this.orders = new Map((state.orders ?? []).map((item) => [item.id, item]));
    this.ledger = state.ledger ?? [];
    assert(this.verifyLedger(), 'persisted ledger failed integrity verification', 'CORRUPT_STATE');
  }
}
