import * as vscode from 'vscode';
import { vaultExists, loadVault, isEncrypted } from './vault';
import { listProjectEnvironments } from './resolver';

class TreeItem extends vscode.TreeItem {
  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, public readonly children?: TreeItem[]) {
    super(label, collapsibleState);
  }
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
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
      return Object.keys(vault.projects || {})
        .sort()
        .map((name) => {
          const project = vault.projects![name];
          const keyCount = Object.keys(project).filter((k) => !k.startsWith('_')).length;
          const envs = listProjectEnvironments(vault, name);
          const item = new TreeItem(
            `${name}  (${keyCount} keys${envs.length ? `, ${envs.join('/')}` : ''})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            Object.keys(project)
              .filter((k) => !k.startsWith('_'))
              .map((k) => {
                const child = new TreeItem(`${k} = ****`, vscode.TreeItemCollapsibleState.None);
                child.iconPath = new vscode.ThemeIcon('lock');
                return child;
              })
          );
          item.iconPath = new vscode.ThemeIcon('folder');
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
