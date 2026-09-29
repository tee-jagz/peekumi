const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const labels = { added: '+ Added', changed: '~ Modified', removed: '− Removed', unchanged: '· Unchanged' };
let metadata, comparison, scope = '', selectedSymbol = null, sourceData = null, sourceView = 'diff', loadId = 0, sourceId = 0;
const byPath = new Map();
async function api(route, options = {}) {
  const response = await fetch(route, options); const result = await response.json();
  if (response.status === 401) { $('#workspace').hidden = true; $('#connect').hidden = false; }
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function params() { return new URLSearchParams({ base: comparison.base, head: comparison.head }); }
async function connect(token) { await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); await boot(); }
$('#login').addEventListener('submit', async event => { event.preventDefault(); try { await connect($('#token').value.trim()); $('#token').value = ''; } catch (error) { $('#login-error').textContent = error.message; } });
async function boot() {
  $('#loading').hidden = false;
  try {
    metadata = await api('/api/repo');
    $('#connect').hidden = true; $('#workspace').hidden = false;
    $('#repo-name').textContent = metadata.name; $('#branch').textContent = `⑂ ${metadata.branch}`; document.title = `${metadata.name} · Repo Strata`;
    const oldBase = $('#base').value, oldHead = $('#head').value;
    for (const [selector, value] of [['#base', oldBase || metadata.initialBase], ['#head', oldHead || metadata.initialHead]]) {
      const select = $(selector); select.replaceChildren();
      for (const commit of metadata.commits) { const option = el('option', '', `${commit.short} · ${commit.subject}`); option.value = commit.sha; select.append(option); }
      if (![...select.options].some(option => option.value === value)) { const option = el('option', '', value.slice(0, 8)); option.value = value; select.append(option); }
      select.value = value;
    }
    await loadComparison();
  } catch (error) { if ($('#connect').hidden) { $('#workspace').hidden = false; notice(error.message); } }
  finally { $('#loading').hidden = true; }
}
async function loadComparison() {
  const id = ++loadId; ++sourceId; notice('Reading Git snapshots and building the map…');
  $('#source-panel').hidden = true; $('#refresh').disabled = true;
  try {
    const query = new URLSearchParams({ base: $('#base').value, head: $('#head').value });
    const data = await api('/api/compare?' + query);
    if (id !== loadId) return;
    comparison = data; byPath.clear(); for (const file of data.files) byPath.set(file.path, file);
    if (scope && !data.files.some(file => file.path === scope || file.path.startsWith(scope + '/'))) scope = '';
    selectedSymbol = null; sourceData = null; notice(''); render();
    if (byPath.has(scope)) await loadSource();
  } catch (error) { if (id === loadId) notice(error.message); }
  finally { if (id === loadId) $('#refresh').disabled = false; }
}
function within(file) { return !scope || file.path === scope || file.path.startsWith(scope + '/'); }
function navigate(next, { scroll = false } = {}) {
  if (!comparison) return;
  scope = next; selectedSymbol = null; sourceData = null; ++sourceId;
  $('#search').value = ''; $('#source-panel').hidden = true; render();
  if (byPath.has(scope)) loadSource();
  if (scroll) $('.toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function breadcrumb() {
  const nav = $('#breadcrumbs'); nav.replaceChildren();
  const root = el('button', 'crumb', metadata.name); root.onclick = () => navigate(''); nav.append(root);
  let current = '';
  for (const part of scope.split('/').filter(Boolean)) { current = current ? current + '/' + part : part; const target = current;
    nav.append(el('span', 'crumb-divider', '/')); const button = el('button', 'crumb', part); button.onclick = () => navigate(target); nav.append(button);
  }
}
function nodesForScope() {
  const search = $('#search').value.toLowerCase().trim();
  if (search) return comparison.files.filter(file => file.path.toLowerCase().includes(search)).map(file => ({ ...file, name: file.path, kind: 'file' }));
  const file = byPath.get(scope);
  if (file) return file.symbols.map(symbol => ({ ...symbol, kind: symbol.kind, symbol: true, path: scope + '::' + symbol.name }));
  const nodes = new Map();
  for (const file of comparison.files.filter(within)) {
    const relative = scope ? file.path.slice(scope.length + 1) : file.path, [name, ...rest] = relative.split('/');
    const key = scope ? scope + '/' + name : name;
    if (!rest.length) { nodes.set(key, { ...file, name, kind: 'file' }); continue; }
    if (!nodes.has(key)) nodes.set(key, { path: key, name, kind: 'folder', files: [], status: 'unchanged' });
    nodes.get(key).files.push(file);
  }
  for (const node of nodes.values()) if (node.kind === 'folder') {
    const states = new Set(node.files.map(file => file.status));
    node.status = states.size === 1 ? [...states][0] : states.size > 1 ? 'changed' : 'unchanged';
  }
  return [...nodes.values()].sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name));
}
function renderNode(node) {
  const button = el('button', 'node'); button.dataset.status = node.status; button.dataset.path = node.path;
  button.setAttribute('aria-label', `${node.name}, ${node.kind}, ${labels[node.status].slice(2)}`);
  const top = el('div', 'node-top'); top.append(el('span', 'node-kind', (node.kind === 'folder' ? '▱ ' : node.symbol ? 'ƒ ' : '≡ ') + node.kind), el('span', 'status-label ' + node.status, labels[node.status]));
  button.append(top, el('div', 'node-name', node.name));
  let detail;
  if (node.kind === 'folder') {
    const changed = node.files.filter(f => f.status !== 'unchanged').length;
    detail = `${node.files.length} files · ${changed} changed`;
    const names = [...new Set(node.files.map(f => f.path.slice(node.path.length + 1).split('/')[0]))];
    button.append(el('div', 'node-peek', names.slice(0, 3).join(' / ') + (names.length > 3 ? ` / +${names.length - 3}` : '')));
  } else if (node.symbol) detail = `Lines ${node.start}–${node.end}`;
  else detail = `${node.symbols.length} symbols · ${node.analysis}`;
  const bottom = el('div', 'node-bottom'); bottom.append(el('span', 'node-meta', detail), el('span', 'node-arrow', '↗')); button.append(bottom);
  button.onclick = () => {
    if (node.symbol) { selectedSymbol = node; sourceView = node.status === 'removed' ? 'before' : 'after'; renderSource(); $('#source-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else navigate(node.path);
  };
  return button;
}
function render() {
  if (!comparison) return;
  breadcrumb(); const file = byPath.get(scope), search = $('#search').value.trim();
  $('#scope-kind').textContent = search ? 'SEARCH RESULTS' : file ? 'INSIDE THE FILE' : scope ? 'COMPONENT MAP' : 'REPOSITORY MAP';
  $('#scope-title').textContent = search ? `Files matching “${search}”` : scope.split('/').at(-1) || 'Overview';
  $('#scope-description').textContent = file ? `${file.analysis}. Select a symbol to inspect its source, or read the complete file below.` : 'Open a component to explore its structure. Colours show changes between the selected revisions.';
  let nodes = nodesForScope(); if ($('#changed-only').checked) nodes = nodes.filter(node => node.status !== 'unchanged');
  $('#map').replaceChildren(...nodes.map(renderNode));
  if (!nodes.length) $('#map').append(el('div', 'empty', file ? 'No symbols in this view. The complete file and its diff are below, including changes outside functions.' : 'No items match this view. Try clearing the filter or choosing a different comparison.'));
  $('#map-footer').textContent = `${nodes.length} ${file ? 'symbols' : 'items'} in view · ${file ? 'File diffs include changes outside symbols' : 'Tap to explore · Actual repository structure'}`;
  renderChanges(); renderConnections();
  $('#revision-caption').textContent = `${comparison.base.slice(0, 8)} → ${comparison.head.slice(0, 8)}`;
}
function renderChanges() {
  const files = comparison.files.filter(within), changed = files.filter(file => file.status !== 'unchanged');
  $('#change-total').textContent = changed.length;
  $('#stats').replaceChildren(...['added', 'changed', 'removed'].map(status => { const box = el('div', 'stat ' + status); box.append(el('strong', '', files.filter(file => file.status === status).length), el('span', '', { added: 'Added', changed: 'Modified', removed: 'Removed' }[status])); return box; }));
  const list = $('#changes'); list.replaceChildren();
  for (const file of changed) {
    const button = el('button', 'change-row'); button.append(el('span', 'change-marker ' + file.status, labels[file.status][0]));
    const text = el('span', 'change-text'); text.append(el('span', 'change-name', file.path.split('/').at(-1)), el('span', 'change-path', file.path)); button.append(text);
    button.onclick = () => navigate(file.path, { scroll: true }); list.append(button);
  }
  if (!changed.length) list.append(el('div', 'empty', 'No changed files in this scope. Explore the surrounding structure or choose another comparison.'));
}
function renderConnections() {
  const file = byPath.get(scope), edges = new Map();
  function child(filePath) {
    if (scope && !filePath.startsWith(scope + '/')) return filePath;
    const relative = scope ? filePath.slice(scope.length + 1) : filePath;
    return (scope ? scope + '/' : '') + relative.split('/')[0];
  }
  for (const entry of comparison.files) {
    for (const phase of ['beforeDeps', 'deps']) for (const target of entry[phase]) {
      if (file ? entry.path !== scope && target !== scope : !within(entry) && !(scope && target.startsWith(scope + '/'))) continue;
      const from = file ? entry.path : child(entry.path), to = file ? target : child(target);
      if (from === to) continue;
      const key = from + '\0' + to;
      if (!edges.has(key)) edges.set(key, { from, to, before: 0, after: 0 });
      edges.get(key)[phase === 'deps' ? 'after' : 'before']++;
    }
  }
  const rows = [...edges.values()].sort((a, b) => Number(Boolean(a.before && a.after)) - Number(Boolean(b.before && b.after)) || a.from.localeCompare(b.from));
  $('#connections').hidden = !rows.length && !file; const list = $('#connection-list'); list.replaceChildren();
  for (const edge of rows.slice(0, 30)) {
    const status = !edge.before ? 'added' : !edge.after ? 'removed' : edge.before !== edge.after ? 'changed' : 'unchanged';
    const row = el('div', 'edge ' + status);
    for (const [index, target] of [edge.from, edge.to].entries()) {
      if (index) row.append(el('small', '', `${labels[status][0]} →`));
      const label = scope && target.startsWith(scope + '/') ? target.slice(scope.length + 1) : target;
      const button = el('button', '', label); button.title = target; button.onclick = () => navigate(target); row.append(button);
    }
    row.title = `${edge.after} imports now; ${edge.before} before`; list.append(row);
  }
  if (rows.length > 30) list.append(el('p', 'scope-description', `${rows.length - 30} more connections. Drill into a component to narrow the view.`));
  if (file) {
    const unresolved = file.imports.filter(item => !item.resolved?.length);
    if (unresolved.length) list.append(el('p', 'scope-description', `${unresolved.length} external or unresolved imports: ${[...new Set(unresolved.map(i => i.specifier || '(relative)'))].join(', ')}`));
    if (!rows.length && !unresolved.length) list.append(el('p', 'scope-description', 'No static internal imports resolved for this file.'));
  }
}
async function loadSource() {
  const id = ++sourceId, current = scope; $('#source-panel').hidden = false; $('#source-title').textContent = scope; $('#source-code').replaceChildren(el('div', 'empty', 'Loading source…'));
  try {
    const query = params(); query.set('path', scope); const data = await api('/api/source?' + query);
    if (id !== sourceId || scope !== current) return;
    sourceData = data; sourceView = selectedSymbol ? selectedSymbol.status === 'removed' ? 'before' : 'after' : 'diff'; renderSource();
  } catch (error) { if (id === sourceId) $('#source-code').replaceChildren(el('div', 'empty', error.message)); }
}
function renderSource() {
  if (!sourceData) return;
  $('#source-panel').hidden = false; $('#source-title').textContent = selectedSymbol ? `${scope} → ${selectedSymbol.name}` : scope;
  $('#source-meta').textContent = selectedSymbol ? `Selected ${selectedSymbol.kind} · lines ${selectedSymbol.start}–${selectedSymbol.end}. Showing complete file context.` : `${sourceData.analysis} · Full file diff includes changes outside extracted symbols.`;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === sourceView)));
  const code = $('#source-code'); code.replaceChildren();
  const value = sourceView === 'diff' ? sourceData.patch : sourceData[sourceView];
  if (!value) { code.append(el('div', 'empty', value === null ? 'This revision has no readable source for this file.' : sourceView === 'diff' ? 'No text diff available. Choose Before or After to read the source.' : 'This file is empty.')); return; }
  const fragment = document.createDocumentFragment();
  const selectedRange = sourceView === 'before' ? selectedSymbol?.before : selectedSymbol;
  value.split('\n').forEach((line, index) => {
    const type = sourceView === 'diff' ? line.startsWith('+') && !line.startsWith('+++') ? 'addition' : line.startsWith('-') && !line.startsWith('---') ? 'deletion' : line.startsWith('@@') ? 'hunk' : '' : selectedRange && index + 1 >= selectedRange.start && index + 1 <= selectedRange.end ? 'highlight' : '';
    const row = el('div', 'code-line ' + type); row.append(el('span', 'line-number', sourceView === 'diff' ? '' : index + 1), el('span', '', line)); fragment.append(row);
  });
  code.append(fragment); const highlight = code.querySelector('.highlight'); code.scrollTop = highlight ? highlight.offsetTop - code.offsetTop - 40 : 0;
}
$('#base').onchange = loadComparison; $('#head').onchange = loadComparison;
$('#refresh').onclick = async () => { $('#head').value = ''; await boot(); };
$('#search').oninput = render; $('#changed-only').onchange = render;
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => { sourceView = button.dataset.view; renderSource(); }; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && scope && !['INPUT', 'SELECT'].includes(event.target.tagName)) navigate(scope.split('/').slice(0, -1).join('/')); });
const token = new URLSearchParams(location.hash.slice(1)).get('token');
if (token) { history.replaceState(null, '', location.pathname); connect(token).catch(error => { $('#loading').hidden = true; $('#connect').hidden = false; $('#login-error').textContent = error.message; }); }
else boot();
