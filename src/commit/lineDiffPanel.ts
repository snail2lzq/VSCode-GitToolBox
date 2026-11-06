import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GitRepository } from '../git/types';
import type { RepositoriesView } from '../views/repositoriesView';
import { collectChanges } from './commitService';
import { openFileDiff } from './openDiff';
import { readLineDiff, selectDiffRows } from './lineDiffService';
import type { LineDiffSnapshot } from './lineDiffService';

export class LineDiffPanel implements vscode.Disposable {
  private readonly selectionChanged = new vscode.EventEmitter<{ repository: string; file: string }>();
  readonly onDidChangeSelection = this.selectionChanged.event;
  private panel: vscode.WebviewPanel | undefined;
  private repositoryId = '';
  private fileId = '';
  private snapshot: LineDiffSnapshot | undefined;
  private generation = 0;
  private busy = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly panelSubscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly repositories: RepositoriesView,
    private readonly output: vscode.LogOutputChannel) {
    this.subscriptions.push(repositories.onDidChangeTreeData(() => {
      if (this.panel && !this.busy) {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.refresh(); }, 150);
      }
    }));
  }

  async open(repository: GitRepository, fileId: string): Promise<void> {
    if (this.busy) { return; }
    const root = repository.rootUri.toString();
    if (root !== this.repositoryId || fileId !== this.fileId) { this.snapshot = undefined; }
    this.repositoryId = root; this.fileId = fileId;
    if (this.panel) { this.panel.reveal(); await this.refresh(); return; }
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    const panel = vscode.window.createWebviewPanel('gittoolbox.lineDiff', 'Git Diff', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: true,
    });
    this.panel = panel;
    const nonce = randomBytes(24).toString('hex');
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'line-diff.css'));
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'line-diff.js'));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>Git Diff</title></head><body>
<header><label><input id="select-all" type="checkbox" aria-label="选择全部改动行"><strong id="filename">Git Diff</strong></label><span id="selection-count"></span><button id="refresh">刷新</button><button id="native">原生 Diff</button><button id="commit">Commit…</button></header>
<div id="feedback" role="status" aria-live="polite">正在读取改动…</div><div class="column-headings"><span>选择</span><span>原行</span><span>HEAD</span><span>新行</span><span>工作区</span></div>
<main id="rows" aria-label="逐行 Git Diff"></main><footer>直接勾选改动行；蓝底 - 表示该行仅部分内容已暂存。工作区代码保持不变。</footer>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.panelSubscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); }),
      panel.onDidDispose(() => {
        this.panel = undefined; this.snapshot = undefined; this.generation++;
        clearTimeout(this.timer);
        for (const subscription of this.panelSubscriptions.splice(0)) { subscription.dispose(); }
      }));
  }

  private post(message: unknown): void { void this.panel?.webview.postMessage(message); }

  private repository(): GitRepository {
    if (!vscode.workspace.isTrusted) { throw new Error('请先信任工作区。'); }
    const repository = this.repositories.repositories.find(repository => repository.rootUri.toString() === this.repositoryId);
    if (!repository || !this.repositories.gitPath) { throw new Error('仓库不可用，请刷新后重试。'); }
    return repository;
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.post({ type: 'busy', busy: true });
    try {
      const repository = this.repository();
      const file = collectChanges(repository).find(file => file.id === this.fileId) ?? this.snapshot?.file;
      if (!file) { throw new Error('文件已经没有待提交改动，请刷新 Commit 面板。'); }
      const snapshot = await readLineDiff(this.repositories.gitPath!, repository, file, this.snapshot);
      if (!this.panel || generation !== this.generation) { return; }
      this.snapshot = snapshot;
      this.panel.title = `${file.path.split('/').pop()} — Git Diff`;
      this.post({ type: 'state', path: file.path, version: snapshot.version, selected: [...snapshot.selected],
        rows: snapshot.comparison.rows, busy: false });
    } catch (error) {
      if (this.panel && generation === this.generation) {
        this.snapshot = undefined;
        this.output.debug('Interactive line diff unavailable.', error);
        this.post({ type: 'error', invalidate: true, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || !this.panel) { return; }
    const message = value as Record<string, unknown>;
    if (this.busy) { return; }
    try {
      if (message.type === 'ready' || message.type === 'refresh') { await this.refresh(); return; }
      if (message.type === 'commit') { await vscode.commands.executeCommand('gittoolbox.openCommit'); return; }
      if (message.type === 'native') {
        await openFileDiff(this.repository(), this.fileId, (uri, ref) => this.repositories.toGitUri(uri, ref)); return;
      }
      if (message.type !== 'select' || typeof message.checked !== 'boolean' || !Array.isArray(message.rows)
        || !message.rows.every(id => typeof id === 'string') || !this.snapshot || message.version !== this.snapshot.version) { return; }
      this.busy = true; this.generation++;
      this.post({ type: 'busy', busy: true });
      try {
        const repository = this.repository();
        this.snapshot.selected = await selectDiffRows(this.repositories.gitPath!, repository, this.snapshot, message.rows as string[], message.checked);
        await repository.status();
        this.selectionChanged.fire({ repository: this.repositoryId, file: this.fileId });
        await this.refresh();
      } finally { this.busy = false; }
    } catch (error) {
      this.output.error('Could not update selected diff lines.', error);
      await this.refresh();
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.generation++; clearTimeout(this.timer);
    this.panel?.dispose();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    for (const subscription of this.panelSubscriptions.splice(0)) { subscription.dispose(); }
    this.selectionChanged.dispose();
  }
}
