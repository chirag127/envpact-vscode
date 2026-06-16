/**
 * envpact-vscode — VS Code extension for the envpact ecosystem.
 *
 * Provides a sidebar to browse the local vault, command palette
 * commands for every operation envpact-cli supports, and codelens
 * on .env.example files showing resolution status.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  SECRETS_FILE,
} from './vault';
import { resolveProject } from './resolver';
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

const execFileP = promisify(execFile);

let projectsProvider: ProjectsTreeProvider;
let sharedProvider: SharedTreeProvider;
let statusBarItem: vscode.StatusBarItem;

/**
 * Most recent encrypted-leaf failure surfaced by generateEnvCommand.
 * Module-level so refreshStatusBar/refreshAll can render error UI even
 * when triggered by sidebar refresh, workspace folder changes, etc.
 */
let lastResolveError: ResolveErrorState | null = null;

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
  statusBarItem.command = 'envpact.generateEnv';
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
    // When the active workspace folder changes the previous error no
    // longer applies — clear it so the sidebar/statusBar refresh.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearResolveError();
      refreshAll();
    })
  );
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
      // VS Code only ships one warning/error background colour pair on
      // the status bar; pick the error one when we're in this state.
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      statusBarItem.text = `$(lock) envpact: ${project || 'ready'}`;
      statusBarItem.tooltip = `envpact vault at ${SECRETS_DIR}\nClick to generate .env`;
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

