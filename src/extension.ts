/**
 * envpact-vscode — VS Code extension for the envpact ecosystem.
 *
 * v0.5.0: schema v3 (flat, single-environment, per-key timestamps).
 * Per-key sync UI lives in two places: the tree-view context menus,
 * and a dedicated webview Sync panel (envpact.openSyncPanel).
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  loadVault,
  saveVault,
  vaultExists,
  setProjectSecret,
  setSharedSecret,
  findReferencingProjects,
  pullVault,
  pushVault,
  detectProjectFromGit,
  SECRETS_DIR,
} from './vault';
import { resolveProject, maskValue } from './resolver';
import {
  parseEnvExample,
  parseEnvFile,
  renderEnv,
  mergeEnvFile,
  planMerge,
  writeEnvAtomic,
  ensureGitignoreCovers,
  discoverEnvFiles,
  suggestTargetFor,
} from './envwriter';
import { ProjectsTreeProvider, SharedTreeProvider, ResolveErrorState } from './sidebar';
import {
  pickEncryptionFailure,
  stripEncrypted,
  formatEncryptionErrorMessage,
} from './encryption-guard';
import { ensureWorkspaceSetup, WorkspaceSetup } from './setup';
import { registerEnvSaveWatcher } from './watcher';
import { openSyncPanel, runPullKey, runPushKey } from './syncPanel';
import { resolveVaultEntry } from './sync';

let projectsProvider: ProjectsTreeProvider;
let sharedProvider: SharedTreeProvider;
let statusBarItem: vscode.StatusBarItem;

let lastResolveError: ResolveErrorState | null = null;
let cachedSetup: WorkspaceSetup | null = null;

function clearResolveError(): void {
  if (lastResolveError === null) return;
  lastResolveError = null;
  if (projectsProvider) projectsProvider.setResolveError(null);
}

export function activate(context: vscode.ExtensionContext) {
  projectsProvider = new ProjectsTreeProvider();
  sharedProvider = new SharedTreeProvider();
  vscode.window.registerTreeDataProvider('envpact.projects', projectsProvider);
  vscode.window.registerTreeDataProvider('envpact.shared', sharedProvider);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'envpact.openSyncPanel';
  context.subscriptions.push(statusBarItem);
  refreshStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('envpact.generateEnv', generateEnvCommand),
    vscode.commands.registerCommand('envpact.initVault', initVaultCommand),
    vscode.commands.registerCommand('envpact.refreshVault', refreshVaultCommand),
    vscode.commands.registerCommand('envpact.addSecret', addSecretCommand),
    vscode.commands.registerCommand('envpact.addSharedSecret', addSharedSecretCommand),
    vscode.commands.registerCommand('envpact.rotateSecret', rotateSecretCommand),
    vscode.commands.registerCommand('envpact.syncGitHub', syncGitHubCommand),
    vscode.commands.registerCommand('envpact.listProjects', listProjectsCommand),
    vscode.commands.registerCommand('envpact.openSyncPanel', () =>
      openSyncPanel(context, refreshAll),
    ),
    // Per-key sync commands. The treeItem comes from the right-click
    // menu and exposes its contextValue at item.contextValue.
    vscode.commands.registerCommand('envpact.pullKey', (item: vscode.TreeItem) =>
      pullKeyFromTree(item, false),
    ),
    vscode.commands.registerCommand('envpact.pushKey', (item: vscode.TreeItem) =>
      pushKeyFromTree(item, false),
    ),
    vscode.commands.registerCommand('envpact.pullKeyForce', (item: vscode.TreeItem) =>
      pullKeyFromTree(item, true),
    ),
    vscode.commands.registerCommand('envpact.pushKeyForce', (item: vscode.TreeItem) =>
      pushKeyFromTree(item, true),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearResolveError();
      cachedSetup = null;
      refreshAll();
    }),
  );

  const ws0 = vscode.workspace.workspaceFolders?.[0];
  if (ws0) {
    ensureWorkspaceSetup(ws0.uri.fsPath)
      .then((s) => { cachedSetup = s; refreshAll(); })
      .catch(() => { /* user cancelled — generateEnv will retry */ });
  }
  registerEnvSaveWatcher(context, refreshAll);
}

export function deactivate() { /* no-op */ }

