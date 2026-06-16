// Tests for the v0.4.0 sync push logic.
//
// Conflict policy under test:
//   1. Local values overwrite remote on key collision
//   2. Remote-only keys preserved (never deleted)
//   3. Local-only keys promoted to SHARED namespace
//   4. shared.* references update the SHARED value, not the project ref

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pushLocalEnvToVault, summarisePlan } from '../src/sync';
import type { Vault } from '../src/resolver';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-sync-'));
}

function writeEnv(dir: string, content: string): string {
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, content);
  return p;
}

function freshVault(): Vault {
  return {
    version: 2,
    projects: {},
    shared: {},
    metadata: { updated_at: '2026-01-01T00:00:00Z' },
  } as Vault;
}

// ── conflict policy ────────────────────────────────────────────────────

test('pushLocalEnvToVault: local value wins over remote on collision', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = { API_KEY: 'old-remote' };
  const dir = tmpDir();
  const f = writeEnv(dir, 'API_KEY=new-local\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  assert.strictEqual(v.projects!['chirag127/app'].API_KEY, 'new-local');
  assert.deepStrictEqual(plan.overwritten, ['API_KEY']);
});

test('pushLocalEnvToVault: remote-only keys preserved (never deleted)', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = { KEEP_ME: 'remote-only', LOCAL_KEY: 'old' };
  const dir = tmpDir();
  const f = writeEnv(dir, 'LOCAL_KEY=updated\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  assert.strictEqual(v.projects!['chirag127/app'].KEEP_ME, 'remote-only');
  assert.deepStrictEqual(plan.remoteOnlyKept, ['KEEP_ME']);
});

test('pushLocalEnvToVault: brand-new local keys are promoted to SHARED', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = {};
  const dir = tmpDir();
  const f = writeEnv(dir, 'NEW_KEY=secret-value\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  assert.strictEqual(v.shared!.NEW_KEY, 'secret-value');
  assert.strictEqual(v.projects!['chirag127/app'].NEW_KEY, 'shared.NEW_KEY');
  assert.deepStrictEqual(plan.promotedToShared, ['NEW_KEY']);
});

test('pushLocalEnvToVault: shared.* reference updates the shared value, not the ref', () => {
  const v = freshVault();
  v.shared!.OPENAI_KEY = 'sk-old';
  v.projects!['chirag127/app'] = { OPENAI_KEY: 'shared.OPENAI_KEY' };
  const dir = tmpDir();
  const f = writeEnv(dir, 'OPENAI_KEY=sk-new\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  // Shared value updated; project still has the reference.
  assert.strictEqual(v.shared!.OPENAI_KEY, 'sk-new');
  assert.strictEqual(v.projects!['chirag127/app'].OPENAI_KEY, 'shared.OPENAI_KEY');
  assert.deepStrictEqual(plan.overwritten, ['OPENAI_KEY']);
});

test('pushLocalEnvToVault: identical values are unchanged (no-op)', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = { API_KEY: 'same' };
  const dir = tmpDir();
  const f = writeEnv(dir, 'API_KEY=same\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  assert.deepStrictEqual(plan.overwritten, []);
  assert.deepStrictEqual(plan.unchanged, ['API_KEY']);
});

test('pushLocalEnvToVault: per-environment slot updates default when no env passed', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = {
    API_KEY: { default: 'old-default', production: 'old-prod' },
  };
  const dir = tmpDir();
  const f = writeEnv(dir, 'API_KEY=new-default\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  const slot = v.projects!['chirag127/app'].API_KEY as Record<string, string>;
  assert.strictEqual(slot.default, 'new-default');
  // Production slot must be untouched.
  assert.strictEqual(slot.production, 'old-prod');
  assert.deepStrictEqual(plan.overwritten, ['API_KEY']);
});

test('pushLocalEnvToVault: per-environment slot honours explicit environment arg', () => {
  const v = freshVault();
  v.projects!['chirag127/app'] = {
    API_KEY: { default: 'd', production: 'old-prod' },
  };
  const dir = tmpDir();
  const f = writeEnv(dir, 'API_KEY=new-prod\n');
  pushLocalEnvToVault(v, 'chirag127/app', f, 'production');
  const slot = v.projects!['chirag127/app'].API_KEY as Record<string, string>;
  assert.strictEqual(slot.production, 'new-prod');
  assert.strictEqual(slot.default, 'd');
});

test('pushLocalEnvToVault: shared key already present, project gets ref auto-wired', () => {
  const v = freshVault();
  v.shared!.GLOBAL_TOKEN = 'tk-1';
  v.projects!['chirag127/app'] = {};
  const dir = tmpDir();
  const f = writeEnv(dir, 'GLOBAL_TOKEN=tk-1\n');
  const plan = pushLocalEnvToVault(v, 'chirag127/app', f);
  assert.strictEqual(v.projects!['chirag127/app'].GLOBAL_TOKEN, 'shared.GLOBAL_TOKEN');
  assert.deepStrictEqual(plan.addedToProject, ['GLOBAL_TOKEN']);
});

// ── summary ────────────────────────────────────────────────────────────

test('summarisePlan: empty plan reads "no changes"', () => {
  assert.strictEqual(
    summarisePlan({
      overwritten: [], promotedToShared: [], addedToProject: [],
      remoteOnlyKept: [], unchanged: [],
    }),
    'no changes',
  );
});

test('summarisePlan: combined plan summarises everything', () => {
  const s = summarisePlan({
    overwritten: ['A', 'B'],
    promotedToShared: ['C'],
    addedToProject: ['C'],
    remoteOnlyKept: ['Z'],
    unchanged: ['X'],
  });
  assert.match(s, /2 updated/);
  assert.match(s, /1 promoted to shared/);
  assert.match(s, /1 remote-only kept/);
});
