(() => {
  // Lanes represent pending parent commits at the boundary between two rows.
  // Every path meets the next row at the same lane and colour.
  function buildGraph(commits, visibleHashes) {
    const byHash = new Map(commits.map(commit => [commit.hash, commit]));
    const order = new Map(commits.map((commit, index) => [commit.hash, index]));
    const children = new Map(commits.map(commit => [commit.hash, 0]));
    for (const commit of commits) {
      for (const parent of new Set(commit.parents || [])) {
        if (children.has(parent)) { children.set(parent, children.get(parent) + 1); }
      }
    }
    const ready = commits.filter(commit => children.get(commit.hash) === 0);
    const sorted = [];
    while (ready.length) {
      ready.sort((a, b) => order.get(a.hash) - order.get(b.hash));
      const commit = ready.shift();
      sorted.push(commit);
      for (const parent of new Set(commit.parents || [])) {
        if (children.has(parent)) {
          children.set(parent, children.get(parent) - 1);
          if (children.get(parent) === 0) { ready.push(byHash.get(parent)); }
        }
      }
    }
    const visible = new Set(visibleHashes ?? commits.map(commit => commit.hash));
    const nearest = new Map();
    function visibleParents(hash) {
      if (visible.has(hash) || !byHash.has(hash)) { return [hash]; }
      if (!nearest.has(hash)) {
        nearest.set(hash, []);
        nearest.set(hash, [...new Set((byHash.get(hash).parents || []).flatMap(visibleParents))]);
      }
      return nearest.get(hash);
    }
    let lanes = [];
    let nextColor = 0;
    let columns = 1;
    const rows = [];
    for (const commit of sorted.filter(commit => visible.has(commit.hash))) {
      const before = lanes;
      const existing = before.findIndex(lane => lane.hash === commit.hash);
      const lane = existing < 0 ? before.length : existing;
      const color = existing < 0 ? nextColor++ : before[existing].color;
      const parents = [...new Set((commit.parents || []).flatMap(visibleParents))];
      const after = before.filter((_, index) => index !== existing);
      parents.forEach((hash, index) => {
        if (!after.some(entry => entry.hash === hash)) {
          after.splice(Math.min(lane + index, after.length), 0, { hash, color: index === 0 ? color : nextColor++ });
        }
      });
      const edges = [];
      before.forEach((entry, from) => {
        if (from !== existing) {
          edges.push({ from, to: after.findIndex(lane => lane.hash === entry.hash), start: 0, end: 32,
            color: entry.color, target: entry.hash, continuation: !visible.has(entry.hash) });
        }
      });
      if (existing >= 0) {
        edges.push({ from: lane, to: lane, start: 0, end: 16, color, target: commit.hash, continuation: false });
      }
      for (const parent of parents) {
        const to = after.findIndex(entry => entry.hash === parent);
        edges.push({ from: lane, to, start: 16, end: 32, color: after[to].color, target: parent, continuation: !visible.has(parent) });
      }
      columns = Math.max(columns, before.length, after.length, lane + 1);
      rows.push({ commit, lane, color, edges });
      lanes = after;
    }
    return { rows, width: columns * 18 + 16 };
  }
  globalThis.GitControlGraph = Object.freeze({ buildGraph });
})();
