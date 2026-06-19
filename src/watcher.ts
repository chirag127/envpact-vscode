// Watch for .env saves and refresh the sync status display.
//
// Under v3 per-key sync, we no longer auto-push the entire .env on
// save (that flattens user intent — they may edit one key but not
// want to push another that's diverged). Instead, on .env save we
// trigger a tree-view + status-bar refresh so the user sees the
// updated per-key status indicators (the ↑ / ↓ / ⚠ / 🆕 badges) and
// can decide which keys to push from the context menu or Sync panel.

import * as vscode from 'vscode';
import * as path from 'node:path';

function isEnvFile(uri: vscode.Uri): boolean {
  const name = path.basename(uri.fsPath);
  return name === '.env';
}

let debounceTimer: NodeJS.Timeout | null = null;

export function registerEnvSaveWatcher(
  context: vscode.ExtensionContext,
  refresh: () => void,
): void {
  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    const enabled = vscode.workspace
      .getConfiguration('envpact')
      .get<boolean>('autoSyncOnSave', true);
    if (!enabled) return;
    if (!isEnvFile(doc.uri)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });
  context.subscriptions.push(sub);
}
