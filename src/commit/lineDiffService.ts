import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { GitRepository } from '../git/types';
import type { CommitFile } from './commitService';
import { applyLineSelection, inferLineSelection, parseLineComparison, sourceLines } from './lineDiffModel';
import type { LineComparison } from './lineDiffModel';

async function gitBuffer(git: string, root: string, args: string[], input?: string | Buffer, allowed = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(git, ['--literal-pathspecs', '-C', root, ...args], {
      encoding: 'buffer', windowsHide: true, maxBuffer: 12 * 1024 * 1024, timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error && !allowed.includes(Number(error.code))) { reject(new Error(stderr.toString().trim() || error.message)); }
      else { resolve(stdout); }
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(input);
  });
}

function utf8(buffer: Buffer): string {
  if (buffer.includes(0)) { throw new Error('二进制文件不支持行复选框，请打开原生 Diff。'); }
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('当前编码不支持行复选框，请打开原生 Diff。'); }
  return buffer.toString('utf8');
}

function entries(buffer: Buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, hash, stage] = entry.slice(0, tab).split(' ');
    return { mode, hash, stage, path: entry.slice(tab + 1) };
  });
}

async function headHash(git: string, root: string): Promise<string> {
  return (await gitBuffer(git, root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, [0, 1])).toString().trim();
}

async function workingBytes(file: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('此文件类型请使用原生 Diff。'); }
    if (stat.size > 2_000_000) { throw new Error('文件过大，请使用原生 Diff。'); }
    const buffer = await readFile(file);
    utf8(buffer);
    return buffer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    throw error;
  }
}

const fingerprint = (buffer: Buffer | undefined): string => buffer ? createHash('sha256').update(buffer).digest('hex') : 'deleted';

