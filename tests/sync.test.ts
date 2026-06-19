import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getKeyStatus,
  pullKey,
  pushKey,
  resolveVaultEntry,
  loadLock,
  saveLock,
  statusReport,
  SyncConflictError,
  Lock,
} from '../src/sync';
import type { Vault, VaultEntry } from '../src/resolver';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-sync-'));
}

function freshVault(): Vault {
  return {
    version: 3,
    shared: {},
    projects: {},
    metadata: { updated_at: '2026-06-19T10:00:00Z' },
  };
}

function entry(value: string, ts: string): VaultEntry {
  return { value, _modified_at: ts };
}

const T0 = '2026-06-19T10:00:00.000Z';
const T1 = '2026-06-19T11:00:00.000Z';

// ── status enumeration: all 6 states ───────────────────────────────────

test('getKeyStatus: synced when local matches and lock matches vault mtime', () => {
  const s = getKeyStatus('v', entry('v', T0), { vault_modified_at: T0, synced_at: T0 });
  assert.equal(s, 'synced');
});

test('getKeyStatus: local_newer when local differs and vault unchanged from lock', () => {
  const s = getKeyStatus('local-edit', entry('vault-v', T0), { vault_modified_at: T0, synced_at: T0 });
  assert.equal(s, 'local_newer');
});

test('getKeyStatus: vault_newer when vault advanced past lock and local matches lock value', () => {
  // values match — lock baseline is older than vault — that means user
  // is already on the vault value but lock is stale.
  const s = getKeyStatus('v', entry('v', T1), { vault_modified_at: T0, synced_at: T0 });
  assert.equal(s, 'vault_newer');
});

test('getKeyStatus: both_diverged when vault advanced AND values differ', () => {
  const s = getKeyStatus('local-edit', entry('vault-new', T1), { vault_modified_at: T0, synced_at: T0 });
  assert.equal(s, 'both_diverged');
});

test('getKeyStatus: local_only when only local has the key', () => {
  const s = getKeyStatus('v', undefined, undefined);
  assert.equal(s, 'local_only');
});

test('getKeyStatus: vault_only when only vault has the key', () => {
  const s = getKeyStatus(undefined, entry('v', T0), undefined);
  assert.equal(s, 'vault_only');
});

test('getKeyStatus: no lock + matching values → synced; mismatch → both_diverged', () => {
  assert.equal(getKeyStatus('v', entry('v', T0), undefined), 'synced');
  assert.equal(getKeyStatus('a', entry('b', T0), undefined), 'both_diverged');
});

// ── pullKey ────────────────────────────────────────────────────────────

test('pullKey: happy path — vault_only is non-conflict', () => {
  const v = freshVault();
  v.projects!.p = { K: entry('vault-v', T0) };
  const result = pullKey({
    projectName: 'p', key: 'K', vault: v,
    localEnvMap: {}, lock: { version: 1, keys: {} }, force: false,
  });
  assert.equal(result.newLocalValue, 'vault-v');
  assert.equal(result.status, 'vault_only');
});

test('pullKey: local_newer → SyncConflictError unless force', () => {
  const v = freshVault();
  v.projects!.p = { K: entry('vault-v', T0) };
  const lock: Lock = { version: 1, keys: { K: { vault_modified_at: T0, synced_at: T0 } } };
  assert.throws(() => pullKey({
    projectName: 'p', key: 'K', vault: v,
    localEnvMap: { K: 'edited' }, lock, force: false,
  }), SyncConflictError);

  // force=true succeeds.
  const r = pullKey({
    projectName: 'p', key: 'K', vault: v,
    localEnvMap: { K: 'edited' }, lock, force: true,
  });
  assert.equal(r.newLocalValue, 'vault-v');
});

test('pullKey: both_diverged → SyncConflictError', () => {
  const v = freshVault();
  v.projects!.p = { K: entry('vault-new', T1) };
  const lock: Lock = { version: 1, keys: { K: { vault_modified_at: T0, synced_at: T0 } } };
  assert.throws(() => pullKey({
    projectName: 'p', key: 'K', vault: v,
    localEnvMap: { K: 'local-edit' }, lock, force: false,
  }), SyncConflictError);
});

test('pullKey: KEY_NOT_IN_VAULT when missing', () => {
  const v = freshVault();
  v.projects!.p = {};
  try {
    pullKey({
      projectName: 'p', key: 'M', vault: v,
      localEnvMap: {}, lock: { version: 1, keys: {} }, force: false,
    });
    assert.fail('should have thrown');
  } catch (e: any) {
    assert.equal(e.code, 'KEY_NOT_IN_VAULT');
  }
});

