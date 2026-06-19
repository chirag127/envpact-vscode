/**
 * envpact-vscode sync — TypeScript port of envpact-cli/lib/sync.js.
 * Per-key pull/push pipeline for vault schema v3.
 *
 * Lock file (`.env.example.lock`) lives next to .env.example and
 * captures the last successful sync state per key. NEVER stores values.
 *
 *   {
 *     "version": 1,
 *     "keys": {
 *       "<KEY>": {
 *         "vault_modified_at": "<ISO>",
 *         "synced_at":         "<ISO>"
 *       }
 *     }
 *   }
 *
 * State enumeration (spec §1.3):
 *   synced | local_newer | vault_newer | both_diverged
 *   | local_only | vault_only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Vault, VaultEntry } from './resolver';
import { entryValue, entryModifiedAt, SHARED_PREFIX } from './resolver';

export const LOCK_VERSION = 1;
export const LOCK_FILENAME = '.env.example.lock';

export type KeyStatus =
  | 'synced'
  | 'local_newer'
  | 'vault_newer'
  | 'both_diverged'
  | 'local_only'
  | 'vault_only';

export interface LockEntry {
  vault_modified_at: string | null;
  synced_at: string;
}

export interface Lock {
  version: number;
  keys: Record<string, LockEntry>;
}

// ---------------------------------------------------------------
// Lock file I/O
// ---------------------------------------------------------------

export function lockPathFor(envExamplePath: string): string {
  return `${envExamplePath}.lock`;
}

/** Compute the lock path for a workspace root (uses .env.example). */
export function lockPathForWorkspace(workspaceRoot: string): string {
  return path.join(workspaceRoot, LOCK_FILENAME);
}

