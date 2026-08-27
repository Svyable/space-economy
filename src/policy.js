import { sha256Canonical } from './canonical-json.js';

const clone = (value) => structuredClone(value);
const DECISIONS = new Set(['allow', 'deny', 'review']);

export class PolicyEvaluationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PolicyEvaluationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new PolicyEvaluationError(code, message, details);
}

function nonEmptyString(value, field) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_POLICY_REQUEST', `${field} is required`);
  return value.trim();
}

function normalizeGate(gateId, gate) {
  invariant(gate && typeof gate === 'object' && !Array.isArray(gate), 'INVALID_POLICY_GATE', 'policy gate must be an object');
  const version = nonEmptyString(gate.version, 'gate.version');
  invariant(typeof gate.evaluate === 'function', 'INVALID_POLICY_GATE', 'gate.evaluate must be a function');
  return { gateId, version, evaluate: gate.evaluate };
}

function normalizeResult(raw, descriptor, evaluatedAt) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_POLICY_RESULT', 'policy gate must return an object');
  invariant(DECISIONS.has(raw.decision), 'INVALID_POLICY_RESULT', 'policy decision must be allow, deny, or review');
  const result = {
    gateId: descriptor.gateId,
    gateVersion: descriptor.version,
    decision: raw.decision,
    reason: nonEmptyString(raw.reason, 'policy result reason'),
    evaluatedAt,
  };
  if (raw.claims !== undefined) {
    invariant(raw.claims && typeof raw.claims === 'object' && !Array.isArray(raw.claims), 'INVALID_POLICY_RESULT', 'policy claims must be an object');
    result.claims = clone(raw.claims);
  }
  if (raw.evidence !== undefined) {
    invariant(Array.isArray(raw.evidence), 'INVALID_POLICY_RESULT', 'policy evidence must be an array');
    result.evidence = clone(raw.evidence);
  }
  result.decisionHash = `sha256:${sha256Canonical(result)}`;
  return result;
}

function aggregateDecision(results) {
  if (results.some((result) => result.decision === 'deny')) return 'deny';
  if (results.some((result) => result.decision === 'review')) return 'review';
  return 'allow';
}

/**
 * Deployment policy engine for pre-command gates.
 *
 * The clearinghouse kernel remains policy-agnostic. Applications/gateways can
 * evaluate one or more attributable gates before invoking a domain command and
 * preserve the resulting decision bundle as an audit artifact.
 */
export class PolicyGateEngine {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.gates = new Map();
  }

  register(gateId, gate) {
    const id = nonEmptyString(gateId, 'gateId');
    invariant(!this.gates.has(id), 'POLICY_GATE_EXISTS', `policy gate already registered: ${id}`);
    this.gates.set(id, normalizeGate(id, gate));
    return this;
  }

  listGates() {
    return [...this.gates.keys()].sort();
  }

  async evaluate({ operation, actor, resource = null, context = {} }) {
    const normalizedOperation = nonEmptyString(operation, 'operation');
    invariant(actor && typeof actor === 'object' && !Array.isArray(actor), 'INVALID_POLICY_REQUEST', 'actor is required');
    invariant(typeof actor.actorId === 'string' && actor.actorId.trim().length > 0, 'INVALID_POLICY_REQUEST', 'actor.actorId is required');
    invariant(resource === null || (typeof resource === 'object' && !Array.isArray(resource)), 'INVALID_POLICY_REQUEST', 'resource must be an object or null');
    invariant(context && typeof context === 'object' && !Array.isArray(context), 'INVALID_POLICY_REQUEST', 'context must be an object');

    const request = {
      operation: normalizedOperation,
      actor: clone(actor),
      resource: clone(resource),
      context: clone(context),
    };

    const results = [];
    for (const descriptor of [...this.gates.values()].sort((left, right) => left.gateId.localeCompare(right.gateId))) {
      let raw;
      try {
        raw = await descriptor.evaluate(clone(request));
      } catch (error) {
        throw new PolicyEvaluationError('POLICY_GATE_FAILED', `policy gate failed: ${descriptor.gateId}`, {
          gateId: descriptor.gateId,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      results.push(normalizeResult(raw, descriptor, this.#now()));
    }

    const evaluation = {
      operation: normalizedOperation,
      actorId: actor.actorId.trim(),
      decision: aggregateDecision(results),
      results,
    };
    evaluation.evaluationHash = `sha256:${sha256Canonical(evaluation)}`;
    return evaluation;
  }

  async requireAllowed(request) {
    const evaluation = await this.evaluate(request);
    invariant(evaluation.decision === 'allow', 'POLICY_NOT_ALLOWED', `policy decision requires ${evaluation.decision === 'review' ? 'manual review' : 'denial'}`, {
      decision: evaluation.decision,
      evaluationHash: evaluation.evaluationHash,
      results: evaluation.results,
    });
    return evaluation;
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}
