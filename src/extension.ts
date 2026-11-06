import * as vscode from 'vscode';
import { ActionsView } from './views/actionsView';
import { RepositoriesView } from './views/repositoriesView';
import { CommitView } from './commit/commitView';
import { InlineBlame } from './blame/inlineBlame';
import { ControlPanel } from './control/controlPanel';
import { LineDiffPanel } from './commit/lineDiffPanel';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('GitToolBox', { log: true });
  context.subscriptions.push(output);

  const repositories = new RepositoriesView(output);
  const gitControl = new ControlPanel(context.extensionUri, repositories, output);
  const lineDiff = new LineDiffPanel(context.extensionUri, repositories, output);
  const commitView = new CommitView(context.extensionUri, repositories, output, lineDiff);
  const repositoryTree = vscode.window.createTreeView('gittoolbox.repositories', {
    treeDataProvider: repositories,
    showCollapseAll: true,
  });
  repositoryTree.message = repositories.message;

  context.subscriptions.push(
    repositories,
    gitControl,
    commitView,
    lineDiff,
    repositoryTree,
    vscode.window.registerWebviewViewProvider('gittoolbox.gitControl', gitControl, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('gittoolbox.commit', commitView),
    vscode.window.createTreeView('gittoolbox.actions', { treeDataProvider: new ActionsView() }),
    repositories.onDidChangeTreeData(() => { repositoryTree.message = repositories.message; }),
    vscode.commands.registerCommand('gittoolbox.openControl', () => gitControl.open()),
    vscode.commands.registerCommand('gittoolbox.openCommit', () =>
      vscode.commands.executeCommand('gittoolbox.commit.focus')),
    vscode.commands.registerCommand('gittoolbox.open', () =>
      vscode.commands.executeCommand('workbench.view.extension.gittoolbox')),
    vscode.commands.registerCommand('gittoolbox.refresh', () =>
      vscode.window.withProgress({ location: { viewId: 'gittoolbox.repositories' } }, () => repositories.refresh())),
    vscode.commands.registerCommand('gittoolbox.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'git')),
    new InlineBlame(repositories, output),
  );
  void repositories.connect();

  context.subscriptions.push(
    vscode.commands.registerCommand('gittoolbox.showStatus', () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      output.info(`GitToolBox v${context.extension.packageJSON.version} is active.`);
      output.info(`Workspace folders: ${folders.length}`);
      for (const folder of folders) {
        output.info(`Workspace: ${folder.name}`);
      }
      if (folders.length === 0) {
        output.info('Open a Git project folder to prepare for GitToolBox features.');
      }
      output.show(true);
    }),
  );

  output.info('GitToolBox activated.');
  output.info('Registered Git Control in the bottom panel and Commit in the sidebar.');
}
