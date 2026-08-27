import { sha256Canonical } from './canonical-json.js';

const clone = (value) => structuredClone(value);
const STATUS = new Set(['valid', 'invalid', 'indeterminate']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class CredentialVerificationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CredentialVerificationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invariant(condition, code, message, details) {
  if (!condition) throw new CredentialVerificationError(code, message, details);
}

function nonEmptyString(value, field, code = 'INVALID_CREDENTIAL_REQUEST') {
  invariant(typeof value === 'string' && value.trim().length > 0, code, `${field} is required`);
  return value.trim();
}

function plainObject(value, field, code) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), code, `${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${field} must be a plain object`);
  return clone(value);
}

function optionalTimestamp(value, field) {
  if (value === null || value === undefined) return null;
  const normalized = nonEmptyString(value, field, 'INVALID_VERIFIER_RESULT');
  invariant(RFC3339.test(normalized), 'INVALID_VERIFIER_RESULT', `${field} must be an RFC 3339 timestamp`);
  const milliseconds = Date.parse(normalized);
  invariant(Number.isFinite(milliseconds), 'INVALID_VERIFIER_RESULT', `${field} must be a valid RFC 3339 timestamp`);
  return new Date(milliseconds).toISOString();
}

function stringArray(value, field) {
  if (value === undefined) return [];
  invariant(Array.isArray(value), 'INVALID_VERIFIER_RESULT', `${field} must be an array`);
  const normalized = value.map((item, index) => nonEmptyString(item, `${field}[${index}]`, 'INVALID_VERIFIER_RESULT'));
  invariant(new Set(normalized).size === normalized.length, 'INVALID_VERIFIER_RESULT', `${field} must not contain duplicates`);
  return normalized.sort();
}

function evidenceArray(value) {
  if (value === undefined) return [];
  invariant(Array.isArray(value), 'INVALID_VERIFIER_RESULT', 'evidence must be an array');
  return value.map((item, index) => plainObject(item, `evidence[${index}]`, 'INVALID_VERIFIER_RESULT'));
}

function normalizeResult(raw, { profile, credentialHash, verifiedAt, expectedSubjectId }) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_VERIFIER_RESULT', 'credential verifier must return an object');
  invariant(STATUS.has(raw.status), 'INVALID_VERIFIER_RESULT', 'credential status must be valid, invalid, or indeterminate');

  let status = raw.status;
  let reason = raw.reason === undefined ? null : nonEmptyString(raw.reason, 'reason', 'INVALID_VERIFIER_RESULT');
  const subjectId = raw.subjectId === undefined || raw.subjectId === null
    ? null
    : nonEmptyString(raw.subjectId, 'subjectId', 'INVALID_VERIFIER_RESULT');
  const issuerId = raw.issuerId === undefined || raw.issuerId === null
    ? null
    : nonEmptyString(raw.issuerId, 'issuerId', 'INVALID_VERIFIER_RESULT');

  if (status === 'valid') {
    invariant(subjectId !== null, 'INVALID_VERIFIER_RESULT', 'valid credential result requires subjectId');
    invariant(issuerId !== null, 'INVALID_VERIFIER_RESULT', 'valid credential result requires issuerId');
  }

  let subjectMatches = null;
  if (expectedSubjectId !== null) {
    subjectMatches = subjectId === expectedSubjectId;
    if (status === 'valid' && !subjectMatches) {
      status = 'invalid';
      reason = 'credential subject does not match expected subject';
    }
  }

  const result = {
    profile,
    credentialHash,
    status,
    verifierId: nonEmptyString(raw.verifierId, 'verifierId', 'INVALID_VERIFIER_RESULT'),
    profileVersion: nonEmptyString(raw.profileVersion, 'profileVersion', 'INVALID_VERIFIER_RESULT'),
    subjectId,
    issuerId,
    subjectMatches,
    types: stringArray(raw.types, 'types'),
    claims: raw.claims === undefined ? {} : plainObject(raw.claims, 'claims', 'INVALID_VERIFIER_RESULT'),
    evidence: evidenceArray(raw.evidence),
    validFrom: optionalTimestamp(raw.validFrom, 'validFrom'),
    validUntil: optionalTimestamp(raw.validUntil, 'validUntil'),
    verifiedAt,
  };
  if (reason !== null) result.reason = reason;
  result.attestationHash = `sha256:${sha256Canonical(result)}`;
  return result;
}

