/**
 * envpact vault — load/save secrets.json with v1/v2 → v3 in-memory
 * upgrade. v3 leaves: every shared/project entry is
 *   { value: string, _modified_at: ISO8601 }
 *
 * Reads upgrade in memory only — the on-disk file is rewritten only
 * on a mutating save.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Vault, VaultEntry, validateVault, upgradeVault, ENC_PREFIX, entryValue } from './resolver';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
export const CONFIG_DIR = path.join(HOME, '.envpact');
export const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v3.json';
const VAULT_SCHEMA_VERSION = 3;

export function vaultExists(): boolean {
  return fs.existsSync(SECRETS_FILE);
}

export function loadVault(): Vault {
  if (!vaultExists()) {
    throw new Error(
      'envpact vault not initialised. Run "envpact: Initialize Vault" first.'
    );
  }
  const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  validateVault(parsed);
  return upgradeVault(parsed);
}

export function saveVault(vault: Vault): void {
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = (vault.version || VAULT_SCHEMA_VERSION) as 3;
  if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const tmp = `${SECRETS_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SECRETS_FILE);
}

export function ensureProjectExists(vault: Vault, projectName: string): void {
  if (!vault.projects) vault.projects = {};
  if (!vault.projects[projectName]) vault.projects[projectName] = {};
}

/**
 * Set a project secret to `value`. Stamps `_modified_at` with the
 * current ISO timestamp (or the caller-supplied one). v3 has no
 * environment parameter.
 */
export function setProjectSecret(
  vault: Vault,
  project: string,
  key: string,
  value: string,
  modifiedAt?: string,
): void {
  ensureProjectExists(vault, project);
  vault.projects![project][key] = {
    value: String(value),
    _modified_at: modifiedAt || new Date().toISOString(),
  };
}

/**
 * Set a shared secret to `value`. Stamps `_modified_at`.
 */
export function setSharedSecret(
  vault: Vault,
  key: string,
  value: string,
  modifiedAt?: string,
): void {
  if (!vault.shared) vault.shared = {};
  vault.shared[key] = {
    value: String(value),
    _modified_at: modifiedAt || new Date().toISOString(),
  };
}

/**
 * Find every (project, key) tuple whose value is `shared.<sharedKey>`.
 */
export function findReferencingProjects(vault: Vault, sharedKey: string) {
  const refs: { project: string; key: string }[] = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, entry] of Object.entries(proj || {})) {
      if (k.startsWith('_')) continue;
      const v = entryValue(entry);
      if (v === ref) refs.push({ project: pname, key: k });
    }
  }
  return refs;
}

export function pullVault(): { ok: boolean; error?: string } {
  if (!fs.existsSync(SECRETS_DIR)) return { ok: false, error: 'vault not cloned' };
  try {
    execFileSync('git', ['-C', SECRETS_DIR, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore' });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e.message) };
  }
}

export function pushVault(message: string): { ok: boolean; error?: string } {
  try {
    const status = execFileSync('git', ['-C', SECRETS_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!status) return { ok: true };
    execFileSync('git', ['-C', SECRETS_DIR, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', SECRETS_DIR,
      '-c', 'user.name=envpact-vscode',
      '-c', 'user.email=envpact@local',
      'commit', '-m', message, '-s',
    ], { stdio: 'ignore' });
    execFileSync('git', ['-C', SECRETS_DIR, 'push', '--quiet'], { stdio: 'ignore' });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e.message) };
  }
}

export function isEncrypted(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(ENC_PREFIX);
  const v = entryValue(value);
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

export function detectProjectFromGit(cwd: string): string {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return m[2].toLowerCase();
  } catch (_e) { /* fallthrough */ }
  return path.basename(cwd).toLowerCase();
}

// Re-export types for convenience.
export type { Vault, VaultEntry };
