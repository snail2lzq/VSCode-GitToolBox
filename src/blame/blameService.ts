import { execFile } from 'node:child_process';
import * as path from 'node:path';

export interface LineBlame {
  hash: string;
  author: string;
  authorTime: number;
  commitTime: number;
  summary: string;
  uncommitted: boolean;
}

export function parseLineBlame(output: string): LineBlame | undefined {
  const lines = output.split('\n');
  const hash = /^([0-9a-f]{40,64}) \d+ \d+(?: \d+)?$/.exec(lines[0] ?? '')?.[1];
  if (!hash) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith('\t')) {
      break;
    }
    const separator = line.indexOf(' ');
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return {
    hash,
    author: fields.get('author') ?? '未知作者',
    authorTime: Number(fields.get('author-time') ?? 0) * 1000,
    commitTime: Number(fields.get('committer-time') ?? 0) * 1000,
    summary: fields.get('summary') ?? '',
    uncommitted: /^0+$/.test(hash),
  };
}

export async function blameLine(
  git: string, root: string, file: string, line: number, contents: string, signal?: AbortSignal,
): Promise<LineBlame | undefined> {
  const relative = path.relative(root, file);
  if (!Number.isInteger(line) || line < 1 || !relative || relative === '..'
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Invalid blame location.');
  }
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(git, [
      '--literal-pathspecs', '-C', root, 'blame', '--line-porcelain',
      '-L', `${line},${line}`, '--contents', '-', '--', relative,
    ], { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.on('error', () => { /* execFile reports early process exits. */ });
    child.stdin?.end(contents);
  });
  return parseLineBlame(output);
}
