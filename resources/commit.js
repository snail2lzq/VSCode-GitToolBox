(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const repositorySelect = byId('repository');
  const filesElement = byId('files');
  const messageInput = byId('message');
  const selectAll = byId('select-all');
  const commitButton = byId('commit');
  const feedback = byId('feedback');
  const saved = vscode.getState() || {};
  const drafts = saved.drafts || {};
  let repositoryId = saved.repository || '';
  let repositories = [];
  let selected = new Set();
  let wholeFiles = new Set();
  let busy = false;
  let trusted = false;
  let lastClicked = null;

  function current() { return repositories.find(repository => repository.id === repositoryId); }
  function save() {
    if (current()) {
      drafts[repositoryId] = { message: messageInput.value, selected: [...selected], wholeFiles: [...wholeFiles] };
    }
    vscode.setState({ repository: repositoryId, drafts });
  }
  function restore() {
    const draft = drafts[repositoryId] || {};
    messageInput.value = draft.message || '';
    selected = new Set(draft.selected || (current()?.files || []).filter(file => file.staged).map(file => file.id));
    wholeFiles = new Set(draft.wholeFiles || []);
    lastClicked = null;
  }
  function setFeedback(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }
  function isPartial(id) { return selected.has(id) && !wholeFiles.has(id) && current()?.files.some(file => file.id === id && file.partial); }
  function controls() {
    const files = current()?.files || [];
    const selectable = files.filter(file => file.status !== 'U');
    const selectedCount = current() ? selected.size : 0;
    selectAll.checked = selectable.length > 0 && selectedCount === selectable.length && !selectable.some(file => isPartial(file.id));
    selectAll.indeterminate = selectedCount > 0 && (selectedCount < selectable.length || selectable.some(file => isPartial(file.id)));
    selectAll.disabled = busy || !selectable.length;
    byId('count').textContent = String(files.length);
    byId('selection-count').textContent = selectedCount ? `已选择 ${selectedCount} 个文件` : '未选择文件';
    commitButton.disabled = busy || !trusted || !current() || !selectedCount || !messageInput.value.trim() || files.some(file => file.status === 'U');
    commitButton.textContent = busy ? '正在提交…' : 'Commit';
    messageInput.disabled = busy;
    repositorySelect.disabled = busy || repositories.length === 0;
    byId('refresh').disabled = busy;
  }
  function updateSelection() {
    filesElement.querySelectorAll('input[data-file]').forEach(checkbox => {
      const included = selected.has(checkbox.dataset.file);
      checkbox.indeterminate = Boolean(isPartial(checkbox.dataset.file));
      checkbox.checked = included && !checkbox.indeterminate;
      checkbox.title = checkbox.indeterminate ? '部分行已选，点击改为整个文件' : '选择整个文件';
      checkbox.closest('.file-row').classList.toggle('selected', included);
    });
    filesElement.querySelectorAll('input[data-group]').forEach(checkbox => {
      const ids = JSON.parse(checkbox.dataset.group);
      const count = ids.filter(id => selected.has(id)).length;
      checkbox.checked = ids.length > 0 && count === ids.length && !ids.some(isPartial);
      checkbox.indeterminate = count > 0 && (count < ids.length || ids.some(isPartial));
    });
    controls();
    save();
  }
  function toggle(ids, checked) {
    ids.forEach(id => { if (checked) { selected.add(id); wholeFiles.add(id); } else { selected.delete(id); wholeFiles.delete(id); } });
    updateSelection();
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }
  function renderFiles(emptyMessage) {
    const collapsed = new Set([...filesElement.querySelectorAll('details')].filter(node => !node.open).map(node => node.dataset.path));
    filesElement.replaceChildren();
    const files = current()?.files || [];
    const allowed = new Set(files.filter(file => file.status !== 'U').map(file => file.id));
    if (current()) {
      selected = new Set([...selected].filter(id => allowed.has(id)));
      wholeFiles = new Set([...wholeFiles].filter(id => selected.has(id)));
    }
    byId('branch').textContent = current()?.branch || '';
    if (!files.length) {
      filesElement.append(element('div', 'empty', emptyMessage || (current() ? '没有待提交的改动。' : '请打开 Git 项目，或启用内置 Git 扩展。')));
      updateSelection();
      return;
    }
    function renderList(entries) {
      const list = element('ul', 'file-list');
      for (const file of entries) {
        const li = element('li');
        const label = element('div', 'file-row');
        label.title = `双击查看 Git Diff\n${file.path}`;
        label.tabIndex = 0;
        label.setAttribute('role', 'group');
        label.setAttribute('aria-label', `${file.path}，按 Enter 查看差异`);
        const openDiff = () => vscode.postMessage({ type: 'diff', repository: repositoryId, file: file.id });
        label.addEventListener('dblclick', event => {
          if (event.target instanceof HTMLInputElement || event.target.closest('button') || busy) { return; }
          event.preventDefault();
          openDiff();
        });
        label.addEventListener('keydown', event => {
          if (event.target === label && event.key === 'Enter' && !busy) {
            event.preventDefault();
            openDiff();
          }
        });
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.file = file.id;
        checkbox.disabled = busy || file.status === 'U';
        checkbox.setAttribute('aria-label', `选择 ${file.path}`);
        checkbox.addEventListener('click', event => {
          const flat = [...filesElement.querySelectorAll('input[data-file]:not(:disabled)')].map(input => input.dataset.file);
          const from = flat.indexOf(lastClicked);
          const to = flat.indexOf(file.id);
          if (event.shiftKey && from >= 0 && to >= 0) {
            toggle(flat.slice(Math.min(from, to), Math.max(from, to) + 1), checkbox.checked);
          } else {
            toggle([file.id], checkbox.checked);
          }
          lastClicked = file.id;
        });
        const slash = file.path.lastIndexOf('/');
        const name = file.path.slice(slash + 1);
        const directory = slash < 0 ? './' : file.path.slice(0, slash + 1);
        const statusClass = `status-${file.status === '?' ? 'unversioned' : file.status}`;
        const relativePath = element('span', 'file-path', directory);
        relativePath.title = directory;
        label.append(checkbox, element('span', `file-name ${statusClass}`, name), relativePath,
          element('span', `file-status ${statusClass}`, file.status));
        li.append(label);
        list.append(li);
      }
      return list;
    }
    const tracked = files.filter(file => file.status !== '?');
    const unversioned = files.filter(file => file.status === '?');
    if (tracked.length) { filesElement.append(renderList(tracked)); }
    if (unversioned.length) {
      const group = element('details', 'unversioned-group');
      group.dataset.path = 'unversioned';
      group.open = !collapsed.has('unversioned');
      const summary = element('summary');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.group = JSON.stringify(unversioned.map(file => file.id));
      checkbox.disabled = busy;
      checkbox.setAttribute('aria-label', '选择 Unversioned Files 中的全部文件');
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', () => toggle(unversioned.map(file => file.id), checkbox.checked));
      summary.append(checkbox, element('span', 'group-name', 'Unversioned Files'),
        element('span', 'badge', String(unversioned.length)));
      group.append(summary, renderList(unversioned));
      filesElement.append(group);
    }
    updateSelection();
  }

  repositorySelect.addEventListener('change', () => {
    save();
    repositoryId = repositorySelect.value;
    restore();
    setFeedback('');
    renderFiles();
  });
  selectAll.addEventListener('change', () => toggle((current()?.files || []).filter(file => file.status !== 'U').map(file => file.id), selectAll.checked));
  messageInput.addEventListener('input', () => { controls(); save(); });
  byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  byId('commit-form').addEventListener('submit', event => {
    event.preventDefault();
    if (commitButton.disabled) { return; }
    save();
    setFeedback('正在提交所选文件…');
    vscode.postMessage({ type: 'commit', repository: repositoryId, selected: [...selected], partial: [...selected].filter(isPartial), message: messageInput.value });
    busy = true;
    renderFiles();
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      // Keep the draft until the host has finished connecting to Git.
      if (repositories.length) { save(); }
      const previousRepositories = repositories;
      for (const next of message.repositories) {
        const previous = previousRepositories.find(repository => repository.id === next.id);
        const draft = drafts[next.id];
        if (!previous || !draft) { continue; }
        const included = new Set(draft.selected || []);
        const full = new Set(draft.wholeFiles || []);
        for (const file of next.files) {
          const old = previous.files.find(entry => entry.id === file.id);
          if (file.staged && (!old?.staged || (file.partial && !old.partial))) {
            included.add(file.id); full.delete(file.id);
          } else if (!file.staged && old?.staged && !full.has(file.id)) {
            included.delete(file.id);
          }
        }
        draft.selected = [...included]; draft.wholeFiles = [...full];
      }
      repositories = message.repositories;
      busy = message.busy;
      trusted = message.trusted;
      if (!repositories.some(repository => repository.id === repositoryId)) {
        repositoryId = repositories[0]?.id || repositoryId;
      }
      repositorySelect.replaceChildren(...repositories.map(repository => {
        const option = element('option', '', repository.name);
        option.value = repository.id;
        return option;
      }));
      repositorySelect.value = repositoryId;
      restore();
      renderFiles(message.message);
    } else if (message.type === 'lineSelectionChanged') {
      const draft = drafts[message.repository] || { selected: [], wholeFiles: [], message: '' };
      const files = repositories.find(repository => repository.id === message.repository)?.files || [];
      const file = files.find(file => file.id === message.file);
      const included = new Set(draft.selected);
      if (file?.staged) { included.add(message.file); } else { included.delete(message.file); }
      draft.selected = [...included];
      draft.wholeFiles = (draft.wholeFiles || []).filter(id => id !== message.file);
      drafts[message.repository] = draft;
      if (message.repository === repositoryId) { restore(); updateSelection(); }
      else { save(); }
    } else if (message.type === 'result') {
      if (message.ok) {
        delete drafts[message.repository];
        if (repositoryId === message.repository) {
          messageInput.value = '';
          selected.clear();
          wholeFiles.clear();
        }
        updateSelection();
      }
      setFeedback(message.message, !message.ok);
    }
  });
  restore();
  controls();
  vscode.postMessage({ type: 'ready' });
})();
