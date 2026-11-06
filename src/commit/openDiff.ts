import * as vscode from 'vscode';
import type { GitRepository } from '../git/types';
import { collectChanges } from './commitService';

export const emptyDiffScheme = 'gittoolbox-empty';

export async function openFileDiff(
  repository: GitRepository, fileId: string, toGitUri: (uri: vscode.Uri, ref: string) => vscode.Uri,
  mode: 'working' | 'unstaged' | 'staged' = 'working',
): Promise<void> {
  // Resolve the identifier against current repository changes rather than
  // accepting an arbitrary path from the webview.
  const file = collectChanges(repository).find(change => change.id === fileId);
  if (!file) {
    throw new Error('文件状态已变化，请刷新后重试。');
  }
  const current = vscode.Uri.joinPath(repository.rootUri, file.path);
  const empty = current.with({ scheme: emptyDiffScheme, authority: '', query: '', fragment: '' });
  const indexChange = repository.state.indexChanges.find(change => change.uri.toString() === fileId);
  const added = indexChange ? [1, 4, 9].includes(indexChange.status) : ['A', 'C', '?'].includes(file.status);
  const commit = repository.state.HEAD?.commit;
  const originalPath = file.paths.find(path => path !== file.path) ?? file.path;
  const original = vscode.Uri.joinPath(repository.rootUri, originalPath);
  const left = mode === 'unstaged' ? toGitUri(current, '') : (commit && !added ? toGitUri(original, commit) : empty);
  const right = mode === 'staged' ? toGitUri(current, '') : (file.status === 'D' ? empty : current);
  const comparison = left === empty ? '新增文件' : (right === empty ? '已删除' : 'HEAD ↔ Working Tree');
  const title = mode === 'unstaged' ? '选择行加入提交' : mode === 'staged' ? '已选行 · 可取消暂存所选范围' : comparison;
  await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (${title})`, {
    preview: false, viewColumn: vscode.ViewColumn.Active,
  });
}
