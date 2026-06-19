import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setProjectSecret,
  setSharedSecret,
  ensureProjectExists,
  findReferencingProjects,
} from '../src/vault';
import type { Vault } from '../src/resolver';

function freshVault(): Vault {
  return {
    version: 3,
    shared: {},
    projects: {},
    metadata: { updated_at: '2026-06-19T10:00:00Z' },
  };
}

test('setProjectSecret stamps _modified_at', () => {
  const v = freshVault();
  setProjectSecret(v, 'p', 'K', 'value');
  const entry = v.projects!.p.K;
  assert.equal(entry.value, 'value');
  assert.match(entry._modified_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('setProjectSecret accepts caller-supplied modifiedAt', () => {
  const v = freshVault();
  setProjectSecret(v, 'p', 'K', 'value', '2026-01-01T00:00:00Z');
  assert.equal(v.projects!.p.K._modified_at, '2026-01-01T00:00:00Z');
});

test('setSharedSecret stamps _modified_at', () => {
  const v = freshVault();
  setSharedSecret(v, 'TOKEN', 'sk-abc');
  const entry = v.shared!.TOKEN;
  assert.equal(entry.value, 'sk-abc');
  assert.match(entry._modified_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('ensureProjectExists is idempotent', () => {
  const v = freshVault();
  ensureProjectExists(v, 'p');
  v.projects!.p.X = { value: '1', _modified_at: '2026-01-01T00:00:00Z' };
  ensureProjectExists(v, 'p');
  assert.equal(v.projects!.p.X.value, '1');
});

test('findReferencingProjects walks v3 entries', () => {
  const v = freshVault();
  setSharedSecret(v, 'OPENAI', 'sk-x');
  setProjectSecret(v, 'a', 'OPENAI_KEY', 'shared.OPENAI');
  setProjectSecret(v, 'b', 'O', 'shared.OPENAI');
  setProjectSecret(v, 'c', 'plain', 'literal');
  const refs = findReferencingProjects(v, 'OPENAI');
  assert.equal(refs.length, 2);
  const projects = refs.map((r) => r.project).sort();
  assert.deepEqual(projects, ['a', 'b']);
});