test('pullKey: shared.<KEY> deref returns shared value but project mtime', () => {
  const v = freshVault();
  v.shared!.TOK = entry('actual-secret', T1);
  v.projects!.p = { TOK: entry('shared.TOK', T0) };
  const r = pullKey({
    projectName: 'p', key: 'TOK', vault: v,
    localEnvMap: {}, lock: { version: 1, keys: {} }, force: false,
  });
  assert.equal(r.newLocalValue, 'actual-secret');
  assert.equal(r.newLockEntry.vault_modified_at, T0); // project mtime, not shared
});

// ── pushKey ────────────────────────────────────────────────────────────

test('pushKey: happy path — local_only is non-conflict', () => {
  const v = freshVault();
  const r = pushKey({
    projectName: 'p', key: 'K', vault: v,
    localValue: 'new', lock: { version: 1, keys: {} }, force: false,
  });
  assert.equal(r.newVaultEntry.value, 'new');
  assert.equal(r.status, 'local_only');
  assert.match(r.newVaultEntry._modified_at, /^\d{4}-/);
});

test('pushKey: vault_newer → SyncConflictError unless force', () => {
  const v = freshVault();
  v.projects!.p = { K: entry('v', T1) };
  const lock: Lock = { version: 1, keys: { K: { vault_modified_at: T0, synced_at: T0 } } };
  assert.throws(() => pushKey({
    projectName: 'p', key: 'K', vault: v,
    localValue: 'v', lock, force: false,
  }), SyncConflictError);
  const r = pushKey({
    projectName: 'p', key: 'K', vault: v,
    localValue: 'v', lock, force: true,
  });
  assert.equal(r.newVaultEntry.value, 'v');
});

test('pushKey: KEY_NOT_IN_LOCAL when localValue is undefined', () => {
  const v = freshVault();
  try {
    pushKey({
      projectName: 'p', key: 'K', vault: v,
      localValue: undefined as any, lock: { version: 1, keys: {} }, force: false,
    });
    assert.fail('should have thrown');
  } catch (e: any) {
    assert.equal(e.code, 'KEY_NOT_IN_LOCAL');
  }
});

// ── resolveVaultEntry ──────────────────────────────────────────────────

test('resolveVaultEntry: returns undefined for unknown project', () => {
  const v = freshVault();
  assert.equal(resolveVaultEntry(v, 'absent', 'K'), undefined);
});

// ── lock file I/O ──────────────────────────────────────────────────────

test('loadLock: missing file → empty lock', () => {
  const dir = tmpDir();
  const examplePath = path.join(dir, '.env.example');
  const lock = loadLock(examplePath);
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.keys, {});
});

test('loadLock: round-trip via saveLock', () => {
  const dir = tmpDir();
  const examplePath = path.join(dir, '.env.example');
  const lock: Lock = {
    version: 1,
    keys: { K: { vault_modified_at: T0, synced_at: T1 } },
  };
  saveLock(examplePath, lock);
  const loaded = loadLock(examplePath);
  assert.equal(loaded.keys.K.vault_modified_at, T0);
  assert.equal(loaded.keys.K.synced_at, T1);
});

test('loadLock: corrupt JSON throws', () => {
  const dir = tmpDir();
  const examplePath = path.join(dir, '.env.example');
  fs.writeFileSync(`${examplePath}.lock`, '{not json');
  assert.throws(() => loadLock(examplePath), /Invalid JSON/);
});

// ── statusReport ───────────────────────────────────────────────────────

test('statusReport: classifies every project key', () => {
  const v = freshVault();
  v.projects!.p = {
    SYNCED: entry('v', T0),
    LOCAL_NEWER: entry('v', T0),
    VAULT_ONLY: entry('vv', T0),
  };
  const localMap = {
    SYNCED: 'v',
    LOCAL_NEWER: 'edited',
    LOCAL_ONLY: 'lo',
  };
  const lock: Lock = {
    version: 1,
    keys: {
      SYNCED: { vault_modified_at: T0, synced_at: T0 },
      LOCAL_NEWER: { vault_modified_at: T0, synced_at: T0 },
    },
  };
  const rows = statusReport(v, 'p', localMap, lock);
  const m = new Map(rows.map((r) => [r.key, r.status]));
  assert.equal(m.get('SYNCED'), 'synced');
  assert.equal(m.get('LOCAL_NEWER'), 'local_newer');
  assert.equal(m.get('LOCAL_ONLY'), 'local_only');
  assert.equal(m.get('VAULT_ONLY'), 'vault_only');
});
