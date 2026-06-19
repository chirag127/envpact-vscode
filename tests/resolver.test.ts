import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProject,
  resolveString,
  validateVault,
  upgradeVault,
  maskValue,
  entryValue,
  entryModifiedAt,
} from '../src/resolver';
import {
  pickEncryptionFailure,
  stripEncrypted,
  formatEncryptionErrorMessage,
} from '../src/encryption-guard';

// ── v3 happy paths ─────────────────────────────────────────────────────

const v3 = {
  version: 3,
  shared: {
    K: { value: 'sv', _modified_at: '2026-06-19T10:00:00Z' },
  },
  projects: {
    p: {
      A: { value: 'shared.K', _modified_at: '2026-06-19T10:00:00Z' },
      B: { value: 'plain', _modified_at: '2026-06-19T10:01:00Z' },
    },
  },
} as any;

test('resolveProject v3: shared deref', () => {
  const r = resolveProject(v3, 'p');
  assert.equal(r.resolved.A, 'sv');
  assert.equal(r.resolved.B, 'plain');
  assert.equal(r.missing, false);
});

test('resolveProject v3: missing project', () => {
  const r = resolveProject(v3, 'absent');
  assert.equal(r.missing, true);
  assert.deepEqual(r.resolved, {});
});

test('resolveProject v3: unresolved shared key', () => {
  const v = {
    version: 3,
    shared: {},
    projects: {
      p: { A: { value: 'shared.MISSING', _modified_at: '2026-06-19T10:00:00Z' } },
    },
  } as any;
  const r = resolveProject(v, 'p');
  assert.deepEqual(r.unresolved, ['A']);
});

test('resolveProject v3: invalid shape (no value)', () => {
  const v = {
    version: 3,
    shared: {},
    projects: { p: { A: { not_value: 'oops', _modified_at: 'x' } } },
  } as any;
  const r = resolveProject(v, 'p');
  assert.deepEqual(r.invalid, ['A']);
});

test('resolveProject v3: encrypted leaf passthrough', () => {
  const v = {
    version: 3,
    shared: {},
    projects: {
      p: {
        E: { value: 'enc:abc', _modified_at: '2026-06-19T10:00:00Z' },
      },
    },
  } as any;
  const r = resolveProject(v, 'p');
  assert.deepEqual(r.encrypted, ['E']);
  assert.equal(r.resolved.E, 'enc:abc');
});

test('resolveProject v3: encrypted via shared deref', () => {
  const v = {
    version: 3,
    shared: { S: { value: 'enc:zzz', _modified_at: '2026-06-19T10:00:00Z' } },
    projects: {
      p: { K: { value: 'shared.S', _modified_at: '2026-06-19T10:00:00Z' } },
    },
  } as any;
  const r = resolveProject(v, 'p');
  assert.deepEqual(r.encrypted, ['K']);
});

test('resolveString blocks chained shared. references', () => {
  const r = resolveString('shared.X', { X: { value: 'shared.Y', _modified_at: '' } });
  assert.equal(r.status, 'invalid');
});

test('validateVault rejects unknown version', () => {
  assert.throws(() => validateVault({ version: 99 }));
});

// ── v1/v2 → v3 auto-upgrade ────────────────────────────────────────────

test('upgradeVault: v1 (flat strings) becomes v3 entry shape', () => {
  const v1 = {
    version: 1,
    shared: { K: 'sv' },
    projects: { p: { A: 'plain', B: 'shared.K' } },
    metadata: { updated_at: '2026-06-15T00:00:00Z' },
  } as any;
  const upgraded = upgradeVault(v1);
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.shared!.K.value, 'sv');
  assert.equal(upgraded.projects!.p.A.value, 'plain');
  // Resolution should match v3 semantics now.
  const r = resolveProject(v1, 'p');
  assert.equal(r.resolved.A, 'plain');
  assert.equal(r.resolved.B, 'sv');
});

test('upgradeVault: v2 per-env objects pick default, then production, then first', () => {
  const v2 = {
    version: 2,
    shared: { K: 'sv' },
    projects: {
      p: {
        _default_env: 'production',
        ALPHA: { default: 'd-val', production: 'p-val' },
        BETA: { production: 'p-only' },
        GAMMA: { staging: 's-only' },
      },
    },
    metadata: { updated_at: '2026-06-15T00:00:00Z' },
  } as any;
  const r = resolveProject(v2, 'p');
  // default wins over production.
  assert.equal(r.resolved.ALPHA, 'd-val');
  // production picked when default missing.
  assert.equal(r.resolved.BETA, 'p-only');
  // first non-empty wins when default + production both absent.
  assert.equal(r.resolved.GAMMA, 's-only');
});

