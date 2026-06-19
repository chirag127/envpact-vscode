/**
 * envpact-vscode — Sync panel webview.
 *
 * Single-page table showing per-key sync status for the active
 * project, with per-row pull/push/force-pull/force-push actions and
 * bulk "pull all available" / "push all available" buttons that
 * operate ONLY on non-conflict statuses (local_only / vault_only).
 *
 * SECURITY:
 *   - script-src 'self' 'nonce-<n>'  (no inline, no external)
 *   - default-src 'none'
 *   - VALUES NEVER ENTER THE WEBVIEW. Only key names, statuses,
 *     timestamps, and masked first-3-last-3 previews. Even those
 *     previews are computed lazily on the host side.
 *
 * Communication is one-way per call:
 *   webview → host: WebviewMsg
 *   host → webview: { type: 'state', rows: KeyRow[] }
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Vault, maskValue } from './resolver';
import { loadVault, saveVault, pushVault, pullVault, setProjectSecret, vaultExists, detectProjectFromGit } from './vault';
import {
  loadLock,
  saveLock,
  pullKey,
  pushKey,
  resolveVaultEntry,
  statusReport,
  KeyStatus,
  KeyStatusRow,
  SyncConflictError,
  Lock,
} from './sync';
import { parseEnvFile, upsertEnvKey } from './envwriter';
import { renderPanelHtml } from './syncPanelHtml';

export { renderPanelHtml };

export type WebviewMsg =
  | { type: 'refresh' }
  | { type: 'pullKey'; key: string; projectOrShared: 'project' | 'shared'; force: boolean }
  | { type: 'pushKey'; key: string; projectOrShared: 'project' | 'shared'; force: boolean }
  | { type: 'pullAllAvailable' }
  | { type: 'pushAllAvailable' };

interface PanelRow {
  key: string;
  status: KeyStatus;
  vault_modified_at: string | null;
  lock_modified_at: string | null;
  /** Masked preview of the value the row would write — first/last 3 chars. */
  masked_preview: string;
}

interface PanelState {
  project: string;
  rows: PanelRow[];
  vaultExists: boolean;
  workspaceOpen: boolean;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function openSyncPanel(context: vscode.ExtensionContext, onChange: () => void): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'envpactSyncPanel',
    'envpact: Sync',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  currentPanel = panel;

  const nonce = crypto.randomBytes(16).toString('base64');
  panel.webview.html = renderPanelHtml(nonce, panel.webview.cspSource);

  const post = (state: PanelState) => panel.webview.postMessage({ type: 'state', state });

  const sendState = () => {
    try {
      post(computePanelState());
    } catch (e: any) {
      vscode.window.showErrorMessage(`envpact sync panel: ${e.message}`);
    }
  };

  panel.onDidDispose(
    () => {
      currentPanel = undefined;
    },
    null,
    context.subscriptions,
  );

  panel.webview.onDidReceiveMessage(
    async (msg: WebviewMsg) => {
      try {
        if (msg.type === 'refresh') {
          sendState();
          return;
        }
        if (msg.type === 'pullKey') {
          await runPullKey(msg.key, msg.force);
          onChange();
          sendState();
          return;
        }
        if (msg.type === 'pushKey') {
          await runPushKey(msg.key, msg.force);
          onChange();
          sendState();
          return;
        }
        if (msg.type === 'pullAllAvailable') {
          await runPullAll();
          onChange();
          sendState();
          return;
        }
        if (msg.type === 'pushAllAvailable') {
          await runPushAll();
          onChange();
          sendState();
          return;
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`envpact sync: ${e.message}`);
        sendState();
      }
    },
    null,
    context.subscriptions,
  );

  // Initial state push.
  sendState();
}

// ---------------------------------------------------------------
// Panel state computation
// ---------------------------------------------------------------

