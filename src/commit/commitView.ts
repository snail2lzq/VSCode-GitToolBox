import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { RepositoriesView } from '../views/repositoriesView';
import { collectChanges, commitSelected, prepareLineSelection } from './commitService';
import { emptyDiffScheme, openFileDiff } from './openDiff';
import type { LineDiffPanel } from './lineDiffPanel';

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private busy = false;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly repositories: RepositoriesView,
    private readonly output: vscode.LogOutputChannel,
    private readonly lineDiff?: LineDiffPanel,
  ) {
    this.subscriptions.push(repositories.onDidChangeTreeData(() => { this.publish(); }));
    if (lineDiff) {
      this.subscriptions.push(lineDiff.onDidChangeSelection(selection => {
        this.publish();
        void this.view?.webview.postMessage({ type: 'lineSelectionChanged', ...selection });
      }));
    }
    this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(emptyDiffScheme, {
      provideTextDocumentContent: () => '',
    }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    const nonce = randomBytes(24).toString('hex');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'commit.css'));
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'commit.js'));
    view.webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>GitToolBox Commit</title></head>
<body>
  <div class="repository-bar"><label for="repository">仓库</label><select id="repository" aria-label="选择仓库"></select><span id="branch"></span></div>
  <section class="changes" aria-label="Changes">
    <header><label class="changes-label"><input id="select-all" type="checkbox" aria-label="选择全部改动"><strong>Changes</strong><span id="count" class="badge">0</span></label><button id="refresh" class="icon-button" title="刷新改动" aria-label="刷新改动">↻</button></header>
    <div id="files" class="files" aria-label="修改文件列表"></div>
  </section>
  <form id="commit-form" class="compose">
    <div class="message-label"><label for="message">Commit Message</label><span id="selection-count">未选择文件</span></div>
    <textarea id="message" placeholder="输入提交信息…" aria-label="Commit Message" spellcheck="false"></textarea>
    <div id="feedback" role="status" aria-live="polite"></div>
    <button id="commit" type="submit" disabled>Commit</button>
    <p class="hint">双击文件打开 Diff，直接勾选改动行。半选 - 仅提交已选行。</p>
  </form>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
    const listener = view.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); });
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) { this.publish(); } });
    const disposed = view.onDidDispose(() => {
      listener.dispose();
      visibility.dispose();
      disposed.dispose();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    this.subscriptions.push(listener, visibility, disposed);
  }

  private publish(): void {
    if (!this.view || this.disposed) {
      return;
    }
    try {
      void this.view.webview.postMessage({
        type: 'state', busy: this.busy, trusted: vscode.workspace.isTrusted,
        message: this.repositories.message,
        repositories: this.repositories.repositories.map(repository => ({
          id: repository.rootUri.toString(),
          name: vscode.workspace.asRelativePath(repository.rootUri, true),
          branch: repository.state.HEAD?.name ?? (repository.state.HEAD?.commit ? 'Detached HEAD' : '尚无提交'),
          files: collectChanges(repository).map(({ id, path, status, staged, partial }) => ({ id, path, status, staged, partial })),
        })),
      });
    } catch (error) {
      this.output.error('Could not read changes.', error);
      void this.view.webview.postMessage({ type: 'result', ok: false, message: '无法读取改动，请查看日志。' });
    }
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || this.disposed) {
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
      this.publish();
      return;
    }
    if (this.busy) {
      return;
    }
    if (['diff', 'lineDiff'].includes(String(message.type)) && typeof message.repository === 'string' && typeof message.file === 'string') {
      try {
        if (!vscode.workspace.isTrusted) {
          throw new Error('请先信任工作区。');
        }
        const repository = this.repositories.repositories.find(repository => repository.rootUri.toString() === message.repository);
        if (!repository) {
          throw new Error('仓库已关闭，请重新选择。');
        }
        if (message.type === 'diff' && this.lineDiff) {
          await this.lineDiff.open(repository, message.file);
          return;
        }
        const mode = message.type === 'lineDiff' ? (message.staged === true ? 'staged' : 'unstaged') : 'working';
        if (mode === 'unstaged') {
          const git = this.repositories.gitPath;
          if (!git) { throw new Error('Git 尚未就绪。'); }
          await prepareLineSelection(git, repository, message.file);
        }
        await openFileDiff(repository, message.file, (uri, ref) => this.repositories.toGitUri(uri, ref), mode);
      } catch (error) {
        this.output.error('Could not open file diff.', error);
        void this.view?.webview.postMessage({ type: 'result', ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'refresh') {
      await this.repositories.refresh();
      this.publish();
      return;
    }
    if (message.type !== 'commit' || typeof message.repository !== 'string' || typeof message.message !== 'string'
      || !Array.isArray(message.selected) || !message.selected.every(id => typeof id === 'string')) {
      return;
    }
    if (message.partial !== undefined && (!Array.isArray(message.partial) || !message.partial.every(id => typeof id === 'string'))) {
      return;
    }
    this.busy = true;
    this.publish();
    try {
      if (!vscode.workspace.isTrusted || !this.repositories.gitPath) {
        throw new Error('请先信任工作区并启用 Git。');
      }
      const repository = this.repositories.repositories.find(repository => repository.rootUri.toString() === message.repository);
      if (!repository) {
        throw new Error('仓库已关闭，请重新选择。');
      }
      await commitSelected(this.repositories.gitPath, repository, message.selected as string[], message.message,
        (message.partial ?? []) as string[]);
      void this.view?.webview.postMessage({ type: 'result', ok: true, repository: message.repository, message: '提交成功。' });
      await this.repositories.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.error('Commit failed.', error);
      void this.view?.webview.postMessage({ type: 'result', ok: false, message: text });
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