function refreshStatusBar() {
  if (vaultExists()) {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const project = wsRoot ? detectProjectFromGit(wsRoot) : '';
    if (lastResolveError) {
      statusBarItem.text =
        `$(error) envpact: ${lastResolveError.keys.length} enc: secret(s) — cannot decrypt`;
      statusBarItem.tooltip = lastResolveError.message;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      statusBarItem.text = `$(lock) envpact: ${project || 'ready'}`;
      statusBarItem.tooltip = `envpact vault at ${SECRETS_DIR}\nClick to open the Sync panel`;
      statusBarItem.backgroundColor = undefined;
    }
  } else {
    statusBarItem.text = '$(unlock) envpact: not initialized';
    statusBarItem.tooltip = 'Run envpact: Initialize Vault';
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

function refreshAll() {
  if (projectsProvider) projectsProvider.setResolveError(lastResolveError);
  projectsProvider.refresh();
  sharedProvider.refresh();
  refreshStatusBar();
}

// ---------------------------------------------------------------
// Per-key sync helpers (tree view → command)
// ---------------------------------------------------------------

/**
 * Parse the tree item's contextValue, which encodes the scope, project,
 * and key as `envpactKey:<scope>:<project>:<KEY>`. Returns null when
 * the contextValue isn't one of ours (the menu shouldn't fire then,
 * but be defensive).
 */
function parseKeyContext(item: vscode.TreeItem | undefined):
  { scope: 'project' | 'shared'; project: string; key: string } | null {
  if (!item || typeof item.contextValue !== 'string') return null;
  const parts = item.contextValue.split(':');
  if (parts.length < 4 || parts[0] !== 'envpactKey') return null;
  const scope = parts[1];
  if (scope !== 'project' && scope !== 'shared') return null;
  return { scope, project: parts[2] || '', key: parts.slice(3).join(':') };
}

async function confirmAndDispatch(
  item: vscode.TreeItem | undefined,
  direction: 'pull' | 'push',
  force: boolean,
): Promise<void> {
  const ctx = parseKeyContext(item);
  if (!ctx) {
    vscode.window.showErrorMessage('envpact: right-click a key in the Projects view to use this action.');
    return;
  }
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const wsRoot = ws.uri.fsPath;

  // Build a masked-only confirmation prompt. The first/last 3 chars
  // are the most a user-facing prompt is allowed to reveal — and even
  // that only when length ≥ 8. Shorter values collapse to ••••.
  let preview = '';
  try {
    if (direction === 'pull') {
      const vault = loadVault();
      const entry = resolveVaultEntry(vault, ctx.project, ctx.key);
      preview = entry ? maskValue(entry.value) : '(not in vault)';
    } else {
      const localMap = parseEnvFile(path.join(wsRoot, '.env'));
      preview = ctx.key in localMap ? maskValue(localMap[ctx.key]) : '(not in .env)';
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`envpact: ${e.message}`);
    return;
  }

  const verb = direction === 'pull' ? 'Pull' : 'Push';
  const target = direction === 'pull' ? 'local .env' : 'vault';
  const forceLabel = force ? ' (force — overrides conflict refusal)' : '';
  const proceed = await vscode.window.showWarningMessage(
    `${verb} ${ctx.key} → ${target}${forceLabel}\n\nValue preview (masked): ${preview}\n\nContinue?`,
    { modal: true },
    verb,
    'Cancel',
  );
  if (proceed !== verb) return;

  try {
    if (direction === 'pull') {
      await runPullKey(ctx.key, force);
    } else {
      await runPushKey(ctx.key, force);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`envpact: ${e.message}`);
    return;
  }
  refreshAll();
}

async function pullKeyFromTree(item: vscode.TreeItem | undefined, force: boolean) {
  return confirmAndDispatch(item, 'pull', force);
}

async function pushKeyFromTree(item: vscode.TreeItem | undefined, force: boolean) {
  return confirmAndDispatch(item, 'push', force);
}

// ---------------------------------------------------------------
// Existing commands (env-stripped)
// ---------------------------------------------------------------

async function generateEnvCommand() {
  try {
    if (!vaultExists()) {
      const ans = await vscode.window.showWarningMessage(
        'envpact vault is not initialised. Initialize now?',
        'Initialize',
        'Cancel',
      );
      if (ans !== 'Initialize') return;
      return initVaultCommand();
    }

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }
    const cwd = ws.uri.fsPath;
    if (!cachedSetup) {
      try {
        cachedSetup = await ensureWorkspaceSetup(cwd);
      } catch {
        return;
      }
    }
    const project = cachedSetup.projectName || detectProjectFromGit(cwd);

    const cfg = vscode.workspace.getConfiguration('envpact');
    if (cfg.get<boolean>('autoPullOnGenerate', true)) {
      const r = pullVault();
      if (!r.ok) vscode.window.showWarningMessage(`Vault pull warning: ${r.error}`);
    }

    const vault = loadVault();
    const result = resolveProject(vault, project);

    const failure = pickEncryptionFailure(result);
    if (failure) {
      const message = formatEncryptionErrorMessage(project, failure);
      lastResolveError = {
        project,
        keys: failure.keys,
        message,
      };
      refreshAll();
      const choice = await vscode.window.showErrorMessage(
        message,
        'Run envpact-cli',
        'Show in Vault',
      );
      if (choice === 'Run envpact-cli') {
        const term = vscode.window.createTerminal({ name: 'envpact generate' });
        term.show();
        term.sendText('npx envpact-cli');
      } else if (choice === 'Show in Vault') {
        await vscode.commands.executeCommand('envpact.projects.focus');
      }
      return;
    }

    const safe = stripEncrypted(result);
    clearResolveError();

    const exampleSetting = cfg.get<string>('exampleFile', '').trim();
    const outputSetting = cfg.get<string>('outputFile', '').trim();

    const scan = discoverEnvFiles(cwd);
    let exampleName = exampleSetting;
    if (!exampleName && scan.examples.length) {
      exampleName = scan.examples[0];
    }

    let outputName = outputSetting;
    if (!outputName) {
      outputName = exampleName ? suggestTargetFor(exampleName) : '.env';
    }

    const examplePath = exampleName ? path.join(cwd, exampleName) : '';
    const required = examplePath ? parseEnvExample(examplePath) : [];
    const ordered = required.length ? required : Object.keys(safe.resolved);
    const out = path.join(cwd, outputName);

    const writeModeSetting = cfg.get<string>(
      'writeMode',
      'merge',
    ) as 'ask' | 'merge' | 'overwrite' | 'dry-run';
    let writeMode: 'merge' | 'overwrite' | 'dry-run';
    if (writeModeSetting === 'ask') {
      const pickMode = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Vault values overlay your .env; user-only keys preserved (recommended)' },
          { label: 'Overwrite', description: 'Replace target file with vault contents — user-only keys are lost' },
          { label: 'Dry run', description: 'Show what would change; do not write' },
        ],
        { placeHolder: `Write mode for ${outputName}`, ignoreFocusOut: true },
      );
      if (!pickMode) return;
      writeMode = pickMode.label === 'Merge'
        ? 'merge'
        : pickMode.label === 'Overwrite'
          ? 'overwrite'
          : 'dry-run';
    } else {
      writeMode = writeModeSetting;
    }

    const existingText = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    const existingMap = existingText ? parseEnvFile(out) : {};
    const plan = planMerge(existingMap, safe.resolved);

    if (writeMode === 'overwrite' && plan.kept.length > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `Overwriting ${outputName} will discard ${plan.kept.length} key(s) not present in the vault: ${plan.kept.slice(0, 8).join(', ')}${plan.kept.length > 8 ? `, +${plan.kept.length - 8} more` : ''}. Continue?`,
        { modal: true },
        'Overwrite anyway',
        'Switch to Merge',
      );
      if (proceed === 'Switch to Merge') writeMode = 'merge';
      else if (proceed !== 'Overwrite anyway') return;
    }

    if (writeMode === 'dry-run') {
      vscode.window.showInformationMessage(
        `envpact (dry run) ${outputName}: +${plan.added.length} added, ${plan.overwritten.length} overwritten, ${plan.kept.length} preserved, ${plan.unchanged.length} unchanged.`,
      );
      refreshAll();
      return;
    }

    let content: string;
    if (writeMode === 'merge' && existingText) {
      content = mergeEnvFile(existingText, safe.resolved, ordered);
    } else {
      content = renderEnv(ordered, safe.resolved, { project });
    }

    writeEnvAtomic(out, content);
    ensureGitignoreCovers(cwd, outputName);

    const summary = writeMode === 'merge' && existingText
      ? `merged into ${outputName}: +${plan.added.length}, ~${plan.overwritten.length}, kept ${plan.kept.length} user key(s)`
      : `wrote ${Object.keys(safe.resolved).length} keys to ${outputName}`;
    vscode.window.showInformationMessage(
      `envpact: ${summary}` +
      (safe.unresolved.length ? `. Unresolved: ${safe.unresolved.join(', ')}` : ''),
    );
    refreshAll();
  } catch (e: any) {
    vscode.window.showErrorMessage(`envpact: ${e.message}`);
  }
}

