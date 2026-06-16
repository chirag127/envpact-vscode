// Watch for .env saves and auto-push to the vault.
//
// The watcher fires onDidSaveTextDocument; we filter to files whose
// basename matches the canonical pattern (.env exactly, not .env.example,
// not .env.production — those are derived per the user's policy).
//
// Each save is debounced for 500ms because some IDEs trigger multiple
// save events for a single Ctrl-S (formatter, lint, format-on-save).

import * as vscode from 'vscode';
import * as path from 'node:path';
import { loadVault, saveVault, vaultExists, pushVault } from './vault';
import { pushLocalEnvToVault, summarisePlan } from './sync';

/**
 * Only the canonical .env counts as a push source. Everything else
 * (.env.example, .env.production, .env.local) is derived from the
 * vault on-demand and never pushes back.
 */
function isPushSource(uri: vscode.Uri): boolean {
  const name = path.basename(uri.fsPath);
  return name === '.env';
}

let debounceTimer: NodeJS.Timeout | null = null;
let pendingUri: vscode.Uri | null = null;

export function registerEnvSaveWatcher(
  context: vscode.ExtensionContext,
  getProjectName: () => string,
): void {
  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    // Honour the autoSyncOnSave setting so users can opt out per-workspace.
    const enabled = vscode.workspace
      .getConfiguration('envpact')
      .get<boolean>('autoSyncOnSave', true);
    if (!enabled) return;
    if (!isPushSource(doc.uri)) return;
    pendingUri = doc.uri;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSync(getProjectName()), 500);
  });
  context.subscriptions.push(sub);
}

async function runSync(project: string): Promise<void> {
  const uri = pendingUri;
  pendingUri = null;
  if (!uri || !project) return;
  if (!vaultExists()) {
    // No vault yet — silently ignore. User has to run Initialize first.
    return;
  }
  try {
    const vault = loadVault();
    const plan = pushLocalEnvToVault(vault, project, uri.fsPath);
    const hasChanges =
      plan.overwritten.length > 0 ||
      plan.promotedToShared.length > 0 ||
      plan.addedToProject.length > 0;
    if (!hasChanges) {
      // Nothing to do — don't even toast, this is the common case.
      return;
    }
    saveVault(vault);
    // Best-effort push of the vault repo. If the user is offline or
    // gh isn't authed, the local vault is still up-to-date and the
    // next push will catch up.
    const summary = summarisePlan(plan);
    const pushResult = pushVault(`envpact: sync ${project} (${summary})`);
    const suffix = pushResult.ok ? '' : ' (local only — push later)';
    vscode.window.setStatusBarMessage(
      `envpact: synced ${project} → ${summary}${suffix}`,
      4000,
    );
  } catch (e: any) {
    // Soft-fail: never break a save. Surface in the status bar only.
    vscode.window.setStatusBarMessage(`envpact sync error: ${e.message}`, 6000);
  }
}