test('upgradeVault: drops _default_env and other underscore keys', () => {
  const v2 = {
    version: 2,
    shared: {},
    projects: { p: { _default_env: 'staging', _internal: 'x', K: 'v' } },
  } as any;
  const upgraded = upgradeVault(v2);
  assert.ok(!('_default_env' in upgraded.projects!.p));
  assert.ok(!('_internal' in upgraded.projects!.p));
  assert.equal(upgraded.projects!.p.K.value, 'v');
});

test('upgradeVault: v3 input is normalised, not double-upgraded', () => {
  const upgraded = upgradeVault(v3);
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.shared!.K.value, 'sv');
});

// ── entry helpers ──────────────────────────────────────────────────────

test('entryValue / entryModifiedAt extract fields', () => {
  const entry = { value: 'v', _modified_at: '2026-06-19T10:00:00Z' };
  assert.equal(entryValue(entry), 'v');
  assert.equal(entryModifiedAt(entry), '2026-06-19T10:00:00Z');
  assert.equal(entryValue('string'), undefined);
  assert.equal(entryModifiedAt({}), undefined);
});

// ── maskValue ──────────────────────────────────────────────────────────

test('maskValue: short values collapse to bullets', () => {
  assert.equal(maskValue('short'), '••••');
  assert.equal(maskValue(''), '••••');
});

test('maskValue: long values reveal first 3 + last 3 chars', () => {
  const m = maskValue('sk_live_abcdef1234567890');
  assert.match(m, /^sk_/);
  assert.match(m, /890$/);
  assert.match(m, /••••/);
});

// ── encryption guard (carry-over from v0.2.0) ──────────────────────────

test('resolver still flags enc: values via result.encrypted', () => {
  const vault = {
    version: 3,
    shared: { TOKEN: { value: 'enc:age-secret', _modified_at: '2026-06-19T10:00:00Z' } },
    projects: {
      mixed: {
        PLAIN: { value: 'hello', _modified_at: '2026-06-19T10:00:00Z' },
        SECRET: { value: 'shared.TOKEN', _modified_at: '2026-06-19T10:00:00Z' },
        DIRECT: { value: 'enc:age-direct', _modified_at: '2026-06-19T10:00:00Z' },
      },
    },
  } as any;
  const r = resolveProject(vault, 'mixed');
  assert.deepEqual(r.encrypted.sort(), ['DIRECT', 'SECRET']);
  assert.equal(r.resolved.PLAIN, 'hello');
});

test('pickEncryptionFailure null + non-null', () => {
  const r = resolveProject(v3, 'p');
  assert.equal(pickEncryptionFailure(r), null);

  const fake = {
    resolved: { Z: 'enc:x', A: 'enc:y', M: 'plain' },
    unresolved: [],
    invalid: [],
    encrypted: ['Z', 'A', 'A'],
    missing: false,
  } as any;
  const failure = pickEncryptionFailure(fake);
  assert.notEqual(failure, null);
  assert.deepEqual(failure!.keys, ['A', 'Z']);
});

test('stripEncrypted purity', () => {
  const original = {
    resolved: { OK: 'val', ENC: 'enc:abc' },
    unresolved: [],
    invalid: [],
    encrypted: ['ENC'],
    missing: false,
  } as any;
  const cleaned = stripEncrypted(original);
  assert.equal(original.resolved.ENC, 'enc:abc');
  assert.deepEqual(Object.keys(cleaned.resolved), ['OK']);
});

test('formatEncryptionErrorMessage mentions project, keys, remediation', () => {
  const failure = { keys: ['A', 'B'] };
  const msg = formatEncryptionErrorMessage('billing-svc', failure);
  assert.match(msg, /billing-svc/);
  assert.match(msg, /A, B/);
  assert.match(msg, /envpact-cli/);
  assert.match(msg, /age private key/);
  const single = formatEncryptionErrorMessage('p', { keys: ['ONLY'] });
  assert.match(single, /1 encrypted secret/);
});