/**
 * Registry for deployment-specific credential verification profiles.
 *
 * The registry does not implement any W3C VC proof suite, X.509 chain rules,
 * DID method, or organizational registry by itself. Profiles are adapters that
 * normalize those systems into attributable authority claims.
 */
export class CredentialVerifierRegistry {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.verifiers = new Map();
  }

  register(profile, verifier) {
    const id = nonEmptyString(profile, 'profile');
    invariant(typeof verifier === 'function', 'INVALID_VERIFIER', 'credential verifier must be a function');
    invariant(!this.verifiers.has(id), 'VERIFIER_EXISTS', `credential verifier already registered for ${id}`);
    this.verifiers.set(id, verifier);
    return this;
  }

  listProfiles() {
    return [...this.verifiers.keys()].sort();
  }

  async verify({ profile, credential, expectedSubjectId = null, context = {} }) {
    const id = nonEmptyString(profile, 'profile');
    const verifier = this.verifiers.get(id);
    invariant(verifier, 'UNSUPPORTED_CREDENTIAL_PROFILE', `no credential verifier registered for ${id}`);
    const normalizedCredential = plainObject(credential, 'credential', 'INVALID_CREDENTIAL_REQUEST');
    const normalizedContext = plainObject(context, 'context', 'INVALID_CREDENTIAL_REQUEST');
    const expected = expectedSubjectId === null
      ? null
      : nonEmptyString(expectedSubjectId, 'expectedSubjectId');
    const credentialHash = `sha256:${sha256Canonical(normalizedCredential)}`;
    const verifiedAt = this.#now();

    const raw = await verifier({
      credential: clone(normalizedCredential),
      credentialHash,
      expectedSubjectId: expected,
      context: clone(normalizedContext),
      verifiedAt,
    });

    return normalizeResult(raw, {
      profile: id,
      credentialHash,
      verifiedAt,
      expectedSubjectId: expected,
    });
  }

  async requireValid(request) {
    const attestation = await this.verify(request);
    invariant(attestation.status === 'valid', 'CREDENTIAL_NOT_VALID', `credential verification returned ${attestation.status}`, {
      status: attestation.status,
      attestationHash: attestation.attestationHash,
      attestation,
    });
    return attestation;
  }

  #now() {
    const value = this.clock();
    invariant(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CONFIGURATION', 'clock must return a valid Date');
    return value.toISOString();
  }
}

/**
 * Convenience adapter for using a credential verifier as a mandatory policy
 * gate. Invalid credentials deny; indeterminate verification requires review.
 */
export function createCredentialPolicyGate({
  registry,
  profile,
  credentialProvider,
  version = '1',
  missingDecision = 'deny',
}) {
  invariant(registry instanceof CredentialVerifierRegistry, 'INVALID_CONFIGURATION', 'registry must be a CredentialVerifierRegistry');
  invariant(typeof credentialProvider === 'function', 'INVALID_CONFIGURATION', 'credentialProvider must be a function');
  invariant(missingDecision === 'deny' || missingDecision === 'review', 'INVALID_CONFIGURATION', 'missingDecision must be deny or review');
  const normalizedProfile = nonEmptyString(profile, 'profile');
  const normalizedVersion = nonEmptyString(version, 'version');

  return {
    version: normalizedVersion,
    async evaluate(policyRequest) {
      const supplied = await credentialProvider(clone(policyRequest));
      if (supplied === null || supplied === undefined) {
        return {
          decision: missingDecision,
          reason: `required credential missing for profile ${normalizedProfile}`,
          claims: { credentialProfile: normalizedProfile },
        };
      }

      const credential = plainObject(supplied, 'credentialProvider result', 'INVALID_CREDENTIAL_REQUEST');
      const attestation = await registry.verify({
        profile: normalizedProfile,
        credential,
        expectedSubjectId: policyRequest.actor?.actorId ?? null,
        context: {
          operation: policyRequest.operation,
          policyContext: policyRequest.context ?? {},
        },
      });

      const decision = attestation.status === 'valid'
        ? 'allow'
        : attestation.status === 'invalid' ? 'deny' : 'review';
      return {
        decision,
        reason: attestation.reason ?? `credential verification returned ${attestation.status}`,
        claims: {
          credentialProfile: normalizedProfile,
          credentialAttestationHash: attestation.attestationHash,
          credentialClaims: attestation.claims,
        },
        evidence: [{
          credentialHash: attestation.credentialHash,
          verifierId: attestation.verifierId,
          profileVersion: attestation.profileVersion,
        }],
      };
    },
  };
}
