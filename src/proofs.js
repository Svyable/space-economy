import { sha256Canonical } from './canonical-json.js';

const clone = (value) => structuredClone(value);
const STATUS = new Set(['verified', 'rejected', 'indeterminate']);

export class ProofVerificationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProofVerificationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new ProofVerificationError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_PROOF', `${field} is required`);
  return value.trim();
}

function normalizeEvidence(evidence = []) {
  invariant(Array.isArray(evidence), 'INVALID_VERIFIER_RESULT', 'evidence must be an array');
  return evidence.map((item, index) => {
    invariant(item && typeof item === 'object' && !Array.isArray(item), 'INVALID_VERIFIER_RESULT', `evidence[${index}] must be an object`);
    return clone(item);
  });
}

function normalizeResult(raw, { proofType, proofHash, verifiedAt }) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_VERIFIER_RESULT', 'verifier must return an object');
  invariant(STATUS.has(raw.status), 'INVALID_VERIFIER_RESULT', 'verifier status must be verified, rejected, or indeterminate');
  const verifierId = nonEmptyString(raw.verifierId, 'verifierId');
  const profileVersion = nonEmptyString(raw.profileVersion, 'profileVersion');

  const result = {
    proofType,
    proofHash,
    status: raw.status,
    verifierId,
    profileVersion,
    verifiedAt,
    evidence: normalizeEvidence(raw.evidence),
  };

  if (raw.claims !== undefined) {
    invariant(raw.claims && typeof raw.claims === 'object' && !Array.isArray(raw.claims), 'INVALID_VERIFIER_RESULT', 'claims must be an object');
    result.claims = clone(raw.claims);
  }
  if (raw.reason !== undefined) result.reason = nonEmptyString(raw.reason, 'reason');

  result.attestationHash = `sha256:${sha256Canonical(result)}`;
  return result;
}

/**
 * Registry for versioned, service-specific delivery proof verifiers.
 *
 * The clearinghouse can record arbitrary proof envelopes without understanding
 * their semantics. This registry is the boundary where a deployment chooses
 * which proof types it trusts and how those proofs are interpreted.
 */
export class ProofVerifierRegistry {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.verifiers = new Map();
  }

  register(proofType, verifier) {
    const type = nonEmptyString(proofType, 'proofType');
    invariant(typeof verifier === 'function', 'INVALID_VERIFIER', 'verifier must be a function');
    invariant(!this.verifiers.has(type), 'VERIFIER_EXISTS', `verifier already registered for ${type}`);
    this.verifiers.set(type, verifier);
    return this;
  }

  has(proofType) {
    return this.verifiers.has(proofType);
  }

  listTypes() {
    return [...this.verifiers.keys()].sort();
  }

  async verify({ order, proof, context = {} }) {
    invariant(order && typeof order === 'object' && !Array.isArray(order), 'INVALID_PROOF', 'order is required');
    invariant(proof && typeof proof === 'object' && !Array.isArray(proof), 'INVALID_PROOF', 'proof is required');
    const proofType = nonEmptyString(proof.type, 'proof.type');
    const verifier = this.verifiers.get(proofType);
    invariant(verifier, 'UNSUPPORTED_PROOF_TYPE', `no verifier registered for ${proofType}`);

    const proofData = proof.data ?? {};
    invariant(proofData && typeof proofData === 'object' && !Array.isArray(proofData), 'INVALID_PROOF', 'proof.data must be an object');
    const normalizedProof = { type: proofType, data: clone(proofData) };
    const proofHash = `sha256:${sha256Canonical(normalizedProof)}`;
    const verifiedAt = this.#now();

    const raw = await verifier({
      order: clone(order),
      proof: clone(normalizedProof),
      proofHash,
      context: clone(context),
      verifiedAt,
    });

    return normalizeResult(raw, { proofType, proofHash, verifiedAt });
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}

/**
 * Deterministic reference verifier for quantity receipts.
 *
 * This is intentionally not a telemetry oracle. It demonstrates the adapter
 * contract by checking that a receipt claims exactly the contracted quantity
 * and unit. Deployments should replace it with evidence-backed profiles.
 */
export function createExactQuantityReceiptVerifier({
  verifierId = 'spaceeconomy:reference:exact-quantity',
  profileVersion = '1',
} = {}) {
  return async ({ order, proof }) => {
    const deliveredQuantity = proof.data?.deliveredQuantity;
    const deliveredUnit = proof.data?.unit;
    const quantityMatches = Number.isSafeInteger(deliveredQuantity) && deliveredQuantity === order.quantity;
    const unitMatches = deliveredUnit === order.unit;
    const status = quantityMatches && unitMatches ? 'verified' : 'rejected';

    return {
      status,
      verifierId,
      profileVersion,
      reason: status === 'verified' ? 'receipt matches contracted quantity and unit' : 'receipt does not match contracted quantity and unit',
      claims: {
        deliveredQuantity: Number.isSafeInteger(deliveredQuantity) ? deliveredQuantity : null,
        unit: typeof deliveredUnit === 'string' ? deliveredUnit : null,
      },
      evidence: [],
    };
  };
}