export function loadLock(envExamplePath: string): Lock {
  const file = lockPathFor(envExamplePath);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return { version: LOCK_VERSION, keys: {} };
    throw e;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid lock shape in ${file}: not an object`);
  }
  if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {};
  parsed.version = parsed.version || LOCK_VERSION;
  return parsed as Lock;
}

export function saveLock(envExamplePath: string, lock: Lock): void {
  const file = lockPathFor(envExamplePath);
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function newLockEntry(vaultModifiedAt: string | null | undefined): LockEntry {
  return {
    vault_modified_at: vaultModifiedAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------
// State classification
// ---------------------------------------------------------------

/**
 * Classify one key's sync state. Inputs may be undefined to indicate
 * absence:
 *   - localValue:  string or undefined (key absent from .env)
 *   - vaultEntry:  v3 entry { value, _modified_at } or undefined
 *   - lockEntry:   { vault_modified_at, synced_at } or undefined
 *
 * Returns one of the six KeyStatus strings from spec §1.3.
 */
export function getKeyStatus(
  localValue: string | undefined,
  vaultEntry: VaultEntry | undefined,
  lockEntry: LockEntry | undefined,
): KeyStatus {
  const haveLocal = typeof localValue === 'string';
  const haveVault =
    vaultEntry !== undefined &&
    typeof vaultEntry === 'object' &&
    typeof vaultEntry.value === 'string';

  if (haveLocal && !haveVault) return 'local_only';
  if (!haveLocal && haveVault) return 'vault_only';
  if (!haveLocal && !haveVault) {
    return 'synced';
  }

  const v = vaultEntry as VaultEntry;
  const vaultMod = v._modified_at || null;
  const lockMod = lockEntry ? lockEntry.vault_modified_at || null : null;
  const valueMatches = localValue === v.value;
  const vaultMoved = vaultMod !== lockMod;

  if (!lockEntry) {
    return valueMatches ? 'synced' : 'both_diverged';
  }

  if (valueMatches && !vaultMoved) return 'synced';
  if (valueMatches && vaultMoved) return 'vault_newer';
  if (!valueMatches && !vaultMoved) return 'local_newer';
  return 'both_diverged';
}

// ---------------------------------------------------------------
// Vault entry resolution (one-level shared deref)
// ---------------------------------------------------------------

/**
 * Resolve the v3 entry the caller will pull. For project keys the
 * entry may itself be a `shared.<KEY>` reference; we follow ONE level
 * into vault.shared. Returns the leaf entry the caller should write
 * (with its source `_modified_at`).
 */
export function resolveVaultEntry(
  vault: Vault,
  projectName: string,
  key: string,
): VaultEntry | undefined {
  const project = (vault.projects || {})[projectName];
  if (!project) return undefined;
  const entry = project[key];
  if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string') {
    return undefined;
  }
  if (entry.value.startsWith(SHARED_PREFIX)) {
    const sharedKey = entry.value.slice(SHARED_PREFIX.length);
    const sharedEntry = (vault.shared || {})[sharedKey];
    if (
      sharedEntry &&
      typeof sharedEntry === 'object' &&
      typeof sharedEntry.value === 'string'
    ) {
      // Use the shared entry's value, but keep the project entry's
      // _modified_at as the conflict-detection baseline.
      return {
        value: sharedEntry.value,
        _modified_at: entry._modified_at,
      };
    }
  }
  return entry;
}

/**
 * Resolve a shared key's entry directly (for shared-only pulls).
 */
export function resolveSharedEntry(
  vault: Vault,
  key: string,
): VaultEntry | undefined {
  const sharedEntry = (vault.shared || {})[key];
  if (
    sharedEntry &&
    typeof sharedEntry === 'object' &&
    typeof sharedEntry.value === 'string'
  ) {
    return sharedEntry;
  }
  return undefined;
}

// ---------------------------------------------------------------
// Pull / Push
// ---------------------------------------------------------------

export class SyncConflictError extends Error {
  status: KeyStatus;
  key: string;
  constructor(status: KeyStatus, key: string) {
    super(`sync conflict on ${key}: ${status}. Re-run with force.`);
    this.name = 'SyncConflictError';
    this.status = status;
    this.key = key;
  }
}

export interface PullKeyArgs {
  projectName: string;
  key: string;
  vault: Vault;
  localEnvMap: Record<string, string>;
  lock: Lock;
  force?: boolean;
  /** When true, key lives in vault.shared, not vault.projects[name]. */
  shared?: boolean;
}

export interface PullKeyResult {
  newLocalValue: string;
  newLockEntry: LockEntry;
  status: KeyStatus;
}

/**
 * Pull one key. Throws SyncConflictError on local_newer / both_diverged
 * when force is false. Throws on KEY_NOT_IN_VAULT.
 */
export function pullKey({
  projectName,
  key,
  vault,
  localEnvMap,
  lock,
  force = false,
  shared = false,
}: PullKeyArgs): PullKeyResult {
  const entry = shared
    ? resolveSharedEntry(vault, key)
    : resolveVaultEntry(vault, projectName, key);
  if (!entry) {
    const e: any = new Error(`KEY_NOT_IN_VAULT: ${key}`);
    e.code = 'KEY_NOT_IN_VAULT';
    throw e;
  }

  const localValue = (localEnvMap || {})[key];
  const lockEntry = lock && lock.keys ? lock.keys[key] : undefined;
  const status = getKeyStatus(localValue, entry, lockEntry);

  if (!force && (status === 'local_newer' || status === 'both_diverged')) {
    throw new SyncConflictError(status, key);
  }

  return {
    newLocalValue: entry.value,
    newLockEntry: newLockEntry(entry._modified_at),
    status,
  };
}

export interface PushKeyArgs {
  projectName: string;
  key: string;
  vault: Vault;
  localValue: string;
  lock: Lock;
  force?: boolean;
  shared?: boolean;
}

export interface PushKeyResult {
  newVaultEntry: VaultEntry;
  newLockEntry: LockEntry;
  status: KeyStatus;
}

/**
 * Push one key. Throws SyncConflictError on vault_newer / both_diverged
 * when force is false. Throws KEY_NOT_IN_LOCAL when localValue is
 * undefined.
 */
export function pushKey({
  projectName,
  key,
  vault,
  localValue,
  lock,
  force = false,
  shared = false,
}: PushKeyArgs): PushKeyResult {
  if (typeof localValue !== 'string') {
    const e: any = new Error(`KEY_NOT_IN_LOCAL: ${key}`);
    e.code = 'KEY_NOT_IN_LOCAL';
    throw e;
  }

  const existing = shared
    ? (vault.shared || {})[key]
    : ((vault.projects || {})[projectName] || {})[key];
  const lockEntry = lock && lock.keys ? lock.keys[key] : undefined;

  let status: KeyStatus;
  if (!existing) {
    status = 'local_only';
  } else {
    status = getKeyStatus(localValue, existing as VaultEntry, lockEntry);
  }

  if (!force && (status === 'vault_newer' || status === 'both_diverged')) {
    throw new SyncConflictError(status, key);
  }

  const now = new Date().toISOString();
  const newEntry: VaultEntry = { value: localValue, _modified_at: now };
  return {
    newVaultEntry: newEntry,
    newLockEntry: newLockEntry(now),
    status,
  };
}

// ---------------------------------------------------------------
// Bulk status report
// ---------------------------------------------------------------

export interface KeyStatusRow {
  key: string;
  scope: 'project' | 'shared';
  status: KeyStatus;
  vault_modified_at: string | null;
  lock_modified_at: string | null;
}

/**
 * Compute per-key sync status across a project. Reads vault, .env,
 * and the lock — never writes. Includes every key present in either
 * .env or the project's vault entries (deduplicated and sorted).
 *
 * `shared` keys referenced via `shared.<KEY>` show up under the
 * project name (the project entry IS the user-visible row); pure
 * shared-only keys are not enumerated here — the Sync panel scopes
 * to one project at a time.
 */
export function statusReport(
  vault: Vault,
  projectName: string,
  localEnvMap: Record<string, string>,
  lock: Lock,
): KeyStatusRow[] {
  const project = (vault.projects || {})[projectName] || {};
  const allKeys = new Set<string>([
    ...Object.keys(localEnvMap),
    ...Object.keys(project).filter((k) => !k.startsWith('_')),
  ]);
  const rows: KeyStatusRow[] = [];
  for (const key of [...allKeys].sort()) {
    const entry = resolveVaultEntry(vault, projectName, key);
    const localValue = localEnvMap[key];
    const lockEntry = lock.keys[key];
    const status = getKeyStatus(localValue, entry, lockEntry);
    rows.push({
      key,
      scope: 'project',
      status,
      vault_modified_at: entry ? entryModifiedAt(entry) || null : null,
      lock_modified_at: lockEntry ? lockEntry.vault_modified_at || null : null,
    });
  }
  return rows;
}
