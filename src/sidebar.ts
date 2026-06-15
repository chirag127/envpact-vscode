import * as vscode from 'vscode';
import { vaultExists, loadVault, isEncrypted } from './vault';
import { listProjectEnvironments, ENC_PREFIX } from './resolver';

/**
 * Shape pushed into the sidebar by extension.ts when generateEnv hits
 * encrypted leaves. The provider uses this to surface a synthetic node
 * under the affected project and to colour the project icon.
 */
export interface ResolveErrorState {
  project: string;
  environment: string;
  keys: string[];
  message: string;
}

class TreeItem extends vscode.TreeItem {
  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, public readonly children?: TreeItem[]) {
    super(label, collapsibleState);
  }
}

/**
 * Returns true when the raw vault entry encodes (or could encode) an
 * encrypted leaf — either directly as a `enc:...` string, or as a
 * per-environment object whose values include an encrypted override.
 */
function isEncryptedEntry(raw: unknown): boolean {
  if (typeof raw === 'string') return raw.startsWith(ENC_PREFIX);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) return true;
    }
  }
  return false;
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private resolveError: ResolveErrorState | null = null;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Push (or clear with null) the most recent resolve error. */
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
      return Object.keys(vault.projects || {})
        .sort()
        .map((name) => {
          const project = vault.projects![name];
          const projectKeys = Object.keys(project).filter((k) => !k.startsWith('_'));
          const keyCount = projectKeys.length;
          const envs = listProjectEnvironments(vault, name);
          const errorMatchesProject = errState && errState.project === name;

          const leafChildren: TreeItem[] = projectKeys.map((k) => {
            const raw = project[k];
            if (isEncryptedEntry(raw)) {
              const child = new TreeItem(
                `${k} = (encrypted — not decryptable in VS Code)`,
                vscode.TreeItemCollapsibleState.None
              );
              const icon = new vscode.ThemeIcon(
                'shield',
                new vscode.ThemeColor('errorForeground')
              );
              child.iconPath = icon;
              child.tooltip =
                `${k} is stored encrypted (enc:...). The VS Code extension does ` +
                `not hold the age private key — run envpact-cli locally to ` +
                `generate the .env, or rotate the value via the CLI.`;
              child.contextValue = 'envpactEncryptedLeaf';
              return child;
            }
            const child = new TreeItem(`${k} = ****`, vscode.TreeItemCollapsibleState.None);
            child.iconPath = new vscode.ThemeIcon('lock');
            return child;
          });

          // When the most recent generate-env hit encrypted leaves on
          // *this* project, prepend a synthetic banner child so the
          // remediation surfaces inline alongside the keys.
          const children: TreeItem[] = [];
          if (errorMatchesProject) {
            const banner = new TreeItem(
              `cannot decrypt: ${errState!.keys.join(', ')} (env=${errState!.environment || 'default'})`,
              vscode.TreeItemCollapsibleState.None
            );
            banner.iconPath = new vscode.ThemeIcon(
              'error',
              new vscode.ThemeColor('errorForeground')
            );
            banner.tooltip = errState!.message;
            banner.contextValue = 'envpactResolveError';
            children.push(banner);
          }
          children.push(...leafChildren);

          const item = new TreeItem(
            `${name}  (${keyCount} keys${envs.length ? `, ${envs.join('/')}` : ''})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            children
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
          const item = new TreeItem(
            `${name} ${isEncrypted(value) ? '(encrypted)' : ''}`,
            vscode.TreeItemCollapsibleState.None
          );
          item.iconPath = new vscode.ThemeIcon(isEncrypted(value) ? 'shield' : 'key');
          item.tooltip = isEncrypted(value) ? 'Encrypted with age — decrypted at resolution time.' : 'Plaintext (vault is private).';
          return item;
        });
    } catch (e: any) {
      return [new TreeItem(`error: ${e.message}`, vscode.TreeItemCollapsibleState.None)];
    }
  }
}
