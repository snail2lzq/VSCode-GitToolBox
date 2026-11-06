(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  let rows = [], selected = new Set(), version = '', busy = true;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }
  function feedback(text, error = false) {
    byId('feedback').textContent = text; byId('feedback').classList.toggle('error', error);
  }
  function selectionState(row) {
    const count = row.operations.filter(id => selected.has(id)).length;
    return { checked: count === row.operations.length, mixed: count > 0 && count < row.operations.length };
  }
  function controls() {
    const changes = rows.filter(row => row.kind === 'change');
    const complete = changes.filter(row => selectionState(row).checked).length;
    const partial = changes.filter(row => selectionState(row).mixed).length;
    byId('select-all').checked = changes.length > 0 && complete === changes.length;
    byId('select-all').indeterminate = complete + partial > 0 && complete !== changes.length;
    byId('select-all').disabled = busy || !changes.length;
    byId('selection-count').textContent = `已选 ${complete}${partial ? ` + ${partial} 半选` : ''} / ${changes.length} 行`;
    byId('refresh').disabled = busy;
    document.querySelectorAll('input[data-row]').forEach(checkbox => { checkbox.disabled = busy; });
  }
  function choose(ids, checked) {
    if (busy || !ids.length) { return; }
    busy = true; controls();
    feedback('正在更新所选行…');
    vscode.postMessage({ type: 'select', version, rows: ids, checked });
  }
  function render() {
    const container = byId('rows'); const scroll = container.scrollTop;
    container.replaceChildren();
    for (const row of rows) {
      if (row.kind === 'hunk') { container.append(element('div', 'hunk', row.oldText)); continue; }
      const line = element('div', `diff-row ${row.kind}`);
      const gutter = element('div', 'selection-gutter');
      if (row.kind === 'change') {
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.row = row.id;
        const state = selectionState(row); checkbox.checked = state.checked && !state.mixed; checkbox.indeterminate = state.mixed;
        checkbox.setAttribute('aria-label', `选择改动行 ${row.newLine ?? row.oldLine}`);
        checkbox.addEventListener('change', () => choose([row.id], checkbox.checked));
        gutter.append(checkbox);
      }
      line.append(gutter, element('span', 'line-number', row.oldLine ?? ''),
        element('code', `code old ${row.kind === 'change' && row.oldLine !== undefined ? 'removed' : ''}`, row.oldText),
        element('span', 'line-number', row.newLine ?? ''),
        element('code', `code new ${row.kind === 'change' && row.newLine !== undefined ? 'added' : ''}`, row.newText));
      container.append(line);
    }
    if (!rows.length) { container.append(element('div', 'empty', '没有可按行选择的文本改动。文件属性等改动可通过 Commit 面板整文件提交。')); }
    container.scrollTop = scroll; controls();
  }
  byId('select-all').addEventListener('change', () => choose(rows.filter(row => row.kind === 'change').map(row => row.id), byId('select-all').checked));
  byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  byId('native').addEventListener('click', () => vscode.postMessage({ type: 'native' }));
  byId('commit').addEventListener('click', () => vscode.postMessage({ type: 'commit' }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      rows = message.rows; selected = new Set(message.selected); version = message.version; busy = false;
      byId('filename').textContent = message.path; render(); feedback('勾选后仅对应代码行加入本次提交。');
    } else if (message.type === 'busy') { busy = message.busy; controls(); }
    else if (message.type === 'error') {
      busy = false;
      if (message.invalidate) { rows = []; selected.clear(); version = ''; render(); }
      feedback(message.message, true); controls();
    }
  });
  controls(); vscode.postMessage({ type: 'ready' });
})();