async function generateEnvCommand() {
  try {
    if (!vaultExists()) {
      const ans = await vscode.window.showWarningMessage(
        'envpact vault is not initialised. Initialize now?',
        'Initialize',
        'Cancel'
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
    const project = detectProjectFromGit(cwd);

    const cfg = vscode.workspace.getConfiguration('envpact');
    const defaultEnv = cfg.get<string>('defaultEnvironment', 'default');
    const envChoice = await vscode.window.showQuickPick(
      ['default', 'development', 'staging', 'production', 'Custom…'],
      { placeHolder: `Environment (default: ${defaultEnv})`, ignoreFocusOut: true }
    );
    if (!envChoice) return;
    let environment = envChoice === 'Custom…'
      ? await vscode.window.showInputBox({ prompt: 'Custom environment name', ignoreFocusOut: true }) ?? ''
      : envChoice;
    if (environment === 'default') environment = '';

    if (cfg.get<boolean>('autoPullOnGenerate', true)) {
      const r = pullVault();
      if (!r.ok) vscode.window.showWarningMessage(`Vault pull warning: ${r.error}`);
    }

    const vault = loadVault();
    const result = resolveProject(vault, project, environment || undefined);

    // Bail BEFORE writing .env if the resolver flagged any encrypted
    // leaves: we have no age private key here, so the literal `enc:...`
    // would otherwise leak into the file. Surface the failure on the
    // status bar, sidebar, and via a toast that exposes the same
    // recovery actions syncGitHubCommand uses.
    const failure = pickEncryptionFailure(result);
    if (failure) {
      const message = formatEncryptionErrorMessage(project, result.environment, failure);
      lastResolveError = {
        project,
        environment: result.environment,
        keys: failure.keys,
        message,
      };
      refreshAll();
      const choice = await vscode.window.showErrorMessage(
        message,
        'Run envpact-cli',
        'Show in Vault'
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

    // Defensive: even if pickEncryptionFailure returned null (no encrypted
    // keys), stripEncrypted is a no-op. Keep it on the success path so
    // future resolver changes that mark partial successes don't quietly
    // leak ciphertext into a .env.
    const safe = stripEncrypted(result);
    clearResolveError();

    // ── File discovery + source/target prompts ────────────────────────
    // The vault gives us KEY=VALUE pairs. We still need to decide:
    //   (a) which .env.example to use as the spec for which keys belong
    //       in the output, and
    //   (b) which target file to write (.env, .env.production, …).
    //
    // Default to settings if the user pinned them; otherwise scan the
    // workspace and ask, pre-selecting sensible defaults.
    const exampleSetting = cfg.get<string>('exampleFile', '').trim();
    const outputSetting = cfg.get<string>('outputFile', '').trim();

    const scan = discoverEnvFiles(cwd);
    let exampleName = exampleSetting;
    if (!exampleName) {
      const choices = scan.examples.length
        ? [...scan.examples, 'Custom…', 'Skip (use vault keys directly)']
        : ['Custom…', 'Skip (use vault keys directly)'];
      const pick = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Pick the .env.example file to use as the spec',
        ignoreFocusOut: true,
      });
      if (!pick) return;
      if (pick === 'Custom…') {
        exampleName = (await vscode.window.showInputBox({
          prompt: 'Path (relative to workspace) of the example file',
          value: '.env.example',
          ignoreFocusOut: true,
        }))?.trim() ?? '';
        if (!exampleName) return;
      } else if (pick === 'Skip (use vault keys directly)') {
        exampleName = '';
      } else {
        exampleName = pick;
      }
    }

    let outputName = outputSetting;
    if (!outputName) {
      const suggested = exampleName ? suggestTargetFor(exampleName) : '.env';
      const targetChoices = Array.from(new Set([
        suggested,
        ...scan.targets,
        '.env',
        '.env.local',
      ])).filter(Boolean);
      targetChoices.push('Custom…');
      const pick = await vscode.window.showQuickPick(targetChoices, {
        placeHolder: `Pick the target file (default: ${suggested})`,
        ignoreFocusOut: true,
      });
      if (!pick) return;
      if (pick === 'Custom…') {
        outputName = (await vscode.window.showInputBox({
          prompt: 'Path (relative to workspace) of the target file',
          value: suggested,
          ignoreFocusOut: true,
        }))?.trim() ?? '';
        if (!outputName) return;
      } else {
        outputName = pick;
      }
    }

    const examplePath = exampleName ? path.join(cwd, exampleName) : '';
    const required = examplePath ? parseEnvExample(examplePath) : [];
    const ordered = required.length ? required : Object.keys(safe.resolved);
    const out = path.join(cwd, outputName);

    // ── Write mode (Merge / Overwrite / Dry-run) ──────────────────────
    // Merge is the safe default: keys the user has in their .env that
    // the vault doesn't know about are preserved. Overwrite reproduces
    // the prior behaviour but only after the user sees what they'll
    // lose. Dry-run shows the diff without touching disk.
    const writeModeSetting = cfg.get<string>(
      'writeMode',
      'ask',
    ) as 'ask' | 'merge' | 'overwrite' | 'dry-run';
    let writeMode: 'merge' | 'overwrite' | 'dry-run';
    if (writeModeSetting === 'ask') {
      const pickMode = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Vault values overlay your .env; user-only keys preserved (recommended)' },
          { label: 'Overwrite', description: 'Replace target file with vault contents — user-only keys are lost' },
          { label: 'Dry run', description: 'Show what would change; do not write' },
        ],
        { placeHolder: `Write mode for ${outputName}`, ignoreFocusOut: true }
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
        `envpact (dry run) ${outputName}: +${plan.added.length} added, ${plan.overwritten.length} overwritten, ${plan.kept.length} preserved, ${plan.unchanged.length} unchanged.`
      );
      refreshAll();
      return;
    }

    let content: string;
    if (writeMode === 'merge' && existingText) {
      content = mergeEnvFile(existingText, safe.resolved, ordered);
    } else {
      content = renderEnv(ordered, safe.resolved, { project, environment: safe.environment });
    }

    writeEnvAtomic(out, content);
    ensureGitignoreCovers(cwd, outputName);

    const summary = writeMode === 'merge' && existingText
      ? `merged into ${outputName}: +${plan.added.length}, ~${plan.overwritten.length}, kept ${plan.kept.length} user key(s)`
      : `wrote ${Object.keys(safe.resolved).length} keys to ${outputName} (env=${safe.environment})`;
    vscode.window.showInformationMessage(
      `envpact: ${summary}` +
      (safe.unresolved.length ? `. Unresolved: ${safe.unresolved.join(', ')}` : '')
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
    { placeHolder: 'Initialise envpact vault', ignoreFocusOut: true }
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
  // Whatever was wrong before, an init flow makes the previous failure
  // stale — wipe it so the UI doesn't lie about the new vault.
  clearResolveError();
  vscode.window.showInformationMessage('envpact: initialisation started in terminal. Run "envpact: Refresh Vault" when done.');
}

async function refreshVaultCommand() {
  // A fresh pull may bring in new plaintext or rotate the encrypted
  // values, so the previous error is no longer authoritative.
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
    prompt: `Value (or "shared.KEY" reference)`, password: true, ignoreFocusOut: true,
  });
  if (value == null) return;
  const env = await vscode.window.showInputBox({
    prompt: 'Environment (leave empty for flat)', ignoreFocusOut: true,
  }) ?? '';

  const vault = loadVault();
  setProjectSecret(vault, targetProject, key, value, env || undefined);
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
      `${pick}: ${Object.keys(vault.projects![pick]).filter(k => !k.startsWith('_')).length} keys`
    );
  }
}
