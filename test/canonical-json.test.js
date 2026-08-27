import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, sha256Canonical } from '../src/canonical-json.js';

test('canonicalizes object keys deterministically', () => {
  assert.equal(canonicalize({ z: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"z":1}');
  assert.equal(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ b: 2, a: 1 }));
});

test('rejects values outside the supported I-JSON domain', () => {
  assert.throws(() => canonicalize({ bad: Number.NaN }), /finite/);
  assert.throws(() => canonicalize({ bad: undefined }), /undefined/);
  assert.throws(() => canonicalize('\uD800'), /well-formed Unicode/);
  assert.throws(() => canonicalize('\uFDD0'), /noncharacters/);
  assert.throws(() => canonicalize({ ['\uFFFF']: true }), /noncharacters/);
  assert.throws(() => canonicalize(-0), /negative zero/);
});
