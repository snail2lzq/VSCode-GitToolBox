import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GitCommit } from '../git/types';
import type { RepositoriesView } from '../views/repositoriesView';
import { emptyDiffScheme } from '../commit/openDiff';
import { checkoutLocalBranch, readControlState, readHistoryFiles } from './controlService';
import type { HistoryFile } from './controlService';

export class ControlPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly viewSubscriptions: vscode.Disposable[] = [];
  private repositoryId = '';
  private selectedRef = '';
  private limit = 50;
  private generation = 0;
  private detailGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private state: Awaited<ReturnType<typeof readControlState>> | undefined;
  private detail: { commit: GitCommit; files: HistoryFile[] } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly repositories: RepositoriesView,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions.push(repositories.onDidChangeTreeData(() => {
      if (this.panel) {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.load(); }, 150);
      }
    }));
  }

  open(): Thenable<unknown> {
    return vscode.commands.executeCommand('gittoolbox.gitControl.focus');
  }

  resolveWebviewView(panel: vscode.WebviewView): void {
    this.generation++;
    this.detailGeneration++;
    for (const subscription of this.viewSubscriptions.splice(0)) {
      subscription.dispose();
    }
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    panel.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    panel.title = 'Git Control';
    this.panel = panel;
    const nonce = randomBytes(24).toString('hex');
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'control.css'));
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'control.js'));
    const graph = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'commit-graph.js'));
    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>Git Control</title></head><body>
<header class="toolbar"><strong class="brand">Git Control</strong><label for="repository">仓库</label><select id="repository" aria-label="选择仓库"></select><span id="head" class="head"></span><button id="refresh">刷新</button><button id="open-commit" class="primary">Commit…</button></header>
<div id="feedback" class="feedback" role="status" aria-live="polite"></div>
<main id="control-layout" class="layout">
  <aside id="control-branches" class="branches"><h2>分支</h2><input id="branch-search" type="search" placeholder="筛选分支…" aria-label="筛选分支"><div id="branch-list" class="branch-list"></div><div class="branch-actions"><button id="checkout" disabled>切换到此分支</button></div></aside>
  <div id="branches-splitter" class="splitter splitter-vertical" role="separator" tabindex="0" aria-label="调整分支列表宽度" aria-orientation="vertical" aria-controls="control-branches control-history" title="拖动调整分支宽度，双击恢复默认"></div>
  <section id="control-history" class="history"><div class="section-toolbar"><h2>提交记录</h2><span id="history-ref" class="muted"></span></div><input id="log-search" type="search" placeholder="搜索已加载的提交、作者或 SHA…" aria-label="搜索提交"><div id="log-heading" class="log-heading"><span>分支</span><span>提交说明</span><span>作者</span><span>时间</span><span>SHA</span></div><div id="commit-list" class="commit-list" role="listbox" aria-label="提交记录"></div><footer><span id="log-count" class="muted"></span><button id="more" hidden>加载更多</button></footer></section>
  <div id="inspector-splitter" class="splitter splitter-vertical" role="separator" tabindex="0" aria-label="调整提交详情宽度" aria-orientation="vertical" aria-controls="control-history control-inspector" title="拖动调整详情宽度，双击恢复默认"></div>
  <aside id="control-inspector" class="inspector"><section class="changed-files"><div class="section-toolbar"><h2>提交文件</h2><span id="history-files-count" class="muted"></span></div><div id="history-files" class="file-list"></div></section><div id="details-splitter" class="splitter splitter-horizontal" role="separator" tabindex="0" aria-label="调整文件列表与提交信息高度" aria-orientation="horizontal" title="拖动调整上下区域，双击恢复默认"></div><section class="commit-info"><div class="section-toolbar"><h2>提交信息</h2></div><div id="commit-detail" class="commit-detail"></div></section></aside>
