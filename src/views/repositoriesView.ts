import * as vscode from 'vscode';
import type { GitAPI, GitExtension, GitRepository } from '../git/types';

class RepositoryItem extends vscode.TreeItem {
  constructor(readonly repository: GitRepository) {
    const root = repository.rootUri;
    const name = root.path.split('/').filter(Boolean).pop() ?? root.toString();
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = root.toString();
    this.description = repository.state.HEAD?.name ?? (repository.state.HEAD?.commit ? 'Detached HEAD' : '尚无提交');
    this.tooltip = root.fsPath;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'gittoolbox.repository';
  }
}

function detail(label: string, description: string, icon: string, openChanges = false): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.description = description;
  item.tooltip = `${label}：${description}`;
  item.iconPath = new vscode.ThemeIcon(icon);
  if (openChanges) {
    item.command = { command: 'workbench.view.scm', title: '打开源代码管理' };
  }
  return item;
}

function repositoryDetails(repository: GitRepository): vscode.TreeItem[] {
  const { HEAD: head, indexChanges, workingTreeChanges, untrackedChanges, mergeChanges } = repository.state;
  const workingCount = new Set([...workingTreeChanges, ...untrackedChanges].map(change => change.uri.toString())).size;
  const upstream = head?.upstream;
  const tracking = upstream
    ? `${upstream.remote}/${upstream.name} · ↑${head.ahead ?? '—'} ↓${head.behind ?? '—'}`
    : '未设置上游分支';
  const commit = detail('最近提交', head?.commit?.slice(0, 8) ?? '尚无提交', 'git-commit');
  commit.tooltip = head?.commit ?? '仓库还没有提交记录';

  return [
    detail('当前分支', head?.name ?? (head?.commit ? 'Detached HEAD' : '尚无分支信息'), 'git-branch'),
    detail('远程跟踪', tracking, 'cloud'),
    detail('已暂存', `${indexChanges.length} 项`, 'check', true),
    detail('未暂存 / 未跟踪', `${workingCount} 项`, 'diff', true),
    detail('合并冲突', `${mergeChanges.length} 项`, 'warning', true),
    commit,
  ];
}

export class RepositoriesView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly apiSubscriptions: vscode.Disposable[] = [];
  private readonly repositorySubscriptions = new Map<string, vscode.Disposable>();
  private api: GitAPI | undefined;
  private extension: GitExtension | undefined;
  private connecting: Promise<void> | undefined;
  private disposed = false;
  message: string | undefined = '正在读取 Git 仓库…';

  constructor(private readonly output: vscode.LogOutputChannel) {
    this.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.connect(); }));
  }

  get repositories(): readonly GitRepository[] {
    return this.api?.repositories ?? [];
  }

  get gitPath(): string | undefined {
    return this.api?.git.path;
  }

  getRepository(uri: vscode.Uri): GitRepository | undefined {
    return this.api?.getRepository(uri) ?? undefined;
  }

  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    if (!this.api) {
      throw new Error('Git 尚未就绪，请刷新后重试。');
    }
    return this.api.toGitUri(uri, ref);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (item instanceof RepositoryItem) {
      return repositoryDetails(item.repository);
    }
    return item ? [] : (this.api?.repositories ?? []).map(repository => new RepositoryItem(repository));
  }

  connect(): Promise<void> {
    this.connecting ??= this.initialize().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async initialize(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.message = '信任此工作区后可查看 Git 仓库。';
      this.changed.fire(undefined);
      return;
    }
    try {
      const installed = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!installed) {
        this.message = '内置 Git 扩展不可用，请在扩展管理中启用 Git。';
        this.changed.fire(undefined);
        return;
      }
      const extension = await installed.activate();
      if (this.disposed) {
        return;
      }
      if (this.extension !== extension) {
        this.extension = extension;
        this.subscriptions.push(extension.onDidChangeEnablement(() => this.attach()));
      }
      this.attach();
    } catch (error) {
      this.message = '无法读取 Git 状态，请查看日志后重试。';
      this.output.error('GitToolBox could not connect to the built-in Git extension.', error);
      this.changed.fire(undefined);
    }
  }

  private attach(): void {
    this.clearAPI();
    if (this.disposed) {
      return;
    }
    if (!this.extension?.enabled) {
      this.message = 'Git 已禁用，请在设置中启用 Git 后重试。';
      this.changed.fire(undefined);
      return;
    }
    this.api = this.extension.getAPI(1);
    const update = (): void => {
      this.message = this.api?.state === 'uninitialized' ? '正在发现 Git 仓库…' : undefined;
      this.changed.fire(undefined);
    };
    for (const repository of this.api.repositories) {
      this.watch(repository);
    }
    this.apiSubscriptions.push(
      this.api.onDidOpenRepository(repository => { this.watch(repository); update(); }),
      this.api.onDidCloseRepository(repository => {
        const id = repository.rootUri.toString();
        this.repositorySubscriptions.get(id)?.dispose();
        this.repositorySubscriptions.delete(id);
        update();
      }),
      this.api.onDidChangeState(update),
    );
    update();
  }

  private watch(repository: GitRepository): void {
    const id = repository.rootUri.toString();
    if (!this.repositorySubscriptions.has(id)) {
      this.repositorySubscriptions.set(id, repository.state.onDidChange(() => this.changed.fire(undefined)));
    }
  }

  async refresh(): Promise<void> {
    if (!this.api) {
      await this.connect();
    }
    const results = await Promise.allSettled((this.api?.repositories ?? []).map(repository => repository.status()));
    if (this.disposed) {
      return;
    }
    const failures = results.filter(result => result.status === 'rejected');
    for (const failure of failures) {
      this.output.error('Could not refresh repository status.', failure.reason);
    }
    if (results.length > 0) {
      this.message = failures.length > 0 ? '部分仓库刷新失败，点击“查看日志”了解详情。' : undefined;
    }
    this.changed.fire(undefined);
  }

  private clearAPI(): void {
    this.api = undefined;
    for (const subscription of this.apiSubscriptions.splice(0)) {
      subscription.dispose();
    }
    for (const subscription of this.repositorySubscriptions.values()) {
      subscription.dispose();
    }
    this.repositorySubscriptions.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clearAPI();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }
}
