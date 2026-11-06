export interface DiffOperation {
  id: string;
  kind: 'add' | 'delete';
  anchor: number;
  raw: string;
}

export interface DiffRow {
  id: string;
  kind: 'context' | 'change' | 'hunk';
  oldLine?: number;
  newLine?: number;
  oldText: string;
  newText: string;
  operations: string[];
}

export interface LineComparison {
  rows: DiffRow[];
  operations: DiffOperation[];
}

export function sourceLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function displayLine(raw: string): string {
  return raw.replace(/\r?\n$/, '');
}

export function parseLineComparison(before: string, after: string, patch: string): LineComparison {
  const oldLines = sourceLines(before), newLines = sourceLines(after);
  const rows: DiffRow[] = [], operations: DiffOperation[] = [];
  let oldIndex = 0, newIndex = 0, inHunk = false;
  let removed: number[] = [], added: number[] = [];
  let blockStart = 0;
  function flush(): void {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const old = removed[index], next = added[index];
      const ids: string[] = [];
      if (old !== undefined) {
        const id = `d:${old}`;
        operations.push({ id, kind: 'delete', anchor: old, raw: oldLines[old] }); ids.push(id);
      }
      if (next !== undefined) {
        const id = `a:${next}`;
        operations.push({ id, kind: 'add', anchor: old ?? (blockStart + removed.length), raw: newLines[next] }); ids.push(id);
      }
      rows.push({ id: `row:${rows.length}`, kind: 'change', oldLine: old === undefined ? undefined : old + 1,
        newLine: next === undefined ? undefined : next + 1, oldText: old === undefined ? '' : displayLine(oldLines[old]),
        newText: next === undefined ? '' : displayLine(newLines[next]), operations: ids });
    }
    removed = []; added = [];
  }
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush(); inHunk = true;
      oldIndex = Math.max(0, Number(header[1]) - (header[2] === '0' ? 0 : 1));
      newIndex = Math.max(0, Number(header[3]) - (header[4] === '0' ? 0 : 1));
      rows.push({ id: `hunk:${rows.length}`, kind: 'hunk', oldText: line, newText: '', operations: [] });
    } else if (inHunk && line.startsWith(' ')) {
      flush();
      rows.push({ id: `context:${rows.length}`, kind: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1,
        oldText: displayLine(oldLines[oldIndex++]), newText: displayLine(newLines[newIndex++]), operations: [] });
    } else if (inHunk && line.startsWith('-')) {
      if (added.length) { flush(); }
      if (!removed.length && !added.length) { blockStart = oldIndex; }
      removed.push(oldIndex++);
    } else if (inHunk && line.startsWith('+')) {
      if (!removed.length && !added.length) { blockStart = oldIndex; }
      added.push(newIndex++);
    }
  }
  flush();
  return { rows, operations };
}

export function applyLineSelection(base: string, operations: readonly DiffOperation[], selected: ReadonlySet<string>): string {
  const removed = new Set<number>();
  const additions = new Map<number, string[]>();
  for (const operation of operations) {
    if (!selected.has(operation.id)) { continue; }
    if (operation.kind === 'delete') { removed.add(operation.anchor); }
    else {
      const entries = additions.get(operation.anchor) ?? [];
      entries.push(operation.raw); additions.set(operation.anchor, entries);
    }
  }
  const lines = sourceLines(base), output: string[] = [];
  for (let index = 0; index <= lines.length; index++) {
    output.push(...(additions.get(index) ?? []));
    if (index < lines.length && !removed.has(index)) { output.push(lines[index]); }
  }
  return output.join('');
}

export function inferLineSelection(base: string, working: LineComparison, staged: LineComparison, indexText: string): Set<string> {
  const key = (operation: DiffOperation): string => JSON.stringify([operation.kind, operation.anchor, operation.raw]);
  const counts = new Map<string, number>();
  for (const operation of staged.operations) { counts.set(key(operation), (counts.get(key(operation)) ?? 0) + 1); }
  const selected = new Set<string>();
  for (const operation of working.operations) {
    const remaining = counts.get(key(operation)) ?? 0;
    if (remaining > 0) { selected.add(operation.id); counts.set(key(operation), remaining - 1); }
  }
  if ([...counts.values()].some(count => count > 0) || applyLineSelection(base, working.operations, selected) !== indexText) {
    throw new Error('暂存内容与工作区改动不一致，请通过原生 Diff 检查后重新打开。');
  }
  return selected;
}