</main><script nonce="${nonce}" src="${graph}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const received = panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); });
    const visibility = panel.onDidChangeVisibility(() => {
      if (panel.visible) {
        void this.load();
      }
    });
    const disposed = panel.onDidDispose(() => {
      received.dispose();
      visibility.dispose();
      disposed.dispose();
      this.panel = undefined;
      this.generation++;
      this.detailGeneration++;
      clearTimeout(this.timer);
      this.state = undefined;
      this.detail = undefined;
    });
    this.viewSubscriptions.push(received, visibility, disposed);
  }

  private send(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private fail(error: unknown): void {
    if (!this.panel) {
      return;
    }
    this.output.error('Git Control operation failed.', error);
    this.send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.send({ type: 'loading' });
    try {
      const repositories = this.repositories.repositories;
      let repository = repositories.find(repository => repository.rootUri.toString() === this.repositoryId);
      if (!repository) {
        repository = repositories[0];
        this.repositoryId = repository?.rootUri.toString() ?? '';
        this.selectedRef = '';
        this.detail = undefined;
        this.detailGeneration++;
      }
      const state = repository && vscode.workspace.isTrusted
        ? await readControlState(repository, this.selectedRef, this.limit) : undefined;
      if (!this.panel || generation !== this.generation) {
        return;
      }
      this.state = state;
      this.selectedRef = state?.selectedRef ?? '';
      this.send({
        type: 'state', repository: this.repositoryId, busy: this.busy, state,
        repositories: repositories.map(repository => ({ id: repository.rootUri.toString(), name: repository.rootUri.fsPath })),
        message: this.repositories.message ?? (!repository ? '打开包含 Git 仓库的文件夹后，可在此管理分支和提交。' : ''),
        detail: this.detail ? this.serializeDetail() : undefined,
      });
    } catch (error) {
      if (generation === this.generation) {
        this.fail(error);
      }
    }
  }

  private serializeDetail() {
    if (!this.detail) {
      return undefined;
    }
    const { commit, files } = this.detail;
    return { hash: commit.hash, message: commit.message, author: commit.authorName, email: commit.authorEmail,
      date: commit.authorDate?.toISOString(), parents: commit.parents, files };
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || !this.panel) {
      return;
    }
    const message = value as Record<string, unknown>;
    try {
      if (message.type === 'ready') {
        await this.load();
        return;
      }
      if (this.busy) {
        return;
      }
      if (message.type === 'openCommit') {
        await vscode.commands.executeCommand('gittoolbox.openCommit');
        return;
      }
      if (['selectRef', 'more', 'selectCommit', 'diffCommit', 'checkout'].includes(String(message.type))
        && message.repository !== this.repositoryId) {
        throw new Error('仓库已切换，请等待界面更新后重试。');
      }
      if (message.type === 'selectRepository' && typeof message.repository === 'string') {
        if (!this.repositories.repositories.some(repository => repository.rootUri.toString() === message.repository)) {
          throw new Error('仓库已关闭，请刷新后重试。');
        }
        this.repositoryId = message.repository;
        this.selectedRef = '';
        this.limit = 50;
        this.detail = undefined;
        this.detailGeneration++;
        await this.load();
        return;
      }
      if (message.type === 'selectRef' && typeof message.ref === 'string') {
        if (message.ref && !this.state?.branches.some(branch => branch.ref === message.ref)) {
          throw new Error('分支已变化，请刷新后重试。');
        }
        this.selectedRef = message.ref;
        this.limit = 50;
        this.detail = undefined;
        this.detailGeneration++;
        await this.load();
        return;
      }
      if (message.type === 'more') {
        this.limit = Math.min(this.limit + 50, 1000);
        await this.load();
        return;
      }
      if (message.type === 'refresh') {
        await this.repositories.refresh();
        await this.load();
        return;
      }
      if (!vscode.workspace.isTrusted) {
        throw new Error('请先信任工作区。');
      }
      const repository = this.repositories.repositories.find(repository => repository.rootUri.toString() === this.repositoryId);
      if (!repository) {
        throw new Error('仓库不可用，请刷新后重试。');
      }
      if (message.type === 'selectCommit' && typeof message.hash === 'string') {
        if (!this.state?.commits.some(commit => commit.hash === message.hash)) {
          throw new Error('提交不在当前列表中，请刷新后重试。');
        }
        const request = ++this.detailGeneration;
        const root = this.repositoryId;
        const commit = await repository.getCommit(message.hash);
        const git = this.repositories.gitPath;
        if (!git) {
          throw new Error('Git 不可用。');
        }
        const files = await readHistoryFiles(git, repository.rootUri.fsPath, commit);
        if (!this.panel || request !== this.detailGeneration || root !== this.repositoryId) {
          return;
        }
        this.detail = { commit, files };
        this.send({ type: 'detail', detail: this.serializeDetail() });
      } else if (message.type === 'diffCommit' && typeof message.file === 'string' && this.detail && message.hash === this.detail.commit.hash) {
        const file = this.detail.files.find(file => file.id === message.file);
        if (!file) {
          throw new Error('请选择提交详情中的文件。');
        }
        const safeUri = (path: string): vscode.Uri => {
          if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
            throw new Error('无效的文件路径。');
          }
          return vscode.Uri.joinPath(repository.rootUri, path);
        };
        const uri = safeUri(file.path);
        const empty = uri.with({ scheme: emptyDiffScheme, authority: '', query: '', fragment: '' });
        const parent = this.detail.commit.parents[0];
        const left = parent && file.status !== 'A' ? this.repositories.toGitUri(safeUri(file.originalPath), parent) : empty;
        const right = file.status === 'D' ? empty : this.repositories.toGitUri(uri, this.detail.commit.hash);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (${this.detail.commit.hash.slice(0, 8)})`, { preview: false });
      } else if (message.type === 'checkout' && typeof message.ref === 'string') {
        this.busy = true;
        this.send({ type: 'busy', busy: true });
        try {
          await checkoutLocalBranch(repository, message.ref);
          this.selectedRef = message.ref;
          await this.repositories.refresh();
        } finally {
          this.busy = false;
          this.send({ type: 'busy', busy: false });
          await this.load();
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.generation++;
    this.detailGeneration++;
    clearTimeout(this.timer);
    this.panel = undefined;
    for (const subscription of this.viewSubscriptions.splice(0)) {
      subscription.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