function computePanelState(): PanelState {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    return { project: '', rows: [], vaultExists: vaultExists(), workspaceOpen: false };
  }
  if (!vaultExists()) {
    return { project: '', rows: [], vaultExists: false, workspaceOpen: true };
  }
  const wsRoot = ws.uri.fsPath;
  const project = detectProjectFromGit(wsRoot);
  const vault = loadVault();
  const envPath = path.join(wsRoot, '.env');
  const localMap = parseEnvFile(envPath);
  let lock: Lock;
  try {
    lock = loadLock(path.join(wsRoot, '.env.example'));
  } catch {
    lock = { version: 1, keys: {} };
  }
  const rows = statusReport(vault, project, localMap, lock).map((r): PanelRow => {
    const entry = resolveVaultEntry(vault, project, r.key);
    let preview = '';
    if (r.status === 'vault_only' && entry) {
      preview = maskValue(entry.value);
    } else if (r.status === 'local_only') {
      preview = maskValue(localMap[r.key] || '');
    } else if (entry && localMap[r.key] !== undefined) {
      preview = maskValue(localMap[r.key]);
    }
    return {
      key: r.key,
      status: r.status,
      vault_modified_at: r.vault_modified_at,
      lock_modified_at: r.lock_modified_at,
      masked_preview: preview,
    };
  });
  return { project, rows, vaultExists: true, workspaceOpen: true };
}

// ---------------------------------------------------------------
// Pull / Push glue (re-used by tree-view commands)
// ---------------------------------------------------------------

export async function runPullKey(key: string, force: boolean): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('Open a workspace folder first.');
  const wsRoot = ws.uri.fsPath;
  const project = detectProjectFromGit(wsRoot);

  pullVault();
  const vault = loadVault();
  const envPath = path.join(wsRoot, '.env');
  const localMap = parseEnvFile(envPath);
  const examplePath = path.join(wsRoot, '.env.example');
  let lock: Lock;
  try { lock = loadLock(examplePath); } catch { lock = { version: 1, keys: {} }; }

  let result;
  try {
    result = pullKey({ projectName: project, key, vault, localEnvMap: localMap, lock, force });
  } catch (e: any) {
    if (e instanceof SyncConflictError) {
      throw new Error(
        `Pull refused: ${e.status} on ${key}. Use "Force pull (overwrite local)" to override.`,
      );
    }
    throw e;
  }

  upsertEnvKey(envPath, key, result.newLocalValue);
  lock.keys[key] = result.newLockEntry;
  saveLock(examplePath, lock);

  vscode.window.setStatusBarMessage(
    `envpact: pulled ${key} (was ${result.status})`,
    4000,
  );
}

export async function runPushKey(key: string, force: boolean): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('Open a workspace folder first.');
  const wsRoot = ws.uri.fsPath;
  const project = detectProjectFromGit(wsRoot);

  pullVault();
  const vault = loadVault();
  const envPath = path.join(wsRoot, '.env');
  const localMap = parseEnvFile(envPath);
  if (!(key in localMap)) {
    throw new Error(`Cannot push ${key}: not present in ${envPath}.`);
  }
  const examplePath = path.join(wsRoot, '.env.example');
  let lock: Lock;
  try { lock = loadLock(examplePath); } catch { lock = { version: 1, keys: {} }; }

  let result;
  try {
    result = pushKey({
      projectName: project,
      key,
      vault,
      localValue: localMap[key],
      lock,
      force,
    });
  } catch (e: any) {
    if (e instanceof SyncConflictError) {
      throw new Error(
        `Push refused: ${e.status} on ${key}. Use "Force push (overwrite vault)" to override.`,
      );
    }
    throw e;
  }

  setProjectSecret(vault, project, key, localMap[key], result.newVaultEntry._modified_at);
  saveVault(vault);
  pushVault(`envpact-vscode: push ${project}.${key}`);
  lock.keys[key] = result.newLockEntry;
  saveLock(examplePath, lock);

  vscode.window.setStatusBarMessage(
    `envpact: pushed ${key} (was ${result.status})`,
    4000,
  );
}

async function runPullAll(): Promise<void> {
  const state = computePanelState();
  const candidates = state.rows.filter((r) => r.status === 'vault_only');
  for (const r of candidates) {
    try {
      await runPullKey(r.key, false);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Pull all: skipped ${r.key} — ${e.message}`);
    }
  }
  vscode.window.showInformationMessage(`envpact: pulled ${candidates.length} key(s).`);
}

async function runPushAll(): Promise<void> {
  const state = computePanelState();
  const candidates = state.rows.filter((r) => r.status === 'local_only');
  for (const r of candidates) {
    try {
      await runPushKey(r.key, false);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Push all: skipped ${r.key} — ${e.message}`);
    }
  }
  vscode.window.showInformationMessage(`envpact: pushed ${candidates.length} key(s).`);
}

