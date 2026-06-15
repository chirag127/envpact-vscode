import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, resolveString, validateVault } from '../src/resolver';

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
