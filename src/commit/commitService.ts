import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { GitRepository } from '../git/types';

export interface CommitFile {
  id: string;
  path: string;
  status: string;
  paths: string[];
  staged: boolean;
  partial: boolean;
}

const statusLabels: Record<number, string> = {
  0: 'M', 1: 'A', 2: 'D', 3: 'R', 4: 'C', 5: 'M', 6: 'D', 7: '?',
  9: 'A', 10: 'R', 11: 'M',
};

function relativeFile(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('改动路径不在当前仓库中，请刷新后重试。');
  }
  return relative.split(path.sep).join('/');
}

export function collectChanges(repository: GitRepository): CommitFile[] {
  const files = new Map<string, CommitFile>();
  const state = repository.state;
  const stagedIds = new Set(state.indexChanges.map(change => change.uri.toString()));
  const workingIds = new Set([...state.workingTreeChanges, ...state.untrackedChanges].map(change => change.uri.toString()));
  for (const change of [...state.indexChanges, ...state.workingTreeChanges, ...state.untrackedChanges]) {
    const id = change.uri.toString();
    const previous = files.get(id);
    const relative = relativeFile(repository.rootUri.fsPath, change.uri.fsPath);
    const paths = new Set([...(previous?.paths ?? []), relative]);
    // Renames need both sides so the old path is included in the same commit.
    if (change.status === 3 || change.status === 10) {
      if (change.originalUri) {
        paths.add(relativeFile(repository.rootUri.fsPath, change.originalUri.fsPath));
      }
    }
    const status = statusLabels[change.status] ?? 'M';
    const displayStatus = status === 'M' && previous && ['A', 'R', 'C'].includes(previous.status) ? previous.status : status;
    const staged = stagedIds.has(id);
    const working = workingIds.has(id);
    files.set(id, { id, path: relative, status: displayStatus, paths: [...paths], staged, partial: staged && working });
  }
  for (const change of state.mergeChanges) {
    files.set(change.uri.toString(), {
      id: change.uri.toString(), path: relativeFile(repository.rootUri.fsPath, change.uri.fsPath),
      status: 'U', paths: [], staged: false, partial: false,
    });
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function runGit(git: string, root: string, args: string[], input?: string, environment?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(git, ['--literal-pathspecs', '-C', root, ...args], {
      windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: environment ?? process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.on('error', () => { /* Process exit is reported by execFile's callback. */ });
    child.stdin?.end(input);
  });
}

export async function prepareLineSelection(git: string, repository: GitRepository, id: string): Promise<void> {
  const file = collectChanges(repository).find(file => file.id === id);
  if (!file || ['D', 'U'].includes(file.status)) {
    throw new Error('请对存在的文本文件选择行；删除或冲突文件请使用整文件操作。');
  }
  if (file.status === '?') {
    await runGit(git, repository.rootUri.fsPath, ['add', '--intent-to-add', '--', file.path]);
    await repository.status();
  }
}

async function commitIndexPaths(git: string, root: string, paths: string[], message: string): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), 'gittoolbox-selected-index-'));
  const environment = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
  try {
    // Start with HEAD, then copy only selected entries from the real index.
    // The worktree and unrelated staged entries never enter this commit.
    const head = (await runGit(git, root, ['rev-parse', '--revs-only', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
    const entries = await runGit(git, root, ['ls-files', '--stage', '-z', '--', ...paths]);
    await runGit(git, root, head ? ['read-tree', head] : ['read-tree', '--empty'], undefined, environment);
    await runGit(git, root, ['update-index', '--force-remove', '-z', '--stdin'], `${paths.join('\0')}\0`, environment);
    if (entries) {
      await runGit(git, root, ['update-index', '-z', '--index-info'], entries, environment);
    }
    const currentHead = (await runGit(git, root, ['rev-parse', '--revs-only', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
    if (head !== currentHead) {
      throw new Error('HEAD 已变化，请刷新后重试。');
    }
    await runGit(git, root, ['commit', '--file=-'], message, environment);
    // Hooks may update the temporary index. Reconcile selected entries only if
    // nobody has staged new content for these paths while the hook was running.
    const after = await runGit(git, root, ['ls-files', '--stage', '-z', '--', ...paths]);
    if (after === entries) {
      await runGit(git, root, ['reset', '--quiet', 'HEAD', '--', ...paths]);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function commitSelected(
  git: string, repository: GitRepository, selected: readonly string[], message: string, partial: readonly string[] = [],
): Promise<void> {
  if (!message.trim()) {
    throw new Error('请输入提交信息。');
  }
  if (selected.length === 0) {
    throw new Error('请至少选择一个文件。');
  }
  await repository.status();
  if (repository.state.mergeChanges.length > 0) {
    throw new Error('仓库存在合并冲突，请先在源代码管理中处理。');
  }
  const available = new Map(collectChanges(repository).map(file => [file.id, file]));
  const paths = new Set<string>();
  const fullPaths = new Set<string>();
  const partialIds = new Set(partial);
  if (partial.some(id => !selected.includes(id) || !available.get(id)?.staged)) {
    throw new Error('所选行的暂存状态已变化，请重新选择。');
  }
  if (partialIds.size) {
    const pending = await Promise.all(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'].map(ref =>
      runGit(git, repository.rootUri.fsPath, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '')));
    if (pending.some(ref => ref.trim())) {
      throw new Error('合并、变基或拣选进行中，需先完成当前操作再按行提交。');
    }
  }
  for (const id of selected) {
    const file = available.get(id);
    if (!file) {
      throw new Error('所选文件状态已变化，请刷新并重新选择。');
    }
    for (const filePath of file.paths) {
      paths.add(filePath);
      if (!partialIds.has(id)) {
        fullPaths.add(filePath);
      }
    }
  }
  // --only preserves unrelated entries already in the index. Selected files are
  // committed in full, including their saved, unstaged edits.
  // Already-staged deletions (including the old side of a rename) are absent
  // from the index, so passing them to `git add` again would fail.
  const stageable = fullPaths.size ? await runGit(git, repository.rootUri.fsPath,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...fullPaths]) : '';
  const addPaths = [...new Set(stageable.split('\0').filter(Boolean))];
  if (addPaths.length > 0) {
    await runGit(git, repository.rootUri.fsPath, ['add', '--all', '--', ...addPaths]);
  }
  if (partialIds.size) {
    await commitIndexPaths(git, repository.rootUri.fsPath, [...paths], message);
  } else {
    await runGit(git, repository.rootUri.fsPath, ['commit', '--only', '--file=-', '--', ...paths], message);
  }
}