async function compare(git: string, root: string, before: string, after: string): Promise<LineComparison> {
  if (before.length > 2_000_000 || after.length > 2_000_000 || sourceLines(before).length > 50_000 || sourceLines(after).length > 50_000) {
    throw new Error('文件过大，请使用原生 Diff。');
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'gittoolbox-line-diff-'));
  try {
    const old = path.join(temp, 'before'), next = path.join(temp, 'after');
    await Promise.all([writeFile(old, before), writeFile(next, after)]);
    const patch = await gitBuffer(git, root,
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', old, next], undefined, [0, 1]);
    const comparison = parseLineComparison(before, after, patch.toString('utf8'));
    if (comparison.rows.length > 10_000) { throw new Error('改动行数过多，请使用原生 Diff。'); }
    return comparison;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export interface LineDiffSnapshot {
  file: CommitFile;
  head: string;
  indexEntries: Buffer;
  workingFingerprint: string;
  version: string;
  baseText: string;
  workingText: string;
  mode: string;
  baseExists: boolean;
  workingExists: boolean;
  originalPath: string;
  comparison: LineComparison;
  selected: Set<string>;
}

export async function readLineDiff(git: string, repository: GitRepository, file: CommitFile, previous?: LineDiffSnapshot): Promise<LineDiffSnapshot> {
  const root = repository.rootUri.fsPath;
  const originalPath = file.paths.find(entry => entry !== file.path) ?? file.path;
  const absolute = path.resolve(root, file.path);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(file.path)) { throw new Error('无效的文件路径。'); }
  const [head, raw, indexEntries] = await Promise.all([
    headHash(git, root), workingBytes(absolute), gitBuffer(git, root, ['ls-files', '--stage', '-z', '--', ...file.paths]),
  ]);
  const index = entries(indexEntries);
  if (index.some(entry => entry.stage !== '0')) { throw new Error('请先处理合并冲突。'); }
  const tree = head ? await gitBuffer(git, root, ['ls-tree', '-z', head, '--', originalPath]) : Buffer.alloc(0);
  const baseEntry = tree.length ? tree.toString().split('\t')[0].split(' ') : undefined;
  const baseMode = baseEntry?.[0], baseHash = baseEntry?.[2];
  const indexed = index.find(entry => entry.path === file.path);
  const executable = raw !== undefined && Boolean((await lstat(absolute)).mode & 0o111);
  const mode = indexed?.mode ?? baseMode ?? (executable ? '100755' : '100644');
  if (!['100644', '100755'].includes(mode)) { throw new Error('此文件类型请使用原生 Diff。'); }
  const baseText = baseHash ? utf8(await gitBuffer(git, root, ['cat-file', 'blob', baseHash])) : '';
  const workingHash = raw ? (await gitBuffer(git, root, ['hash-object', '-w', `--path=${file.path}`, '--stdin'], raw)).toString().trim() : '';
  const workingText = workingHash ? utf8(await gitBuffer(git, root, ['cat-file', 'blob', workingHash])) : '';
  const indexText = indexed ? utf8(await gitBuffer(git, root, ['cat-file', 'blob', indexed.hash]))
    : (originalPath !== file.path && index.some(entry => entry.path === originalPath) ? baseText : '');
  const [comparison, stagedComparison] = await Promise.all([
    compare(git, root, baseText, workingText), compare(git, root, baseText, indexText),
  ]);
  const selected = previous?.head === head && previous.baseText === baseText && previous.workingText === workingText
    && applyLineSelection(baseText, previous.comparison.operations, previous.selected) === indexText
    ? new Set(previous.selected) : inferLineSelection(baseText, comparison, stagedComparison, indexText);
  return { file, head, indexEntries, workingFingerprint: fingerprint(raw), version: createHash('sha256').update(head).update(indexEntries)
    .update(fingerprint(raw)).digest('hex'), baseText, workingText, mode, baseExists: Boolean(baseHash), workingExists: raw !== undefined,
    originalPath, comparison, selected };
}

export async function selectDiffRows(
  git: string, repository: GitRepository, snapshot: LineDiffSnapshot, rowIds: readonly string[], checked: boolean,
): Promise<Set<string>> {
  const rows = new Map(snapshot.comparison.rows.filter(row => row.kind === 'change').map(row => [row.id, row]));
  if (!rowIds.length || rowIds.some(id => !rows.has(id))) { throw new Error('所选行已变化，请刷新后重试。'); }
  const root = repository.rootUri.fsPath;
  const [head, index, raw] = await Promise.all([headHash(git, root),
    gitBuffer(git, root, ['ls-files', '--stage', '-z', '--', ...snapshot.file.paths]), workingBytes(path.join(root, snapshot.file.path))]);
  if (head !== snapshot.head || !index.equals(snapshot.indexEntries) || fingerprint(raw) !== snapshot.workingFingerprint) {
    throw new Error('文件或暂存状态已变化，已停止操作，请刷新后重新勾选。');
  }
  const selected = new Set(snapshot.selected);
  for (const id of rowIds) {
    for (const operation of rows.get(id)!.operations) {
      if (checked) { selected.add(operation); } else { selected.delete(operation); }
    }
  }
  const text = applyLineSelection(snapshot.baseText, snapshot.comparison.operations, selected);
  const anySelected = selected.size > 0;
  const allSelected = selected.size === snapshot.comparison.operations.length;
  const remove = (!snapshot.baseExists && !anySelected) || (!snapshot.workingExists && allSelected);
  const hash = remove ? '' : (await gitBuffer(git, root, ['hash-object', '-w', '--stdin'], text)).toString().trim();
  const zeros = '0'.repeat((snapshot.head || hash || entries(index)[0]?.hash || '').length || 40);
  const changes = snapshot.file.paths.map(file => `0 ${zeros}\t${file}\0`);
  if (!remove) { changes.push(`${snapshot.mode} ${hash}\t${snapshot.file.path}\0`); }
  await gitBuffer(git, root, ['update-index', '-z', '--index-info'], changes.join(''));
  return selected;
}
