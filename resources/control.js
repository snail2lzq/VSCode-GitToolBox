(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  let repository = '';
  let state;
  let detail;
  let busy = false;
  let loading = true;
  let selectedHash = '';
  let fileTreeCommit = '';
  const directoryExpansion = new Map();

  function initializeSplitters() {
    const layout = byId('control-layout');
    const branches = byId('control-branches');
    const inspector = byId('control-inspector');
    const saved = vscode.getState?.()?.layout || {};
    const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const sizes = {
      branches: finite(saved.branches, 210), inspector: finite(saved.inspector, 350),
      files: finite(saved.files, .5),
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const handles = [byId('branches-splitter'), byId('inspector-splitter'), byId('details-splitter')];
    let drag;
    function geometry() {
      const width = layout.clientWidth || layout.getBoundingClientRect().width;
      const left = branches.getBoundingClientRect().width || sizes.branches;
      const right = inspector.getBoundingClientRect().width || sizes.inspector;
      const height = Math.max(1, (inspector.clientHeight || inspector.getBoundingClientRect().height) - 5);
      return { width, left, right, height };
    }
    function apply() {
      const { width, height } = geometry();
      const left = clamp(sizes.branches, 140, width ? Math.max(140, width - 490) : 10000);
      const right = clamp(sizes.inspector, 220, width ? Math.max(220, width - left - 270) : 10000);
      const minRatio = Math.min(.5, 60 / height);
      const ratio = clamp(sizes.files, minRatio, 1 - minRatio);
      layout.style.setProperty('--branches-width', `${left}px`);
      layout.style.setProperty('--inspector-width', `${right}px`);
      inspector.style.setProperty('--files-weight', String(ratio));
      inspector.style.setProperty('--info-weight', String(1 - ratio));
      for (const [handle, value, min, max] of [
        [handles[0], left, 140, width ? Math.max(140, width - right - 270) : 10000],
        [handles[1], right, 220, width ? Math.max(220, width - left - 270) : 10000],
        [handles[2], Math.round(ratio * 100), Math.round(minRatio * 100), Math.round((1 - minRatio) * 100)],
      ]) {
        handle.setAttribute('aria-valuenow', String(Math.round(value)));
        handle.setAttribute('aria-valuemin', String(Math.round(min)));
        handle.setAttribute('aria-valuemax', String(Math.round(max)));
      }
    }
    function persist() {
      vscode.setState?.({ ...(vscode.getState?.() || {}), layout: { ...sizes } });
    }
    function resize(index, delta, start = geometry()) {
      if (index === 0) {
        sizes.branches = clamp(start.left + delta, 140, start.width ? Math.max(140, start.width - start.right - 270) : 10000);
      } else if (index === 1) {
        sizes.inspector = clamp(start.right - delta, 220, start.width ? Math.max(220, start.width - start.left - 270) : 10000);
      } else {
        const ratio = start.ratio ?? Number(inspector.style.getPropertyValue('--files-weight'));
        const min = Math.min(.5, 60 / start.height);
        sizes.files = clamp(ratio + delta / start.height, min, 1 - min);
      }
      apply();
    }
    function finish(event) {
      if (!drag || (event && event.pointerId !== drag.pointerId)) { return; }
      const previous = drag;
      drag = undefined;
      previous.handle.classList.remove('dragging');
      document.body.classList.remove('resizing-columns', 'resizing-rows');
      if (previous.handle.hasPointerCapture?.(previous.pointerId)) { previous.handle.releasePointerCapture(previous.pointerId); }
      persist();
    }
    handles.forEach((handle, index) => {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) { return; }
        event.preventDefault();
        handle.focus();
        drag = { handle, index, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          ...geometry(), ratio: Number(inspector.style.getPropertyValue('--files-weight')) };
        handle.setPointerCapture?.(event.pointerId);
        handle.classList.add('dragging');
        document.body.classList.add(index === 2 ? 'resizing-rows' : 'resizing-columns');
      });
      handle.addEventListener('keydown', event => {
        const decrease = index === 2 ? 'ArrowUp' : 'ArrowLeft';
        const increase = index === 2 ? 'ArrowDown' : 'ArrowRight';
        if (![decrease, increase, 'Home', 'End'].includes(event.key)) { return; }
        event.preventDefault();
        const delta = event.key === 'Home' ? -100000 : event.key === 'End' ? 100000
          : (event.key === decrease ? -1 : 1) * (event.shiftKey ? 40 : 10);
        // The right splitter moves right when the inspector becomes narrower.
        resize(index, index === 1 && ['Home', 'End'].includes(event.key) ? -delta : delta);
        persist();
      });
      handle.addEventListener('dblclick', () => {
        if (index === 0) { sizes.branches = 210; }
        else if (index === 1) { sizes.inspector = 350; }
        else { sizes.files = .5; }
        apply(); persist();
      });
    });
    window.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) { return; }
      resize(drag.index, drag.index === 2 ? event.clientY - drag.y : event.clientX - drag.x, drag);
    });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', () => finish());
    window.addEventListener('resize', apply);
    if (typeof ResizeObserver !== 'undefined') { new ResizeObserver(apply).observe(layout); }
    apply();
  }

  function send(message) { vscode.postMessage({ repository, ...message }); }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }
  function feedback(text, error = false) {
    byId('feedback').textContent = text;
    byId('feedback').classList.toggle('error', error);
  }
  function date(value) {
    if (!value) { return '—'; }
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  }
  function controls() {
    const disabled = busy || loading;
    byId('repository').disabled = disabled || !byId('repository').options.length;
    byId('refresh').disabled = disabled;
    byId('open-commit').disabled = disabled;
    byId('more').disabled = disabled;
    const selected = state?.branches.find(branch => branch.ref === state.selectedRef);
    byId('checkout').disabled = disabled || !selected || selected.remote || selected.current;
    byId('checkout').textContent = busy ? '正在切换…' : '切换到此分支';
    document.querySelectorAll('.branch-list button, .commit-row, .file-row').forEach(button => { button.disabled = disabled; });
  }
  function renderBranches() {
    const list = byId('branch-list'); list.replaceChildren();
    const all = element('button', state?.selectedRef ? '' : 'active', '全部分支');
    all.type = 'button'; all.addEventListener('click', () => send({ type: 'selectRef', ref: '' }));
    list.append(all);
    const query = byId('branch-search').value.trim().toLocaleLowerCase();
    for (const remote of [false, true]) {
      list.append(element('div', 'group-heading', remote ? 'Remote' : 'Local'));
      const branches = (state?.branches || []).filter(branch => branch.remote === remote && branch.name.toLocaleLowerCase().includes(query));
      if (!branches.length) { list.append(element('div', 'empty', '无分支')); }
      for (const branch of branches) {
        const button = element('button', `${branch.current ? 'current' : ''} ${state.selectedRef === branch.ref ? 'active' : ''}`);
        button.type = 'button'; button.title = branch.name;
        button.dataset.ref = branch.ref;
        button.append(element('span', 'branch-mark', branch.current ? '✓' : '⑂'), element('span', 'branch-name', branch.name));
        button.addEventListener('click', () => send({ type: 'selectRef', ref: branch.ref }));
        list.append(button);
      }
    }
    controls();
  }
  function selectCommit(commit) {
    selectedHash = commit.hash;
    detail = undefined;
    renderLog();
    byId('commit-detail').replaceChildren(element('div', 'muted', '正在读取提交详情…'));
    byId('history-files').replaceChildren(element('div', 'empty', '正在读取提交文件…'));
    byId('history-files-count').textContent = '';
    send({ type: 'selectCommit', hash: commit.hash });
  }
  function graphSvg(graph, width) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('class', 'commit-graph');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', '32');
    svg.setAttribute('viewBox', `0 0 ${width} 32`);
    svg.setAttribute('aria-hidden', 'true');
    const colors = ['#58a6ff', '#d2a8ff', '#73c991', '#e3b341', '#f778ba', '#56d4dd', '#ff9b5e', '#b2c9ff'];
    const x = lane => 10 + lane * 18;
    for (const edge of graph.edges) {
      const line = document.createElementNS(namespace, 'path');
      const from = x(edge.from), to = x(edge.to), middle = (edge.start + edge.end) / 2;
      line.setAttribute('d', from === to ? `M ${from} ${edge.start} V ${edge.end}`
        : `M ${from} ${edge.start} C ${from} ${middle}, ${to} ${middle}, ${to} ${edge.end}`);
      line.setAttribute('stroke', colors[edge.color % colors.length]);
      line.setAttribute('stroke-width', '2');
      line.setAttribute('fill', 'none');
      line.setAttribute('data-parent', edge.target);
      if (edge.continuation) { line.setAttribute('stroke-dasharray', '3 2'); }
      svg.append(line);
    }
    const node = document.createElementNS(namespace, 'circle');
    node.setAttribute('cx', String(x(graph.lane))); node.setAttribute('cy', '16');
    node.setAttribute('r', (graph.commit.parents || []).length > 1 ? '4.5' : '3.5');
    node.setAttribute('fill', colors[graph.color % colors.length]);
    node.setAttribute('class', 'commit-node'); node.setAttribute('data-hash', graph.commit.hash);
    svg.append(node);
    return svg;
  }
  function renderLog() {
    const list = byId('commit-list');
    const scrollTop = list.scrollTop;
    const scrollLeft = list.scrollLeft;
    list.replaceChildren();
    const query = byId('log-search').value.trim().toLocaleLowerCase();
    const allCommits = state?.commits || [];
    const matching = allCommits.filter(commit => `${commit.message} ${commit.author} ${commit.hash}`.toLocaleLowerCase().includes(query));
    const graph = globalThis.GitControlGraph.buildGraph(allCommits, matching.map(commit => commit.hash));
    document.querySelector('.history').style.setProperty('--graph-width', `${graph.width}px`);
    for (const graphRow of graph.rows) {
      const commit = graphRow.commit;
      const row = element('button', `commit-row ${selectedHash === commit.hash ? 'active' : ''}`);
      row.type = 'button'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selectedHash === commit.hash));
      row.dataset.hash = commit.hash; row.title = commit.message;
      const subject = element('span', 'commit-subject');
      subject.append(element('span', 'commit-subject-text', commit.message.split('\n')[0]));
      for (const branch of (state?.branches || []).filter(branch => branch.commit === commit.hash)) {
        subject.append(element('span', `branch-label ${branch.remote ? 'remote-label' : ''}`, `${branch.current ? 'HEAD → ' : ''}${branch.name}`));
      }
      row.append(graphSvg(graphRow, graph.width), subject, element('span', '', commit.author), element('span', 'muted', date(commit.date)), element('span', 'hash', commit.hash.slice(0, 8)));
      row.addEventListener('click', () => selectCommit(commit));
      list.append(row);
    }
    if (!graph.rows.length) { list.append(element('div', 'empty', query ? '没有匹配的已加载提交。' : '暂无提交记录。')); }
    list.scrollTop = scrollTop;
    list.scrollLeft = scrollLeft;
    byId('log-heading').scrollLeft = scrollLeft;
    byId('history-ref').textContent = state?.branches.find(branch => branch.ref === state.selectedRef)?.name || '全部分支';
    byId('log-count').textContent = `${allCommits.length} 条已加载 · ${graph.rows.length} 条匹配${query ? ' · 连线跨过已隐藏的提交' : ''}`;
    byId('more').hidden = !state?.hasMore;
    controls();
  }
  function fileRow(file) {
    const row = element('button', 'file-row');
    row.type = 'button'; row.title = `双击查看 Diff\n${file.path}`;
    const slash = file.path.lastIndexOf('/');
    const statusClass = `status-${file.status === '?' ? 'unversioned' : file.status}`;
    row.append(element('span', `file-name ${statusClass}`, file.path.slice(slash + 1)), element('span', `file-status ${statusClass}`, file.status));
    const hash = detail.hash;
    const open = () => send({ type: 'diffCommit', hash, file: file.id });
    row.addEventListener('dblclick', open);
    row.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); open(); } });
    return row;
  }
  function renderFileTree(files) {
    if (fileTreeCommit !== detail.hash) {
      directoryExpansion.clear();
      fileTreeCommit = detail.hash;
    }
    const commitHash = detail.hash;
    const root = { directories: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let directory = root;
      for (const name of parts.slice(0, -1)) {
        if (!directory.directories.has(name)) {
          directory.directories.set(name, { directories: new Map(), files: [] });
        }
        directory = directory.directories.get(name);
      }
      directory.files.push(file);
    }
    function render(directory, prefix = '', depth = 0) {
      const list = element('ul', depth === 0 ? 'history-file-tree' : 'directory-children');
      for (const [name, child] of [...directory.directories].sort(([a], [b]) => a.localeCompare(b))) {
        const names = [name];
        let contents = child;
        // Compact directories that contain only another directory, retaining
        // every path segment in the label (for example src/main/).
        while (contents.files.length === 0 && contents.directories.size === 1) {
          const [nextName, next] = contents.directories.entries().next().value;
          names.push(nextName);
          contents = next;
        }
        const label = `${names.join('/')}/`;
        const path = `${prefix}${label}`;
        const item = element('li');
        const folder = element('details', 'file-directory');
        folder.dataset.path = path;
        folder.open = directoryExpansion.get(path) ?? true;
        const summary = element('summary', 'directory-row');
        summary.title = path;
        summary.append(element('span', 'directory-name', label));
        folder.addEventListener('toggle', () => {
          if (folder.isConnected && fileTreeCommit === commitHash) { directoryExpansion.set(path, folder.open); }
        });
        folder.append(summary, render(contents, path, depth + 1));
        item.append(folder);
        list.append(item);
      }
      for (const file of [...directory.files].sort((a, b) => a.path.localeCompare(b.path))) {
        const item = element('li');
        item.append(fileRow(file));
        list.append(item);
      }
      return list;
    }
    return render(root);
  }
  function renderDetail() {
    const box = byId('commit-detail'), files = byId('history-files');
    if (detail?.hash === fileTreeCommit) {
      files.querySelectorAll('.file-directory').forEach(folder => directoryExpansion.set(folder.dataset.path, folder.open));
    }
    box.replaceChildren(); files.replaceChildren();
    byId('history-files-count').textContent = detail ? `${detail.files.length} 个文件` : '';
    if (!detail) {
      files.append(element('div', 'empty', '选择一条提交查看修改文件。'));
      box.append(element('div', 'muted', '选择一条提交查看提交信息。'));
      return;
    }
    box.append(element('h3', 'detail-title', detail.message.split('\n')[0]), element('p', 'metadata', `${detail.author || '未知作者'} ${detail.email ? `<${detail.email}>` : ''}`), element('p', 'metadata', date(detail.date)), element('p', 'metadata hash', detail.hash), element('pre', 'commit-message', detail.message));
    box.append(element('div', 'muted', `${detail.files.length} 个文件 · ${detail.parents.length > 1 ? '与第一个父提交比较' : '双击文件查看差异'}`));
    if (detail.files.length) { files.append(renderFileTree(detail.files)); }
    if (!detail.files.length) { files.append(element('div', 'empty', '此提交没有文件差异。')); }
    controls();
  }

  byId('repository').addEventListener('change', () => {
    selectedHash = ''; detail = undefined;
    send({ type: 'selectRepository', repository: byId('repository').value });
  });
  byId('refresh').addEventListener('click', () => send({ type: 'refresh' }));
  byId('open-commit').addEventListener('click', () => send({ type: 'openCommit' }));
  byId('checkout').addEventListener('click', () => send({ type: 'checkout', ref: state.selectedRef }));
  byId('more').addEventListener('click', () => send({ type: 'more' }));
  byId('branch-search').addEventListener('input', renderBranches);
  byId('log-search').addEventListener('input', renderLog);
  byId('commit-list').addEventListener('scroll', () => { byId('log-heading').scrollLeft = byId('commit-list').scrollLeft; });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'loading') { loading = true; feedback('正在读取仓库…'); controls(); }
    if (message.type === 'error') { loading = false; feedback(message.message, true); controls(); }
    if (message.type === 'busy') { busy = message.busy; controls(); }
    if (message.type === 'state') {
      const changed = repository !== message.repository;
      repository = message.repository; state = message.state; detail = message.detail;
      busy = message.busy; loading = false;
      if (changed || !state?.commits.some(commit => commit.hash === selectedHash)) { selectedHash = detail?.hash || ''; }
      byId('repository').replaceChildren(...message.repositories.map(repo => {
        const option = element('option', '', repo.name); option.value = repo.id; return option;
      }));
      byId('repository').value = repository;
      byId('head').textContent = state ? `⑂ ${state.head}${state.upstream ? ` · ${state.upstream} ↑${state.ahead ?? '—'} ↓${state.behind ?? '—'}` : ''}` : '';
      feedback(message.message || '双击文件查看差异 · 选择提交查看详情');
      renderBranches(); renderLog(); renderDetail(); controls();
    }
    if (message.type === 'detail' && message.detail.hash === selectedHash) {
      detail = message.detail; renderDetail();
    }
  });
  initializeSplitters();
  controls();
  send({ type: 'ready' });
})();
