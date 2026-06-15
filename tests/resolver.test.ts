import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, resolveString, validateVault } from '../src/resolver';
import {
  pickEncryptionFailure,
  stripEncrypted,
  formatEncryptionErrorMessage,
} from '../src/encryption-guard';

const v = {
  version: 2,
  shared: { K: 'sv' },
  projects: {
    p: {
      _default_env: 'production',
      A: 'shared.K',
      B: { production: 'pv', development: 'dv' },
    },
  },
} as any;

test('resolveProject default env', () => {
  const r = resolveProject(v, 'p');
  assert.equal(r.resolved.A, 'sv');
  assert.equal(r.resolved.B, 'pv');
});

test('resolveProject explicit env', () => {
  assert.equal(resolveProject(v, 'p', 'development').resolved.B, 'dv');
});

test('resolveString shared lookup', () => {
  assert.deepEqual(resolveString('shared.X', { X: 'val' }), { value: 'val', status: 'ok' });
});

test('validateVault rejects bad input', () => {
  assert.throws(() => validateVault({ version: 99 }));
});

// ---------------------------------------------------------------------------
// Audit #6 — encrypted-leaf handling for the VS Code slice.
// The extension cannot decrypt `enc:` values; helpers below ensure we
// surface the failure cleanly rather than leaking ciphertext into a .env.
// ---------------------------------------------------------------------------

test('resolver still flags enc: values via result.encrypted', () => {
  const vault = {
    version: 2,
    shared: { TOKEN: 'enc:age-secret' },
    projects: {
      mixed: {
        PLAIN: 'hello',
        SECRET: 'shared.TOKEN',
        DIRECT: 'enc:age-direct',
      },
    },
  } as any;
  const r = resolveProject(vault, 'mixed');
  assert.deepEqual(r.encrypted.sort(), ['DIRECT', 'SECRET']);
  // Encrypted leaves are kept in `resolved` here — that is by design;
  // the guard layer is what removes them.
  assert.equal(r.resolved.DIRECT, 'enc:age-direct');
  assert.equal(r.resolved.SECRET, 'enc:age-secret');
  assert.equal(r.resolved.PLAIN, 'hello');
});

test('pickEncryptionFailure returns null for clean results', () => {
  const r = resolveProject(v, 'p');
  assert.equal(pickEncryptionFailure(r), null);
});

test('pickEncryptionFailure surfaces sorted, deduped keys with environment', () => {
  const fake = {
    resolved: { Z: 'enc:x', A: 'enc:y', M: 'plain' },
    unresolved: [],
    invalid: [],
    encrypted: ['Z', 'A', 'A'],
    environment: 'production',
    missing: false,
  } as any;
  const failure = pickEncryptionFailure(fake);
  assert.notEqual(failure, null);
  assert.deepEqual(failure!.keys, ['A', 'Z']);
  assert.equal(failure!.environment, 'production');

  // Sort stability: re-running on a permuted input yields the same order.
  const fake2 = { ...fake, encrypted: ['A', 'Z'] } as any;
  const failure2 = pickEncryptionFailure(fake2);
  assert.deepEqual(failure!.keys, failure2!.keys);
});

test('stripEncrypted returns a clean copy without mutating the input', () => {
  const original = {
    resolved: { OK: 'val', ENC: 'enc:abc' },
    unresolved: [],
    invalid: [],
    encrypted: ['ENC'],
    environment: 'default',
    missing: false,
  } as any;
  const cleaned = stripEncrypted(original);
  // Purity — the original is untouched.
  assert.equal(original.resolved.ENC, 'enc:abc');
  assert.deepEqual(Object.keys(original.resolved).sort(), ['ENC', 'OK']);
  // Cleanliness — encrypted leaves are gone from the copy.
  assert.deepEqual(Object.keys(cleaned.resolved), ['OK']);
  assert.equal(cleaned.resolved.OK, 'val');
  assert.equal(cleaned.environment, 'default');
  // No-op path: no encrypted leaves means the original is returned as-is.
  const passthrough = stripEncrypted({ ...original, encrypted: [], resolved: { OK: 'val' } } as any);
  assert.equal(passthrough.resolved.OK, 'val');
});

test('formatEncryptionErrorMessage mentions project, env, keys, and remediation', () => {
  const failure = { keys: ['A', 'B'], environment: 'staging' };
  const msg = formatEncryptionErrorMessage('billing-svc', 'staging', failure);
  assert.match(msg, /billing-svc/);
  assert.match(msg, /staging/);
  assert.match(msg, /A, B/);
  assert.match(msg, /envpact-cli/);
  assert.match(msg, /age private key/);
  // Singular wording when there's exactly one key.
  const single = formatEncryptionErrorMessage('p', 'default', { keys: ['ONLY'], environment: 'default' });
  assert.match(single, /1 encrypted secret/);
});
