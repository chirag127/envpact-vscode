// Silent first-run discovery for v0.4.0.
//
// On extension activation we need three things:
//   1. The user's GitHub username (so project names are scoped per-user)
//   2. The git remote name of the current repo (so the project name is
//      stable across machines and matches the GitHub repo URL)
//   3. A vault directory (already handled by vault.ts)
//
// The whole flow MUST run with zero prompts when:
//   - `gh` CLI is installed and authenticated
//   - the workspace is a git repo with a github.com remote
//
// Anything else is a soft fallback — we never block activation.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface WorkspaceSetup {
  /** GitHub username, e.g. "chirag127" */
  username: string;
  /** Repo name from the git remote, e.g. "envpact" */
  repo: string;
  /** Combined slug used as the vault project key, e.g. "chirag127/envpact" */
  projectName: string;
  /** Where the cached config lives */
  configPath: string;
  /** True if any value had to be inferred / fallback'd */
  inferred: boolean;
}

const CONFIG_FILE = '.vscode/envpact.json';

/**
 * Run `gh` CLI and return stdout, or null if it fails.
 *
 * We deliberately use execFileSync (not exec) so user-provided cwd
 * never gets shell-interpolated. Stderr is swallowed; gh's own error
 * messages are noisy and the caller has its own fallback.
 */
function runGh(args: string[]): string | null {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the GitHub username from the gh CLI. Cheapest correct source —
 * gh keeps its own auth state and re-uses the token the user already
 * authorised, so we never have to drive a device flow ourselves.
 */
export function detectUsername(): string | null {
  const u = runGh(['api', 'user', '--jq', '.login']);
  if (u && /^[A-Za-z0-9-]+$/.test(u)) return u;
  return null;
}

/**
 * Read `gh auth token` so the rest of the extension can call the
 * GitHub API without prompting. Returned token MUST be stored in
 * SecretStorage by the caller, never in plain config.
 */
export function detectAuthToken(): string | null {
  const t = runGh(['auth', 'token']);
  if (t && t.startsWith('gh') && t.length > 20) return t;
  return null;
}

/**
 * Parse `git remote get-url origin` and pull the GitHub repo name.
 * Accepts both SSH (git@github.com:user/repo.git) and HTTPS
 * (https://github.com/user/repo[.git]) URLs.
 *
 * Returns null if the remote isn't a github.com URL — we don't
 * support self-hosted GH yet because the vault-write path also
 * assumes github.com.
 */
export function detectRepoFromGit(cwd: string): { user: string; repo: string } | null {
  let url: string;
  try {
    url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
  // SSH form: git@github.com:user/repo.git
  let m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (m) return { user: m[1], repo: m[2] };
  // HTTPS form: https://github.com/user/repo[.git]
  m = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m) return { user: m[1], repo: m[2] };
  return null;
}

/**
 * Load cached setup from .vscode/envpact.json, or compute it fresh
 * via gh CLI + git remote. Writes the cache on first compute.
 *
 * The cache exists so subsequent activations are instant and the
 * user never sees a QuickPick they've already answered. Delete the
 * file to force re-discovery.
 */
export async function ensureWorkspaceSetup(workspaceRoot: string): Promise<WorkspaceSetup> {
  const configPath = path.join(workspaceRoot, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cached.username && cached.repo && cached.projectName) {
        return { ...cached, configPath, inferred: false };
      }
    } catch {
      // Corrupt cache — fall through and rebuild.
    }
  }

  let inferred = false;
  let username = detectUsername();
  let repoInfo = detectRepoFromGit(workspaceRoot);
  let repo = repoInfo?.repo ?? '';

  // If gh is missing or unauthenticated, fall back to the user-half
  // of the git remote URL (which is just as authoritative for naming
  // purposes — github usernames are case-insensitive and unique).
  if (!username && repoInfo?.user) {
    username = repoInfo.user;
    inferred = true;
  }

  // Last-resort fallbacks: ask the user once. This only fires if
  // gh CLI isn't available AND the workspace isn't a git repo with
  // a github remote, which is the rare case we couldn't avoid.
  if (!username) {
    const ans = await vscode.window.showInputBox({
      prompt: 'envpact could not detect your GitHub username. Enter it once (saved to .vscode/envpact.json).',
      placeHolder: 'e.g. chirag127',
      ignoreFocusOut: true,
      validateInput: (v) => /^[A-Za-z0-9-]+$/.test(v.trim()) ? null : 'GitHub usernames are alphanumeric + dashes',
    });
    if (!ans) throw new Error('envpact setup cancelled — username required');
    username = ans.trim();
    inferred = true;
  }
  if (!repo) {
    const folderName = path.basename(workspaceRoot);
    repo = folderName;
    inferred = true;
  }

  const projectName = `${username}/${repo}`;
  const setup: WorkspaceSetup = { username, repo, projectName, configPath, inferred };

  // Persist so subsequent activations are zero-prompt.
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const toSave = { username, repo, projectName, savedAt: new Date().toISOString() };
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal: extension still works, we just re-detect next time.
  }

  return setup;
}