async function initVaultCommand() {
  if (vaultExists()) {
    vscode.window.showInformationMessage(`envpact vault already initialised at ${SECRETS_DIR}`);
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Auto (recommended)', detail: 'Run `envpact-cli --init auto` — creates a private repo via gh CLI.' },
      { label: 'Existing vault URL', detail: 'I already have a vault repo somewhere.' },
    ],
    { placeHolder: 'Initialise envpact vault', ignoreFocusOut: true },
  );
  if (!choice) return;

  const term = vscode.window.createTerminal({ name: 'envpact init' });
  term.show();
  if (choice.label.startsWith('Auto')) {
    term.sendText('npx envpact-cli --init auto');
  } else {
    const url = await vscode.window.showInputBox({
      prompt: 'Vault git URL (e.g. git@github.com:you/envpact-secrets.git)',
      ignoreFocusOut: true,
    });
    if (!url) return;
    term.sendText(`npx envpact-cli --init ${url}`);
  }
  clearResolveError();
  vscode.window.showInformationMessage(
    'envpact: initialisation started in terminal. Run "envpact: Refresh Vault" when done.',
  );
}

async function refreshVaultCommand() {
  clearResolveError();
  const r = pullVault();
  if (r.ok) vscode.window.showInformationMessage('envpact: vault pulled');
  else vscode.window.showWarningMessage(`envpact: ${r.error}`);
  refreshAll();
}

