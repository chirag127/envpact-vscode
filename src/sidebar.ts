import * as vscode from 'vscode';
import * as path from 'node:path';
import { vaultExists, loadVault, isEncrypted, detectProjectFromGit } from './vault';
import { entryValue, ENC_PREFIX } from './resolver';
import {
  loadLock,
  getKeyStatus,
  resolveVaultEntry,
  lockPathForWorkspace,
  KeyStatus,
} from './sync';
import { parseEnvFile } from './envwriter';
import * as fs from 'node:fs';

/**
 * Shape pushed into the sidebar by extension.ts when generateEnv hits
 * encrypted leaves. The provider uses this to surface a synthetic node
 * under the affected project and to colour the project icon.
 */
export interface ResolveErrorState {
  project: string;
  keys: string[];
  message: string;
}

class TreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: TreeItem[],
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Map a sync status to a single-character indicator + theme icon for
 * the tree-view leaf decoration. Mirrors the design table in the
 * Stage 2 brief.
 */
export function statusIndicator(status: KeyStatus | undefined): {
  prefix: string;
  icon: vscode.ThemeIcon;
  tooltip: string;
} {
  switch (status) {
    case 'synced':
      return {
        prefix: '✓',
        icon: new vscode.ThemeIcon('check'),
        tooltip: 'In sync with the vault',
      };
    case 'local_newer':
      return {
        prefix: '↑',
        icon: new vscode.ThemeIcon('arrow-up'),
        tooltip: 'Local .env was edited since last sync — push to vault.',
      };
    case 'vault_newer':
      return {
        prefix: '↓',
        icon: new vscode.ThemeIcon('arrow-down'),
        tooltip: 'Vault advanced since last sync — pull to local.',
      };
    case 'both_diverged':
      return {
        prefix: '⚠',
        icon: new vscode.ThemeIcon('warning'),
        tooltip: 'Local and vault both moved — force pull or force push.',
      };
    case 'local_only':
      return {
        prefix: '🆕',
        icon: new vscode.ThemeIcon('diff-added'),
        tooltip: 'Present locally, absent from vault — push to add.',
      };
    case 'vault_only':
      return {
        prefix: '🆕',
        icon: new vscode.ThemeIcon('diff-added'),
        tooltip: 'Present in vault, absent locally — pull to add.',
      };
    default:
      return {
        prefix: '•',
        icon: new vscode.ThemeIcon('circle-outline'),
        tooltip: '',
      };
  }
}

/**
 * Compute per-key statuses for the active workspace's project. Reads
 * .env, the lock, and the vault. Returns an empty map if the
 * workspace isn't a project the vault knows about (or if there's no
 * workspace open at all).
 */
