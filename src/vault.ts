import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Vault, validateVault, ENC_PREFIX } from './resolver';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
export const CONFIG_DIR = path.join(HOME, '.envpact');
export const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v2.json';

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
  if (parsed.version === 1) {
    parsed.version = 2;
    parsed.$schema = SCHEMA_URL;
  }
  validateVault(parsed);
  return parsed;
}

export function saveVault(vault: Vault): void {
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || 2;
  const tmp = `${SECRETS_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SECRETS_FILE);
}

export function setProjectSecret(
  vault: Vault,
  project: string,
  key: string,
  value: string,
  environment?: string
): void {
  vault.projects = vault.projects || {};
  vault.projects[project] = vault.projects[project] || {};
  const p = vault.projects[project];
  if (environment) {
    const existing = p[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      p[key] = {} as Record<string, string>;
    }
    (p[key] as Record<string, string>)[environment] = value;
  } else {
    p[key] = value;
  }
}

export function setSharedSecret(vault: Vault, key: string, value: string): void {
  vault.shared = vault.shared || {};
  vault.shared[key] = value;
}

export function findReferencingProjects(vault: Vault, sharedKey: string) {
  const refs: { project: string; key: string; environment?: string }[] = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, v] of Object.entries(proj)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' && v === ref) refs.push({ project: pname, key: k });
      else if (v && typeof v === 'object') {
        for (const [env, ev] of Object.entries(v)) {
          if (typeof ev === 'string' && ev === ref) refs.push({ project: pname, key: k, environment: env });
        }
      }
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
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function detectProjectFromGit(cwd: string): string {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return m[2].toLowerCase();
  } catch (_e) { /* fallthrough */ }
  return path.basename(cwd).toLowerCase();
}
