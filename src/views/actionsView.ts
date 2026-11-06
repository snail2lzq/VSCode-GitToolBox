import * as vscode from 'vscode';

export class ActionsView implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (item) {
      return [];
    }
    return [
      this.action('Git Control', 'git-branch', 'gittoolbox.openControl'),
      this.action('Commit Changes', 'git-commit', 'gittoolbox.openCommit'),
      this.action('打开源代码管理', 'source-control', 'workbench.view.scm'),
      this.action('刷新仓库状态', 'refresh', 'gittoolbox.refresh'),
      this.action('打开 Git 设置', 'settings-gear', 'gittoolbox.openSettings'),
      this.action('查看日志', 'output', 'gittoolbox.showStatus'),
    ];
  }

  private action(label: string, icon: string, command: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon(icon);
    item.command = { command, title: label };
    return item;
  }
}