function computeProjectStatuses(
  vault: ReturnType<typeof loadVault>,
  projectName: string,
): Map<string, KeyStatus> {
  const out = new Map<string, KeyStatus>();
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return out;
  const wsRoot = ws.uri.fsPath;
  const envPath = path.join(wsRoot, '.env');
  const localMap = parseEnvFile(envPath);
  let lock;
  try {
    lock = loadLock(path.join(wsRoot, '.env.example'));
  } catch {
    lock = { version: 1, keys: {} };
  }
  const project = (vault.projects || {})[projectName];
  if (!project) return out;
  for (const key of Object.keys(project)) {
    if (key.startsWith('_')) continue;
    const entry = resolveVaultEntry(vault, projectName, key);
    const localValue = localMap[key];
    const status = getKeyStatus(localValue, entry, lock.keys[key]);
    out.set(key, status);
  }
  return out;
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private resolveError: ResolveErrorState | null = null;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setResolveError(err: ResolveErrorState | null): void {
    this.resolveError = err;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): vscode.ProviderResult<TreeItem[]> {
    if (element) return element.children || [];
    if (!vaultExists()) {
      const item = new TreeItem('(vault not initialized)', vscode.TreeItemCollapsibleState.None);
      item.command = { command: 'envpact.initVault', title: 'Initialize' };
      return [item];
    }
    try {
      const vault = loadVault();
      const errState = this.resolveError;
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const activeProject = wsRoot ? detectProjectFromGit(wsRoot) : '';

      return Object.keys(vault.projects || {})
        .sort()
        .map((name) => {
          const project = vault.projects![name];
          const projectKeys = Object.keys(project).filter((k) => !k.startsWith('_'));
          const keyCount = projectKeys.length;
          const errorMatchesProject = errState && errState.project === name;
          const statuses = name === activeProject
            ? computeProjectStatuses(vault, name)
            : new Map<string, KeyStatus>();

          const leafChildren: TreeItem[] = projectKeys.map((k) => {
            const raw = project[k];
            const v = entryValue(raw);
            if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
              const child = new TreeItem(
                `${k} = (encrypted — not decryptable in VS Code)`,
                vscode.TreeItemCollapsibleState.None,
              );
              child.iconPath = new vscode.ThemeIcon(
                'shield',
                new vscode.ThemeColor('errorForeground'),
              );
              child.tooltip =
                `${k} is stored encrypted (enc:...). The VS Code extension does ` +
                `not hold the age private key — run envpact-cli locally to ` +
                `generate the .env, or rotate the value via the CLI.`;
              child.contextValue = `envpactKey:project:${name}:${k}`;
              return child;
            }
            const status = statuses.get(k);
            const indicator = statusIndicator(status);
            const child = new TreeItem(
              `${indicator.prefix} ${k} = ••••`,
              vscode.TreeItemCollapsibleState.None,
            );
            child.iconPath = indicator.icon;
            child.tooltip = indicator.tooltip || `${k} (status: ${status || 'unknown'})`;
            // contextValue is what package.json's view/item/context
            // menus key off — the canonical pattern is
            //   envpactKey:<scope>:<project>:<KEY>
            child.contextValue = `envpactKey:project:${name}:${k}`;
            return child;
          });

          const children: TreeItem[] = [];
          if (errorMatchesProject) {
            const banner = new TreeItem(
              `cannot decrypt: ${errState!.keys.join(', ')}`,
              vscode.TreeItemCollapsibleState.None,
            );
            banner.iconPath = new vscode.ThemeIcon(
              'error',
              new vscode.ThemeColor('errorForeground'),
            );
            banner.tooltip = errState!.message;
            banner.contextValue = 'envpactResolveError';
            children.push(banner);
          }
          children.push(...leafChildren);

          const item = new TreeItem(
            `${name}  (${keyCount} keys)`,
            vscode.TreeItemCollapsibleState.Collapsed,
            children,
          );
          if (errorMatchesProject) {
            item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('errorForeground'));
            item.tooltip = errState!.message;
          } else {
            item.iconPath = new vscode.ThemeIcon('folder');
          }
          item.contextValue = 'envpactProject';
          return item;
        });
    } catch (e: any) {
      return [new TreeItem(`error: ${e.message}`, vscode.TreeItemCollapsibleState.None)];
    }
  }
}

export class SharedTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<TreeItem[]> {
    if (!vaultExists()) return [];
    try {
      const vault = loadVault();
      return Object.entries(vault.shared || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => {
          const enc = isEncrypted(value);
          const item = new TreeItem(
            `${name} ${enc ? '(encrypted)' : ''}`,
            vscode.TreeItemCollapsibleState.None,
          );
          item.iconPath = new vscode.ThemeIcon(enc ? 'shield' : 'key');
          item.tooltip = enc
            ? 'Encrypted with age — decrypted at resolution time.'
            : 'Plaintext (vault is private).';
          item.contextValue = `envpactKey:shared::${name}`;
          return item;
        });
    } catch (e: any) {
      return [new TreeItem(`error: ${e.message}`, vscode.TreeItemCollapsibleState.None)];
    }
  }
}
