import { execFile } from 'node:child_process';
import type { GitCommit, GitRepository } from '../git/types';

export interface ControlBranch {
  name: string;
  ref: string;
  remote: boolean;
  current: boolean;
  commit?: string;
}

export interface HistoryFile {
  id: string;
  path: string;
  originalPath: string;
  status: string;
}

export async function readControlState(repository: GitRepository, requestedRef = '', limit = 50) {
  const [local, remote] = await Promise.all([
    repository.getBranches({ remote: false }), repository.getBranches({ remote: true }),
  ]);
  const branches: ControlBranch[] = [];
  for (const [refs, isRemote] of [[local, false], [remote, true]] as const) {
    for (const branch of refs) {
      if (!branch.name || branch.name.endsWith('/HEAD')) {
        continue;
      }
      const name = isRemote && branch.remote && !branch.name.startsWith(`${branch.remote}/`)
        ? `${branch.remote}/${branch.name}` : branch.name;
      branches.push({
        name, ref: `${isRemote ? 'refs/remotes' : 'refs/heads'}/${name}`, remote: isRemote,
        current: !isRemote && name === repository.state.HEAD?.name, commit: branch.commit,
      });
    }
  }
  const head = repository.state.HEAD;
  if (head?.name && !branches.some(branch => branch.current)) {
    branches.unshift({ name: head.name, ref: `refs/heads/${head.name}`, remote: false, current: true, commit: head.commit });
  }
  branches.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  const selectedBranch = branches.find(branch => branch.ref === requestedRef);
  const selectedRef = selectedBranch?.ref ?? '';
  const commits = (selectedBranch ? selectedBranch.commit : (head?.commit || branches.some(branch => branch.commit)))
    ? await repository.log({ maxEntries: limit + 1, refNames: selectedRef ? [selectedRef] : ['--all'] }) : [];
  return {
    head: head?.name ?? (head?.commit ? 'Detached HEAD' : '尚无提交'),
    upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : '',
    ahead: head?.ahead, behind: head?.behind,
    branches, selectedRef, hasMore: commits.length > limit && limit < 1000,
    commits: commits.slice(0, limit).map(commit => ({
      hash: commit.hash, message: commit.message, parents: commit.parents,
      author: commit.authorName ?? '未知作者', date: commit.authorDate?.toISOString() ?? '',
    })),
  };
}

export async function checkoutLocalBranch(repository: GitRepository, ref: string): Promise<void> {
  const branches = await repository.getBranches({ remote: false });
  const branch = branches.find(branch => branch.name && `refs/heads/${branch.name}` === ref);
  if (!branch?.name) {
    throw new Error('请选择仍然存在的本地分支。');
  }
  await repository.checkout(branch.name);
}

export function parseHistoryFiles(output: string): HistoryFile[] {
  const fields = output.split('\0');
  const files: HistoryFile[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++][0];
    const originalPath = fields[index++];
    const filePath = status === 'R' || status === 'C' ? fields[index++] : originalPath;
    if (filePath === undefined || originalPath === undefined || !'AMDRCTUXB'.includes(status)) {
      throw new Error('无法读取提交中的文件列表。');
    }
    files.push({ id: String(files.length), path: filePath, originalPath, status });
  }
  return files;
}

export async function readHistoryFiles(git: string, root: string, commit: GitCommit): Promise<HistoryFile[]> {
  if (![commit.hash, ...commit.parents].every(hash => /^[0-9a-f]{40,64}$/.test(hash))) {
    throw new Error('无效的提交 ID。');
  }
  const args = commit.parents.length
    ? ['diff', '--name-status', '-z', '--find-renames', commit.parents[0], commit.hash, '--']
    : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', commit.hash, '--'];
  const output = await new Promise<string>((resolve, reject) => {
    execFile(git, ['--literal-pathspecs', '-C', root, ...args], {
      windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return parseHistoryFiles(output);
}
