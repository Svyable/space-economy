import { createHash } from 'node:crypto';

function serialize(value, seen) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      if (!value.isWellFormed()) throw new TypeError('canonical JSON requires well-formed Unicode strings');
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError('canonical JSON does not support cyclic values');
      seen.add(value);
      try {
        if (Array.isArray(value)) return `[${value.map((item) => serialize(item, seen)).join(',')}]`;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('canonical JSON requires plain objects');
        }
        const fields = Object.keys(value)
          .sort()
          .map((key) => {
            if (!key.isWellFormed()) throw new TypeError('canonical JSON requires well-formed Unicode property names');
            if (value[key] === undefined) throw new TypeError('canonical JSON does not support undefined');
            return `${JSON.stringify(key)}:${serialize(value[key], seen)}`;
          });
        return `{${fields.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
}

/**
 * RFC 8785-compatible canonicalization for the I-JSON values used by this project.
 */
export function canonicalize(value) {
  return serialize(value, new Set());
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