async function addSecretCommand() {
  if (!vaultExists()) return generateEnvCommand();
  const ws = vscode.workspace.workspaceFolders?.[0];
  const project = ws ? detectProjectFromGit(ws.uri.fsPath) : '';
  const targetProject = await vscode.window.showInputBox({
    prompt: 'Project name', value: project, ignoreFocusOut: true,
  });
  if (!targetProject) return;
  const key = await vscode.window.showInputBox({ prompt: 'Key (e.g. OPENAI_API_KEY)', ignoreFocusOut: true });
  if (!key) return;
  const value = await vscode.window.showInputBox({
    prompt: 'Value (or "shared.KEY" reference)', password: true, ignoreFocusOut: true,
  });
  if (value == null) return;

  const vault = loadVault();
  setProjectSecret(vault, targetProject, key, value);
  saveVault(vault);
  pushVault(`envpact-vscode: set ${targetProject}.${key}`);
  vscode.window.showInformationMessage(`envpact: set ${targetProject}.${key}`);
  refreshAll();
}

async function addSharedSecretCommand() {
  if (!vaultExists()) return generateEnvCommand();
  const key = await vscode.window.showInputBox({ prompt: 'Shared key name', ignoreFocusOut: true });
  if (!key) return;
  const value = await vscode.window.showInputBox({ prompt: `Value for shared.${key}`, password: true, ignoreFocusOut: true });
  if (value == null) return;
  const vault = loadVault();
  setSharedSecret(vault, key, value);
  saveVault(vault);
  pushVault(`envpact-vscode: set shared.${key}`);
  vscode.window.showInformationMessage(`envpact: set shared.${key}`);
  refreshAll();
}

async function rotateSecretCommand() {
  if (!vaultExists()) return generateEnvCommand();
  const vault = loadVault();
  const sharedKeys = Object.keys(vault.shared || {});
  if (!sharedKeys.length) {
    vscode.window.showInformationMessage('No shared secrets to rotate.');
    return;
  }
  const key = await vscode.window.showQuickPick(sharedKeys, {
    placeHolder: 'Select shared secret to rotate',
    ignoreFocusOut: true,
  });
  if (!key) return;
  const refs = findReferencingProjects(vault, key);
  const newValue = await vscode.window.showInputBox({
    prompt: `New value for shared.${key} (used by ${refs.length} reference(s))`,
    password: true,
    ignoreFocusOut: true,
  });
  if (newValue == null) return;
  setSharedSecret(vault, key, newValue);
  saveVault(vault);
  pushVault(`envpact-vscode: rotate shared.${key}`);
  vscode.window.showInformationMessage(`envpact: rotated shared.${key} (${refs.length} ref(s))`);
  refreshAll();
}

async function syncGitHubCommand() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const term = vscode.window.createTerminal({ name: 'envpact sync' });
  term.show();
  term.sendText('npx envpact-cli --github');
}

async function listProjectsCommand() {
  if (!vaultExists()) {
    vscode.window.showInformationMessage('envpact vault is not initialised.');
    return;
  }
  const vault = loadVault();
  const projects = Object.keys(vault.projects || {}).sort();
  if (!projects.length) {
    vscode.window.showInformationMessage('No projects in vault yet.');
    return;
  }
  const pick = await vscode.window.showQuickPick(projects, { placeHolder: 'Projects in vault' });
  if (pick) {
    vscode.window.showInformationMessage(
      `${pick}: ${Object.keys(vault.projects![pick]).filter(k => !k.startsWith('_')).length} keys`,
    );
  }
}
