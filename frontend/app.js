/** @module Browser controller for repository navigation, committed comparisons and the review panel. */
import { createAsk } from "./ask.js";
import { createWorkflow } from "./workflow.js";
import { mountCanvas } from "./canvas.js";
import {
  rootScope,
  expandRelationships,
  leaf,
  parent,
  inScope,
  children,
  connections,
  visibleOnSide,
  patchForSymbol,
} from "./model.js";
const $ = (selector) => document.querySelector(selector);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (className, text, action) => {
  const node = element("button", className, text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const labels = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  unchanged: "Unchanged",
};
const symbols = { added: "+", changed: "Δ", removed: "−", unchanged: "·" };
const tones = {
  added: "var(--add)",
  changed: "var(--mod)",
  removed: "var(--del)",
  unchanged: "var(--faint)",
};
let primaryTab = "ask";
let changesOnly = false;
let relationshipKind = "all",
  violationsOnly = false;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let metadata,
  comparison,
  scope = rootScope(),
  selected = null,
  mode = "diff",
  lens = "changes",
  before = false,
  tab = "ask";
let baseRef,
  headRef,
  diffBase,
  nodes = [],
  edges = [],
  sourceData,
  sourceView = "diff",
  search = "",
  busy = false,
  loadId = 0,
  sourceId = 0;
const comparisons = new Map(),
  sources = new Map();
const nodeScope = (node) => ({
  kind: node.kind === "stub" ? node.targetKind : node.kind,
  path: node.path,
});
const commit = (sha) =>
  metadata?.commits.find((c) => c.sha === sha) || {
    sha,
    short: sha?.slice(0, 8),
    subject: "Selected revision",
  };
/** Captures the selected declaration or dependency at its displayed immutable revision. */
function reviewContext() {
  const n = selected;
  const useBefore =
    (tab === "source" && sourceView !== "diff"
      ? sourceView === "before"
      : before) || n?.status === "removed";
  let anchor = {
    kind:
      scope.kind === "repo" || scope.kind === "rootfiles" ? "repo" : scope.kind,
    path: scope.path || "",
  };
  if (n?.kind === "symbol")
    anchor = {
      kind: "symbol",
      path: scope.path,
      symbol: n.name,
      line: n.start,
    };
  else if (n?.kind === "edge") {
    const pair =
      n.pairs.get([...(useBefore ? n.before : n.after)][0]) ||
      [...n.pairs.values()][0];
    anchor = {
      kind: "edge",
      path: pair?.from || n.from.path,
      target: pair?.to || n.to.path,
      relationship: n.relationshipKind,
      label: n.name,
      sourceSymbol: pair?.fromSymbol || null,
      targetSymbol: pair?.toSymbol || null,
    };
  } else if (n && ["folder", "file"].includes(n.kind))
    anchor = { kind: n.kind, path: n.path };
  return { anchor, sha: useBefore ? baseRef : headRef };
}
const workflow = createWorkflow({
  api,
  context: reviewContext,
  notice: showNotice,
  showTab(value) {
    tab = value;
    renderPanel();
  },
  redraw() {
    if (comparison && ["comments", "runs"].includes(tab)) renderTab();
  },
  async inspect(base, head, anchor) {
    document.querySelector("#tabs").inert = true;
    try {
      mode = "diff";
      baseRef = base;
      diffBase = base;
      headRef = head;
      before = false;
      await loadComparison();
      if (anchor.path) {
        await navigate({
          kind: anchor.kind === "folder" ? "folder" : "file",
          path: anchor.path,
        });
        if (scope.kind === "file") await loadSource();
      } else await navigate(rootScope());
      if (anchor.symbol)
        selected = nodes.find((n) => n.name === anchor.symbol) || null;
      tab = anchor.path && anchor.kind !== "folder" ? "source" : "changes";
      sourceView = base === head ? "after" : "diff";
      render();
    } finally {
      document.querySelector("#tabs").inert = false;
    }
  },
});
const ask = createAsk({
  api,
  context() {
    return {
      ...reviewContext(),
      base: baseRef,
      head: headRef,
      side: before ? "before" : "after",
    };
  },
  notice: showNotice,
  redraw() {
    if (tab === "ask") renderTab();
  },
  async makeDraft(draft) {
    await api("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    await workflow.refresh(false);
    tab = "comments";
    renderPanel();
  },
});
/** Updates the status banner and distinguishes ordinary progress from errors. */
function showNotice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = !message;
}
/** Fetches an authenticated same-origin JSON API response. Rejects failed HTTP responses with the server error message. */
async function api(route, options = {}) {
  const response = await fetch(route, options),
    result = await response.json();
  if (response.status === 401) {
    $("#connect").hidden = false;
    $("#workspace").inert = true;
  }
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
/** Exchanges a private access token for a session cookie and initializes the viewer on success. */
async function pair(token) {
  await api("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await boot();
}
$("#login").onsubmit = (event) => {
  event.preventDefault();
  pair($("#token").value.trim()).catch(
    (error) => ($("#login-error").textContent = error.message),
  );
};
/** Loads repository identity and initial revisions, then renders the comparison. A refresh follows the latest configured head. */
async function boot(refresh = false) {
  try {
    metadata = await api("/api/repo");
    $("#connect").hidden = true;
    $("#workspace").inert = false;
    $("#repo-name").textContent = metadata.name;
    document.title = metadata.name + " · Repo strata";
    $("#repo-sub").textContent =
      `${metadata.branch} · ${metadata.commits.length} recent commits`;
    headRef = refresh ? metadata.initialHead : headRef || metadata.initialHead;
    diffBase = diffBase || metadata.initialBase;
    baseRef = mode === "time" ? parentRevision(headRef) : diffBase;
    await loadComparison();
    workflow.refresh(false).catch((error) => showNotice(error.message, true));
  } catch (error) {
    showNotice(error.message, true);
  }
}
/** Finds a commit's first parent in the loaded history for the Time comparison. */
function parentRevision(sha) {
  const c = commit(sha);
  return (
    c.parent ||
    metadata.commits[metadata.commits.findIndex((c) => c.sha === sha) + 1]
      ?.sha ||
    sha
  );
}
/** Fetches a compact comparison and revision-specific directory descriptions, reusing the six-entry browser cache. Stale requests cannot replace the active view. */
async function loadComparison() {
  const id = ++loadId;
  ++sourceId;
  busy = true;
  selected = null;
  sourceData = null;
  $("#refresh").disabled = true;
  showNotice("Loading this comparison…");
  if (!comparison)
    $("#deck").replaceChildren(
      element("div", "loading-message", "Reading repository structure…"),
    );
  try {
    const key = baseRef + ":" + headRef;
    let data = comparisons.get(key);
    if (!data) {
      data = await api(
        "/api/compare?" +
          new URLSearchParams({
            base: baseRef,
            head: headRef,
            view: "overview",
          }),
      );
      data.directoryMetadata = await api(
        "/api/directories?" +
          new URLSearchParams({ base: data.base, head: data.head }),
      );
      data.relationshipData = expandRelationships(
        await api(
          "/api/relationships?" +
            new URLSearchParams({
              base: data.base,
              head: data.head,
              view: "overview",
            }),
        ),
      );
      comparisons.set(key, data);
      if (comparisons.size > 6)
        comparisons.delete(comparisons.keys().next().value);
    }
    if (id !== loadId) return;
    comparison = data;
    if (scope.path && !data.files.some((file) => inScope(file, scope)))
      scope = rootScope();
    busy = false;
    showNotice("");
    render();
    if (scope.kind === "file") loadSource();
  } catch (error) {
    if (id === loadId) {
      busy = false;
      showNotice(error.message, true);
    }
  } finally {
    if (id === loadId) $("#refresh").disabled = false;
  }
}
/** Rebuilds visible hierarchy nodes and import relationships from the current comparison and scope. */
function refreshModel() {
  nodes = children(comparison.files, scope);
  edges = connections(
    comparison.files,
    scope,
    scope.kind === "file" && sourceData?.relationshipData
      ? sourceData.relationshipData.relationships
      : comparison.relationshipData?.relationships,
  ).filter(
    (e) =>
      (relationshipKind === "all" || e.relationshipKind === relationshipKind) &&
      (!violationsOnly ||
        (before ? e.violationsBefore : e.violationsAfter).length),
  );
}
/** Refreshes the hierarchy model, controls, commit deck and review panel from the current state. */
function render() {
  if (!comparison) return;
  refreshModel();
  renderControls();
  renderDeck();
  renderPanel();
}
/** Synchronizes view, colour-lens and Before/After controls with the active state. */
function renderControls() {
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode)),
    );
  document
    .querySelectorAll("[data-lens]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.lens === lens)),
    );
  document
    .querySelectorAll("[data-ba]")
    .forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String((b.dataset.ba === "before") === before),
      ),
    );
  $("#baSeg").hidden = mode !== "diff";
}
/** Builds clickable ancestors for the current repository, directory or file scope. */
function breadcrumbs() {
  const nav = element("nav", "crumbs");
  nav.setAttribute("aria-label", "Level");
  if (scope.kind !== "repo") {
    const up = button("back", "‹", goUp);
    up.setAttribute("aria-label", "Up one level");
    nav.append(up);
  }
  const parts = [{ label: metadata.name, scope: rootScope() }];
  if (scope.kind === "rootfiles")
    parts.push({ label: "Repository files", scope });
  else {
    let path = "";
    for (const part of scope.path.split("/").filter(Boolean)) {
      path = path ? path + "/" + part : part;
      parts.push({
        label: part,
        scope: { kind: path === scope.path ? scope.kind : "folder", path },
      });
    }
  }
  // Keep the root and last two path segments in the compact header.
  const visible = parts.length > 3 ? [parts[0], ...parts.slice(-2)] : parts;
  visible.forEach((part, index) => {
    if (index) nav.append(element("span", "chev", "›"));
    const b = button("", part.label, () => navigate(part.scope));
    b.title = part.scope.path || metadata.name;
    if (index === visible.length - 1) b.setAttribute("aria-current", "page");
    nav.append(b);
  });
  return nav;
}
/** Recreates the Time or Diff commit sheets and renders the active map while preserving map-sheet scroll position. */
function renderDeck() {
  const deck = $("#deck"),
    oldScroll =
      deck.querySelector(".sheet:not(.peek) .sheet-body")?.scrollTop || 0;
  deck.replaceChildren();
  const focus = metadata.commits.findIndex((c) => c.sha === headRef);
  const peeks =
    mode === "time"
      ? metadata.commits
          .slice(focus + 1, focus + 4)
          .map((c) => ({ ...c, side: "history" }))
      : [
          {
            ...commit(before ? headRef : baseRef),
            side: before ? "after" : "before",
          },
        ];
  peeks
    .slice()
    .reverse()
    .forEach((c, index) => {
      const depth = peeks.length - index;
      const sheet = element("div", "sheet peek");
      sheet.dataset.sha = c.sha;
      sheet.style.transform = `translateY(${-12 * depth}px) scale(${1 - depth * 0.045})`;
      sheet.style.opacity = String(1 - depth * 0.18);
      sheet.style.zIndex = String(10 - depth);
      sheet.tabIndex = 0;
      sheet.setAttribute("role", "button");
      sheet.setAttribute("aria-label", "Show " + c.short);
      const h = element("div", "sheet-head");
      h.append(element("b", "", c.short), element("span", "", c.subject));
      sheet.append(h);
      sheet.onclick = () => {
        if (busy) return;
        if (mode === "time") chooseHead(c.sha);
        else {
          before = !before;
          selected = null;
          render();
        }
      };
      sheet.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          sheet.click();
        }
      };
      deck.append(sheet);
    });
  const sheet = element("div", "sheet");
  sheet.style.zIndex = "10";
  sheet.dataset.front = "true";
  const header = element("div", "sheet-head");
  header.append(
    breadcrumbs(),
    element(
      "span",
      "tag" + (before ? " base" : ""),
      (before ? "Base " : "") + commit(before ? baseRef : headRef).short,
    ),
  );
  const body = element("div", "sheet-body");
  sheet.append(header, body);
  deck.append(sheet);
  renderGraph(body);
  body.scrollTop = oldScroll;
}
/** Chooses a node colour from its Git status, or the neutral Structure accent. */
function tone(node) {
  return lens === "changes"
    ? tones[node.status] || "var(--faint)"
    : "var(--accent)";
}
/** Determines whether a node belongs on the selected revision side and colour lens. */
function visibleInSide(node) {
  return visibleOnSide(node, before, lens);
}
/** Finds relationships inside a card, including edges hidden by directory aggregation. */
function nodeRelations(node) {
  const records =
    (scope.kind === "file"
      ? sourceData?.relationshipData
      : comparison.relationshipData
    )?.relationships || [];
  const touches = (endpoint) =>
    node.kind === "symbol"
      ? endpoint.path === scope.path && endpoint.symbol === node.name
      : node.kind === "rootfiles"
        ? !endpoint.path.includes("/")
        : endpoint.path === node.path ||
          endpoint.path.startsWith(node.path + "/");
  return records.filter((r) =>
    [r.before, r.after]
      .filter(Boolean)
      .some((f) => touches(f.source) || f.targets.some(touches)),
  );
}
function nodeViolations(node) {
  return nodeRelations(node).flatMap((r) => {
    const fact = r[before ? "before" : "after"];
    if (!fact) return [];
    const source = fact.source;
    const owns =
      node.kind === "symbol"
        ? source.path === scope.path && source.symbol === node.name
        : node.kind === "rootfiles"
          ? !source.path.includes("/")
          : source.path === node.path ||
            source.path.startsWith(node.path + "/");
    return owns ? fact.violations : [];
  });
}
/** Lays out the current directory or symbol scope and its import neighbours inside the SVG viewport. */
function renderGraph(body) {
  const width = Math.max(240, body.clientWidth),
    available = Math.max(180, body.clientHeight - 38),
    root = scope.kind === "repo";
  const canvas = element("div", "graph-inner"),
    graph = element("div", "graph");
  body.replaceChildren(graph);
  graph.append(canvas);
  // Same 7.2-unit card geometry as the supplied mockup, capped for readable desktop cards.
  const graphWidth = Math.min(width, 760),
    k = graphWidth / 7.2;
  const positions = new Map();
  let y = 24;
  const relationshipChanges = new Set(
    edges
      .filter((e) => e.status !== "unchanged")
      .flatMap((e) => [e.from.key, e.to.key]),
  );
  const current = nodes.filter(
    (node) =>
      visibleInSide(node) &&
      (!changesOnly ||
        node.status !== "unchanged" ||
        relationshipChanges.has(node.key) ||
        nodeRelations(node).some((r) => r.status !== "unchanged")),
  );
  if (root) {
    const hint = element(
      "div",
      "row-lbl",
      `${current.length} components · drag or scroll to explore`,
    );
    hint.style.left = "12px";
    hint.style.top = "3px";
    canvas.append(hint);
  }
  const stubs = new Map();
  for (const edge of edges.filter(
    (edge) => !changesOnly || edge.status !== "unchanged",
  ))
    for (const endpoint of [edge.from, edge.to])
      if (endpoint.kind === "stub") stubs.set(endpoint.key, endpoint);
  const incoming = [...stubs.values()]
    .filter((node) => edges.some((e) => e.from.key === node.key))
    .slice(0, 4);
  const outgoing = [...stubs.values()]
    .filter((node) => !incoming.includes(node))
    .slice(0, 4);
  function stubRow(list, label) {
    if (!list.length) return;
    const lbl = element("div", "row-lbl", label);
    lbl.style.left = "12px";
    lbl.style.top = y + "px";
    canvas.append(lbl);
    y += 22;
    const cols = Math.min(list.length, graphWidth < 430 ? 2 : 4),
      w = (graphWidth - 32 - (cols - 1) * 9) / cols;
    list.forEach((node, index) =>
      positions.set(node.key, {
        node,
        x: 16 + (index % cols) * (w + 9),
        y: y + Math.floor(index / cols) * 46,
        w,
        h: 36,
      }),
    );
    y += Math.ceil(list.length / cols) * 46 + 20;
  }
  if (!root) stubRow(incoming, "Depended on by");
  const boundaryTop = y;
  if (scope.kind === "file") {
    positions.set("boundary", {
      node: {
        kind: "boundary",
        key: "boundary",
        name: leaf(scope.path),
        path: scope.path,
        status: comparison.files.find((f) => f.path === scope.path)?.status,
      },
      x: 12,
      y,
      w: graphWidth - 24,
      h: 60,
    });
    y += 38;
  }
  if (root) {
    const w = 5.9 * k,
      h = Math.max(100, Math.min(116, 1.5 * k)),
      gap = Math.max(16, 0.45 * k);
    current.forEach((node, index) =>
      positions.set(node.key, {
        node,
        x: (graphWidth - w) / 2 - 0.5 * k,
        y: y + index * (h + gap),
        w,
        h,
      }),
    );
    y += current.length * (h + gap);
  } else {
    const isFile = scope.kind === "file",
      cols = isFile
        ? current.length > 12
          ? graphWidth < 540
            ? 2
            : 3
          : 1
        : graphWidth < 540
          ? 2
          : 3;
    const w =
      isFile && cols === 1
        ? graphWidth - 74
        : (graphWidth - 42 - (cols - 1) * 12) / cols;
    const h = isFile ? 46 : 108,
      gap = isFile ? 10 : 28,
      left = isFile && cols === 1 ? 28 : 21;
    current.forEach((node, index) =>
      positions.set(node.key, {
        node,
        x: left + (index % cols) * (w + 12),
        y: y + Math.floor(index / cols) * (h + gap),
        w,
        h,
      }),
    );
    y += Math.max(1, Math.ceil(current.length / cols)) * (h + gap) + 10;
    if (scope.kind === "file") positions.get("boundary").h = y - boundaryTop;
  }
  if (!current.length) {
    const message = element(
      "div",
      "map-empty",
      scope.kind === "file" && !sourceData
        ? "Loading symbols…"
        : changesOnly
          ? "No changed symbols or items here. Open Source for file-level changes, or turn off Changes only."
          : scope.kind === "file"
            ? "No extracted symbols. Open Source to inspect the complete file."
            : "No items in this revision.",
    );
    message.style.position = "absolute";
    message.style.top = y + "px";
    canvas.append(message);
    y += 65;
  }
  if (!root) {
    y += 25;
    stubRow(outgoing, "Depends on");
  }
  if (stubs.size > incoming.length + outgoing.length) {
    const more = element(
      "div",
      "more-map",
      `${stubs.size - incoming.length - outgoing.length} more neighbours in Dependencies`,
    );
    more.style.top = y + "px";
    canvas.append(more);
    y += 25;
  }
  const height = Math.max(available, y + 8);
  canvas.style.width = graphWidth + "px";
  canvas.style.height = height + "px";
  const verticalOffset = root && y < available ? (available - y) / 2 : 0;
  for (const p of positions.values()) p.y += verticalOffset;
  drawEdges(canvas, positions, graphWidth, height, root);
  for (const p of positions.values()) canvas.append(graphNode(p));
  const controls = element("div", "canvas-controls");
  const filter = button("change-filter", "Changes only", () => {
    changesOnly = !changesOnly;
    if (changesOnly && selected?.status === "unchanged") selected = null;
    render();
  });
  filter.setAttribute("aria-pressed", String(changesOnly));
  controls.append(filter);
  mountCanvas(
    body,
    canvas,
    graphWidth,
    height,
    [baseRef, headRef, scope.kind, scope.path, changesOnly].join(":"),
    controls,
  );
}
/** Creates an accessible map card with status, preview metadata and select-then-open behavior. */
function graphNode({ node, x, y, w, h }) {
  const cls = [
    "node",
    node.kind === "stub"
      ? "stub"
      : node.kind === "boundary"
        ? "boundary"
        : node.kind === "symbol"
          ? "fn"
          : "",
    lens === "changes" ? "c-" + node.status : "",
    selected?.key === node.key ? "sel" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const card = button(cls, "", () => {
    if (busy) return;
    if (selected?.key === node.key) openNode(node);
    else selectNode(node);
  });
  card.dataset.key = node.key;
  card.dataset.kind = node.kind;
  card.dataset.path = node.path || "";
  card.dataset.status = node.status || "unchanged";
  card.dataset.relationshipChanged = String(
    nodeRelations(node).some((r) => r.status !== "unchanged"),
  );
  card.setAttribute(
    "aria-label",
    `${node.name}, ${node.kind}${node.status ? ", " + labels[node.status] : ""}`,
  );
  card.title = node.name;
  Object.assign(card.style, {
    left: x + "px",
    top: y + "px",
    width: w + "px",
    height: h + "px",
  });
  card.style.setProperty("--tone", tone(node));
  const top = element("div", "n-top");
  if (node.kind !== "stub") top.append(element("span", "dot"));
  top.append(
    element(
      "span",
      "n-name",
      node.name +
        (node.files
          ? ` (${node.files.length})`
          : node.kind === "symbol" &&
              ["function", "method"].includes(node.symbolKind)
            ? "()"
            : ""),
    ),
  );
  if (node.kind === "file")
    top.append(
      element("span", "n-meta", node.symbolCount ?? node.symbols?.length ?? 0),
    );
  const violations = nodeViolations(node);
  if (violations.length) {
    const badge = element("span", "rule-badge", "!");
    badge.title = violations.map((v) => v.message).join("; ");
    badge.setAttribute("aria-label", "Dependency rule violation");
    top.append(badge);
  }
  card.append(top);
  if (node.files) {
    const info = directoryInfo(node.path, node.status === "removed");
    if (info) {
      const description = element("p", "n-description", info.description);
      description.title = info.description;
      card.append(description);
    }
    const kids = element("div", "n-kids");
    const paths = [
      ...new Set(
        node.files.map((f) =>
          node.path ? f.path.slice(node.path.length + 1).split("/")[0] : f.path,
        ),
      ),
    ];
    for (const name of paths.slice(0, 3)) {
      const kid = element("span", "kid");
      const dot = element("i");
      dot.style.setProperty("--c", tone(node));
      kid.append(dot, document.createTextNode(name));
      kids.append(kid);
    }
    if (paths.length > 3)
      kids.append(element("span", "kid", `+${paths.length - 3}`));
    card.append(kids);
  } else if (
    node.kind === "file" &&
    (node.symbolCount ?? node.symbols?.length ?? 0)
  ) {
    const kids = element("div", "n-kids");
    for (const symbol of (node.symbols || node.symbolPreview || []).slice(
      0,
      22,
    )) {
      const bar = element("span", "bar");
      bar.style.setProperty(
        "--c",
        lens === "changes" ? tones[symbol.status] : "var(--accent)",
      );
      bar.title = symbol.name;
      kids.append(bar);
    }
    card.append(kids);
  }
  if (node.kind === "boundary") {
    card.tabIndex = -1;
    card.removeAttribute("aria-label");
  }
  return card;
}
/** Draws selectable static import connections between positioned cards; these are not runtime call edges. */
function drawEdges(canvas, positions, width, height, arcs) {
  const NS = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(NS, "svg");
  svg.classList.add("edges");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("aria-label", "Dependency connections");
  const defs = document.createElementNS(NS, "defs");
  for (const [status, color] of Object.entries({
    ...tones,
    structure: "var(--edge)",
    violation: "var(--del)",
  })) {
    const marker = document.createElementNS(NS, "marker");
    marker.id = "arrow-" + status;
    for (const [key, value] of Object.entries({
      viewBox: "0 0 10 10",
      refX: 8.5,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
    }))
      marker.setAttribute(key, value);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M1.5 1.5L8.5 5L1.5 8.5");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", color);
    p.setAttribute("stroke-width", "1.8");
    marker.append(p);
    defs.append(marker);
  }
  svg.append(defs);
  let drawable = edges.filter(
    (e) =>
      (!changesOnly || e.status !== "unchanged") &&
      positions.has(e.from.key) &&
      positions.has(e.to.key) &&
      (before ? e.before.size : lens === "structure" ? e.after.size : true),
  );
  if (drawable.length > 40 && selected)
    drawable = drawable.filter(
      (e) =>
        e.key === selected.key ||
        e.from.key === selected.key ||
        e.to.key === selected.key,
    );
  if (scope.kind === "file" && nodes.length > 12)
    drawable = drawable.filter(
      (e) =>
        e.relationshipKind !== "calls" ||
        [e.from.key, e.to.key].includes(selected?.key),
    );
  for (const [index, edge] of drawable.slice(0, 40).entries()) {
    const a = positions.get(edge.from.key),
      b = positions.get(edge.to.key);
    let d;
    if (arcs) {
      const x = a.x + a.w,
        x2 = b.x + b.w,
        y = a.y + a.h / 2,
        y2 = b.y + b.h / 2,
        curve = Math.min(
          width - 5,
          Math.max(x, x2) + 20 + Math.abs(y2 - y) * 0.13 + (index % 3) * 5,
        );
      d = `M${x},${y} C${curve},${y} ${curve},${y2} ${x2 + 2},${y2}`;
    } else if (Math.abs(a.y - b.y) < 5) {
      const right = b.x > a.x,
        x = right ? a.x + a.w : a.x,
        x2 = right ? b.x : b.x + b.w,
        y = a.y + a.h / 2,
        y2 = b.y + b.h / 2;
      d = `M${x},${y} C${(x + x2) / 2},${y} ${(x + x2) / 2},${y2} ${x2},${y2}`;
    } else {
      const down = b.y > a.y,
        x = a.x + a.w / 2,
        y = down ? a.y + a.h : a.y,
        x2 = b.x + b.w / 2,
        y2 = down ? b.y : b.y + b.h;
      d = `M${x},${y} C${x},${(y + y2) / 2} ${x2},${(y + y2) / 2} ${x2},${y2}`;
    }
    const violations = before ? edge.violationsBefore : edge.violationsAfter;
    const status = violations.length
      ? "violation"
      : lens === "changes"
        ? edge.status
        : "structure";
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute(
      "class",
      "e " +
        edge.relationshipKind +
        " " +
        (status === "unchanged" ? "quiet" : status) +
        (selected?.key === edge.key ? " sel hl" : ""),
    );
    path.setAttribute("marker-end", `url(#arrow-${status})`);
    svg.append(path);
    const hit = document.createElementNS(NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "hit");
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("role", "button");
    hit.setAttribute(
      "aria-label",
      edge.name +
        ", " +
        edge.relationshipKind +
        (violations.length ? ", rule violation" : ""),
    );
    hit.dataset.edge = edge.key;
    hit.onclick = () => selectNode(edge);
    hit.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectNode(edge);
      }
    };
    svg.append(hit);
  }
  canvas.append(svg);
}
/** Selects a card or dependency for review and loads file details when needed. */
function selectNode(node) {
  selected = node;
  if (node.kind === "symbol") {
    sourceView = node.status === "removed" ? "before" : "diff";
  }
  if (tab === "ask") ask.open();
  renderDeck();
  renderPanel();
  if (scope.kind === "file" && !sourceData) loadSource();
}
/** Drills into a selected directory or file, or opens source for a selected symbol. */
function openNode(node) {
  if (node.kind === "symbol") {
    tab = "source";
    sourceView = node.status === "removed" ? "before" : "after";
    renderPanel();
    if (!sourceData) loadSource();
    return;
  }
  if (node.kind === "edge") {
    tab = "dependencies";
    renderPanel();
    return;
  }
  if (node.kind === "boundary") return;
  navigate(nodeScope(node), node.key);
}
/** Animates a scope change, clears stale selection and source state, and loads file details after entering a file. */
async function navigate(next, originKey) {
  if (busy) return;
  const graph = $(".sheet:not(.peek) .graph-inner");
  const zoomIn =
    next.path.split("/").length > scope.path.split("/").length ||
    scope.kind === "repo";
  if (graph && !reducedMotion) {
    const origin = [...graph.querySelectorAll(".node")].find(
      (n) => n.dataset.key === originKey,
    );
    if (origin)
      graph.style.transformOrigin = `${origin.offsetLeft + origin.offsetWidth / 2}px ${origin.offsetTop + origin.offsetHeight / 2}px`;
    await graph.animate(
      [
        { transform: "scale(1)", opacity: 1 },
        { transform: zoomIn ? "scale(2.2)" : "scale(.6)", opacity: 0 },
      ],
      { duration: 180, easing: "cubic-bezier(.4,0,.6,1)" },
    ).finished;
  }
  scope = next;
  selected = null;
  sourceData = null;
  ++sourceId;
  search = "";
  tab = primaryTab;
  if (tab === "ask") ask.open();
  render();
  const body = $(".sheet:not(.peek) .sheet-body");
  if (body) body.scrollTop = 0;
  const nextGraph = $(".sheet:not(.peek) .graph-inner");
  if (nextGraph && !reducedMotion)
    nextGraph.animate(
      [
        { transform: zoomIn ? "scale(.55)" : "scale(1.6)", opacity: 0 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  $("#reviewScroll").scrollTop = 0;
  if (scope.kind === "file") await loadSource();
}
/** Navigates to the parent directory or repository root. */
function goUp() {
  if (scope.kind === "repo") return;
  const path = parent(scope.path);
  navigate(path ? { kind: "folder", path } : rootScope());
}
/** Synchronizes review tabs and rebuilds revision controls, selection details and the active tab. */
function renderPanel() {
  if (tab === "ask") ask.followSelection();
  if (tab === "runs") primaryTab = "comments";
  if (["ask", "comments"].includes(tab)) primaryTab = tab;
  const scopeBar = $("#reviewScope");
  scopeBar.replaceChildren(
    element(
      "strong",
      "review-name",
      selected?.name || scope.path || metadata?.name || "Repository",
    ),
  );
  const caption =
    selected?.kind === "symbol"
      ? `${selected.symbolKind} · ${scope.path}`
      : selected?.kind || scope.kind;
  scopeBar.append(element("span", "review-kind", caption));
  if (selected?.status)
    scopeBar.append(element("span", "pill", labels[selected.status]));
  if (selected) {
    const clear = button("x", "×", () => {
      selected = null;
      if (tab === "ask") ask.open();
      render();
    });
    clear.setAttribute("aria-label", "Clear selection");
    scopeBar.append(clear);
  }
  const helper = ["source", "changes", "dependencies"].includes(tab);
  $("#helperTools").open = helper;
  $("#panel").dataset.selection = String(!!selected);
  renderCommits();
  renderSelection();
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute(
        "aria-selected",
        String(
          b.dataset.tab ===
            (tab === "runs"
              ? "comments"
              : ["ask", "comments"].includes(tab)
                ? tab
                : primaryTab),
        ),
      ),
    );
  renderTab();
}
/** Builds commit history controls and the base-revision picker from the loaded repository history. */
function renderCommits() {
  const bar = $("#commitBar");
  bar.replaceChildren();
  const strip = element("div", "commits");
  strip.setAttribute("aria-label", "Commit history");
  for (const c of metadata.commits.slice().reverse()) {
    const b = button(
      "chip" + (mode === "diff" && c.sha === baseRef ? " is-base" : ""),
      "",
      () => chooseHead(c.sha),
    );
    b.dataset.sha = c.sha;
    b.setAttribute("aria-selected", String(c.sha === headRef));
    b.title = c.subject;
    b.append(element("b", "", c.short), element("span", "subject", c.subject));
    strip.append(b);
  }
  bar.append(strip);
  if (mode === "diff") {
    const row = element("label", "cmp", "Compare with");
    const picker = element("select");
    picker.id = "base";
    picker.setAttribute("aria-label", "Compare with revision");
    for (const c of metadata.commits) {
      const opt = element("option", "", `${c.short} ${c.subject}`);
      opt.value = c.sha;
      picker.append(opt);
    }
    if (![...picker.options].some((o) => o.value === baseRef)) {
      const opt = element("option", "", baseRef.slice(0, 8));
      opt.value = baseRef;
      picker.append(opt);
    }
    picker.value = baseRef;
    picker.onchange = () => {
      diffBase = baseRef = picker.value;
      loadComparison();
    };
    row.append(picker);
    bar.append(row);
  }
  const head = $("#commitHead"),
    c = commit(headRef);
  head.replaceChildren(element("h1", "c-title", c.subject));
  const meta = element(
    "p",
    "c-meta",
    `${c.short} · ${c.time ? new Date(c.time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "commit"} · compared with ${commit(baseRef).short}`,
  );
  head.append(meta);
  $("#revisionSummary").textContent = `${commit(baseRef).short} → ${c.short}`;
  requestAnimationFrame(() => {
    const active = strip.querySelector('[aria-selected="true"]');
    if (active)
      strip.scrollLeft =
        active.offsetLeft -
        strip.offsetLeft -
        strip.clientWidth +
        active.offsetWidth +
        5;
  });
}
/** Selects directory documentation from Before or After; removed directories use the base revision. */
function directoryInfo(path, removed = false) {
  return comparison?.directoryMetadata?.[
    before || removed ? "before" : "after"
  ]?.[path];
}
/** Builds a directory Details section from committed documentation, with provenance and a link to the complete source file. */
function directoryCard(path, removed = false) {
  const info = directoryInfo(path, removed),
    box = element("section", "directory-details");
  box.append(element("h3", "details-heading", "Details"));
  if (!info) {
    box.append(
      element(
        "p",
        "metadata-muted",
        "No directory README or package docstring at this revision.",
      ),
    );
    return box;
  }
  box.append(element("p", "code-description", info.description));
  box.append(
    element(
      "small",
      "metadata-muted",
      `${info.provenance} · ${info.path} · ${info.revision.slice(0, 7)}`,
    ),
  );
  box.append(
    button("btn documentation-link", "Read documentation", async () => {
      await navigate({ kind: "file", path: info.path });
      tab = "source";
      sourceView = before || removed ? "before" : "after";
      renderPanel();
    }),
  );
  return box;
}
/** Builds a disclosure identifying the selected file's language adapter, capabilities, analysis status and limitations. */
function adapterCard() {
  const adapter = comparison?.directoryMetadata?.adapters?.find((a) =>
      a.extensions.includes(scope.path.split(".").at(-1)),
    ),
    box = element("details", "adapter-details");
  box.append(
    element(
      "summary",
      "",
      adapter
        ? "Analyzed by " + adapter.id + " adapter"
        : "File-level inspection",
    ),
  );
  box.append(
    element("p", "metadata-muted", sourceData?.analysis || "Loading analysis…"),
  );
  if (adapter) {
    box.append(
      element("p", "", adapter.capabilities.join(" · ")),
      element("p", "metadata-muted", adapter.limitations),
    );
  } else
    box.append(
      element(
        "p",
        "metadata-muted",
        "Symbol extraction is not supported for this file type.",
      ),
    );
  return box;
}
/** Rebuilds selected-item actions and metadata, or directory context when nothing is selected. */
function renderSelection() {
  const side = before || selected?.status === "removed" ? "before" : "after";
  const module = sourceData?.details?.[side];
  const detail =
    selected?.kind === "symbol"
      ? module?.symbols?.find((item) => item.name === selected.name)
      : scope.kind === "file"
        ? module
        : directoryInfo(selected?.path || scope.path);
  $("#selectionDetails > summary").textContent = detail?.description
    ? "Description · " + detail.description.slice(0, 130)
    : "Description & metadata";
  const strip = $("#selStrip");
  strip.replaceChildren();
  if (!selected) {
    if (scope.kind === "file" && sourceData)
      strip.append(metadataCard(), adapterCard());
    if (["repo", "folder", "rootfiles"].includes(scope.kind))
      strip.append(directoryCard(scope.path));
    strip.append(
      element(
        "div",
        "hint-strip",
        scope.kind === "file"
          ? "Select a symbol to inspect its declaration."
          : "Select a card to review · tap again to open.",
      ),
    );
    return;
  }
  const box = element("div", "selstrip"),
    top = element("div", "sel-top");
  top.append(element("span", "sel-name", selected.name));
  if (selected.status)
    top.append(
      element(
        "span",
        "pill p-" +
          (selected.status === "unchanged" ? "same" : selected.status),
        labels[selected.status],
      ),
    );
  const close = button("x", "×", () => {
    selected = null;
    renderDeck();
    renderPanel();
  });
  close.setAttribute("aria-label", "Clear selection");
  top.append(close);
  box.append(top);
  box.append(
    element(
      "div",
      "sel-kind",
      selected.kind === "edge"
        ? selected.relationshipKind === "imports"
          ? "Static import dependency"
          : "Static " + selected.relationshipKind + " relationship"
        : selected.kind === "symbol"
          ? `${selected.symbolKind} · ${scope.path}`
          : selected.path || "Repository files",
    ),
  );
  const stats = element("div", "sel-stats");
  if (selected.files)
    stats.textContent = `${selected.files.length} files · ${selected.files.filter((f) => f.status !== "unchanged").length} changed`;
  else if (selected.kind === "symbol")
    stats.textContent = `Lines ${selected.start}–${selected.end}`;
  else if (selected.kind === "file")
    stats.textContent = `${selected.symbolCount ?? selected.symbols?.length ?? 0} symbols · ${selected.analysis}`;
  else if (selected.kind === "edge")
    stats.textContent = `${selected.before.size} ${selected.relationshipKind} before → ${selected.after.size} after`;
  box.append(stats);
  const actions = element("div", "sel-acts");
  actions.append(
    button(
      "btn primary",
      selected.kind === "symbol"
        ? "Open source"
        : selected.kind === "edge"
          ? "Inspect dependency"
          : "Open",
      () => openNode(selected),
    ),
  );
  if (scope.kind === "file")
    actions.append(
      button("btn", "Full file diff", () => {
        selected = null;
        sourceView = "diff";
        tab = "source";
        renderPanel();
        if (!sourceData) loadSource();
      }),
    );
  if (selected.kind === "symbol")
    actions.append(
      button("btn", "Relationships", () => {
        tab = "dependencies";
        renderPanel();
      }),
    );
  box.append(actions);
  if (
    scope.kind === "file" &&
    sourceData &&
    ["symbol", "boundary"].includes(selected.kind)
  )
    box.append(metadataCard());
  if (["folder", "rootfiles"].includes(selected.kind))
    box.append(directoryCard(selected.path, selected.status === "removed"));
  if (scope.kind === "file") box.append(adapterCard());
  strip.append(box);
}
/** Displays revision-specific module or symbol documentation and explicit declaration metadata. Long documentation and argument details remain expandable. */
function metadataCard() {
  const box = element("details", "code-metadata");
  const useBefore =
    tab === "source" && sourceView !== "diff"
      ? sourceView === "before"
      : before || selected?.status === "removed";
  const module = sourceData?.details?.[useBefore ? "before" : "after"];
  const info =
    selected?.kind === "symbol"
      ? module?.symbols?.find((item) => item.name === selected.name)
      : module;
  if (
    !info ||
    !(
      info.signature ||
      info.description ||
      info.parameters?.length ||
      info.fields?.length
    )
  )
    return element(
      "p",
      "metadata-muted",
      "Details · No declaration documentation available at this revision.",
    );
  box.open = false;
  box.append(
    element(
      "summary",
      "",
      (selected?.kind === "symbol"
        ? "Details · Declaration"
        : "Details · Module description") +
        (useBefore ? " · Before" : " · After"),
    ),
  );
  if (info.signature) box.append(element("pre", "signature", info.signature));
  if (info.description) {
    const long = info.description.length > 260;
    box.append(
      element(
        "p",
        "code-description",
        long
          ? info.description.slice(0, 260).trimEnd() + "…"
          : info.description,
      ),
    );
    if (long) {
      const full = element("details", "doc-expansion");
      full.append(
        element("summary", "", "Read full documentation"),
        element("p", "full-description", info.description),
      );
      box.append(full);
    }
  }
  const contract = element("details", "contract-details");
  const count = info.parameters?.length || 0;
  contract.append(
    element(
      "summary",
      "",
      [
        info.parameters ? `${count} argument${count === 1 ? "" : "s"}` : "",
        info.returns ? "returns " + info.returns : "",
        info.fields?.length ? info.fields.length + " fields" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  if (info.parameters?.length) {
    const list = element("dl", "metadata-parameters");
    for (const param of info.parameters) {
      list.append(element("dt", "", param.name + (param.optional ? "?" : "")));
      list.append(
        element(
          "dd",
          "",
          [
            param.type || "Unannotated",
            param.default != null ? "default: " + param.default : "",
            param.kind,
            param.description,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }
    contract.append(list);
  }
  if (info.parameters)
    contract.append(
      element(
        "p",
        "metadata-return",
        "Returns: " +
          (info.returns || "not annotated") +
          (info.returnDescription ? " · " + info.returnDescription : ""),
      ),
    );
  if (info.fields?.length) {
    contract.append(
      element(
        "p",
        "",
        "Fields: " +
          info.fields
            .map(
              (field) =>
                field.name +
                (field.optional ? "?" : "") +
                ": " +
                (field.type || "not annotated"),
            )
            .join("; "),
      ),
    );
  }
  if (info.parameters || info.fields?.length) box.append(contract);
  if (info.provenance)
    box.append(element("small", "metadata-muted", info.provenance));
  return box;
}
/** Builds Git-status labels, omitting statuses absent from the supplied file set. */
function legend(files) {
  const box = element("div", "legend-inline");
  for (const status of Object.keys(labels)) {
    const count = files?.filter((file) => file.status === status).length;
    if (files && !count) continue;
    const item = element("span");
    const dot = element("i");
    dot.style.setProperty("--tone", tones[status]);
    item.append(
      dot,
      document.createTextNode((files ? count + " " : "") + labels[status]),
    );
    box.append(item);
  }
  return box;
}
/** Creates a keyboard-accessible review-list entry that invokes its supplied navigation action. */
function listRow(node, detail, action) {
  const li = element("li"),
    row = button("row", "", action);
  row.dataset.status = node.status || "unchanged";
  row.append(
    element("span", "ic", symbols[node.status] || "→"),
    element("span", "rt", node.name),
    element("span", "rd", detail),
  );
  li.append(row);
  return li;
}
/** Renders the scoped change inventory, source view or dependency list for the active review tab. */
function renderTab() {
  const body = $("#tabBody");
  body.replaceChildren();
  if (["source", "changes", "dependencies"].includes(tab)) {
    body.append(
      button(
        "btn return-conversation",
        `← Back to ${primaryTab === "ask" ? "Ask" : "Comments"}`,
        () => {
          tab = primaryTab;
          renderPanel();
        },
      ),
    );
  }
  if (tab === "ask") {
    ask.render(body);
    return;
  }
  if (["comments", "runs"].includes(tab)) {
    workflow.render(body, tab);
    return;
  }
  if (tab === "source") {
    renderSource(body);
    return;
  }
  if (tab === "dependencies") {
    renderDependencies(body);
    return;
  }
  const files = comparison.files.filter((f) => inScope(f, scope)),
    changed = files.filter((f) => f.status !== "unchanged");
  const summary = element(
    "p",
    "sum",
    `${changed.length} changed files · ${files.length} in this scope`,
  );
  summary.id = "change-summary";
  summary.dataset.count = changed.length;
  body.append(ruleSummary(), summary, legend(files));
  const searchBox = element("label", "search-wrap");
  searchBox.append(element("span", "", "⌕"));
  const input = element("input");
  input.id = "search";
  input.type = "search";
  input.placeholder = "Find a file in the repository";
  input.setAttribute("aria-label", "Find a file");
  input.value = search;
  searchBox.append(input);
  body.append(searchBox);
  const results = element("ul", "list");
  results.id = "changes";
  body.append(results);
  const update = () => {
    results.replaceChildren();
    const list = search
      ? comparison.files.filter((f) =>
          f.path.toLowerCase().includes(search.toLowerCase()),
        )
      : scope.kind === "file"
        ? nodes.filter((n) => n.status !== "unchanged")
        : changed.map((f) => ({
            ...f,
            kind: "file",
            name: leaf(f.path),
            key: "file:" + f.path,
          }));
    for (const raw of list) {
      const node = raw.kind
        ? raw
        : {
            ...raw,
            kind: "file",
            name: leaf(raw.path),
            key: "file:" + raw.path,
          };
      results.append(
        listRow(
          node,
          node.kind === "symbol"
            ? `${node.symbolKind} · lines ${node.start}–${node.end}`
            : node.path,
          () => {
            if (node.kind === "symbol") selectNode(node);
            else navigate({ kind: "file", path: node.path });
          },
        ),
      );
    }
    if (!list.length)
      results.append(
        element(
          "li",
          "empty",
          search
            ? "No files match your search."
            : scope.kind === "file" && changed.length
              ? "This file changed without a symbol change. Open Source for the complete diff."
              : "No changes in this scope.",
        ),
      );
  };
  input.oninput = () => {
    search = input.value;
    update();
  };
  update();
  if (scope.kind === "file")
    body.append(
      button("btn", "Open full file diff", () => {
        tab = "source";
        sourceView = "diff";
        renderPanel();
        if (!sourceData) loadSource();
      }),
    );
}
/** Shows configuration health without implying that unresolved code passed a rule check. */
function ruleSummary() {
  const phase = before ? "before" : "after",
    checks = comparison.relationshipData?.checks?.[phase];
  const box = element("details", "rule-summary");
  if (!checks) return box;
  box.append(
    element(
      "summary",
      "",
      checks.state === "invalid"
        ? "Rule configuration error"
        : checks.state === "not configured"
          ? "Dependency rules · not configured"
          : `${checks.violations} observed rule violations · ${checks.rules} rule${checks.rules === 1 ? "" : "s"}`,
    ),
  );
  box.dataset.state = checks.state;
  if (checks.violations) box.classList.add("has-violations");
  if (tab !== "dependencies")
    box.append(
      button("btn sm", "Review relationships", () => {
        tab = "dependencies";
        renderPanel();
      }),
    );
  box.append(
    element(
      "p",
      "",
      `Repository checks · ${checks.config} · ${phase} revision. ${checks.unresolved} external, unresolved or ambiguous relationships; ${checks.analysisGaps.length} files with analysis gaps.`,
    ),
  );
  for (const error of checks.errors)
    box.append(element("p", "rule-error", error));
  if (checks.state === "not configured")
    box.append(
      element(
        "p",
        "",
        "Commit a .strata.json file to define path groups and forbidden relationships. No rules have been assumed.",
      ),
    );
  const other = comparison.relationshipData.checks[before ? "after" : "before"];
  if (other?.violations !== checks.violations)
    box.append(
      element(
        "p",
        "",
        `Other revision: ${other.violations} observed violations.`,
      ),
    );
  return box;
}
/** Opens the revision and source declaration that provide relationship evidence. */
async function openEvidence(relation) {
  const fact = before ? relation.before : relation.after || relation.before;
  if (!fact) return;
  await navigate({ kind: "file", path: fact.source.path });
  if (!sourceData) await loadSource();
  selected = nodes.find((n) => n.name === fact.source.symbol) || null;
  tab = "source";
  sourceView = before || !relation.after ? "before" : "after";
  renderDeck();
  renderPanel();
}
/** Lists typed relationships, rule evidence and unresolved targets for the current scope. */
function renderDependencies(body) {
  body.append(ruleSummary());
  const controls = element("div", "relationship-controls"),
    filter = element("select");
  filter.setAttribute("aria-label", "Relationship kind");
  for (const kind of ["all", "imports", "calls", "implements", "inherits"]) {
    const option = element(
      "option",
      "",
      kind === "all" ? "All relationships" : kind,
    );
    option.value = kind;
    filter.append(option);
  }
  filter.value = relationshipKind;
  filter.onchange = () => {
    relationshipKind = filter.value;
    render();
  };
  const violations = button("btn", "Violations only", () => {
    violationsOnly = !violationsOnly;
    render();
  });
  violations.setAttribute("aria-pressed", String(violationsOnly));
  controls.append(filter, violations);
  body.append(controls);
  body.append(
    element(
      "p",
      "read-note",
      "Static declarations, not runtime execution. Solid: imports/calls · dotted: implements · dashed: inherits · red: rule violation. Select a symbol to focus its calls.",
    ),
  );
  const list = element("ul", "list");
  body.append(list);
  let relevant = selected?.kind === "edge" ? [selected] : edges;
  if (selected?.kind === "symbol")
    relevant = relevant.filter((e) =>
      [e.from.key, e.to.key].includes(selected.key),
    );
  for (const edge of relevant) {
    const li = element("li", "cm"),
      buttonNode = button(
        "anchor",
        `${edge.relationshipKind} · ${edge.name}`,
        () => {
          selected = edge;
          renderDeck();
          renderPanel();
        },
      );
    li.append(
      buttonNode,
      element(
        "p",
        "rd",
        `${labels[edge.status]} · ${edge.before.size} before → ${edge.after.size} after`,
      ),
    );
    for (const v of before ? edge.violationsBefore : edge.violationsAfter)
      li.append(element("p", "rule-error", `! ${v.id}: ${v.message}`));
    if (selected?.key === edge.key)
      for (const pair of edge.pairs.values()) {
        const row = element("div", "sel-acts");
        row.append(
          button("btn sm", pair.from, () =>
            navigate({ kind: "file", path: pair.from }),
          ),
          element("span", "", "→"),
          button("btn sm", pair.to, () =>
            navigate({ kind: "file", path: pair.to }),
          ),
        );
        li.append(row);
      }
    list.append(li);
  }
  if (!relevant.length)
    list.append(
      element("li", "empty", "No resolved connections in this selection."),
    );
  if (scope.kind !== "file") {
    body.append(
      element(
        "p",
        "read-note",
        "Open a file for source locations and unresolved target details.",
      ),
    );
    return;
  }
  const records = sourceData?.relationshipData?.relationships || [];
  const scoped = records.filter((r) => {
    const fact = before ? r.before : r.after || r.before;
    if (!fact) return false;
    return (
      (relationshipKind === "all" || fact.kind === relationshipKind) &&
      (!violationsOnly || fact.violations.length) &&
      (selected?.kind !== "symbol" ||
        (fact.source.path === scope.path &&
          fact.source.symbol === selected.name) ||
        fact.targets.some(
          (t) => t.path === scope.path && t.symbol === selected.name,
        ))
    );
  });
  const unresolved = element("details", "unresolved-relations"),
    evidence = element("details", "relationship-evidence");
  const unknown = scoped.filter(
      (r) =>
        (before ? r.before : r.after || r.before).resolution !== "resolved",
    ),
    known = scoped.filter(
      (r) =>
        (before ? r.before : r.after || r.before).resolution === "resolved",
    );
  unresolved.append(
    element("summary", "", `${unknown.length} unresolved or ambiguous targets`),
  );
  evidence.append(
    element(
      "summary",
      "",
      `${known.length} resolved relationships · source evidence`,
    ),
  );
  for (const [container, values] of [
    [unresolved, unknown],
    [evidence, known],
  ]) {
    for (const r of values.slice(0, 200)) {
      const fact = before ? r.before : r.after || r.before;
      const item = element("div", "relation-evidence-row");
      item.dataset.resolution = fact.resolution;
      item.append(
        element(
          "p",
          "",
          `${fact.source.symbol || fact.source.path} ${fact.kind} ${fact.target} · ${r.status}`,
        ),
        element(
          "small",
          "metadata-muted",
          `${fact.resolution} · ${fact.reason}`,
        ),
      );
      for (const v of fact.violations)
        item.append(element("p", "rule-error", `! ${v.id}: ${v.message}`));
      item.append(
        button(
          "btn sm",
          `${fact.source.path}${fact.sites?.[0] ? ":" + fact.sites[0] : ""}`,
          () => openEvidence(r),
        ),
      );
      container.append(item);
    }
    if (values.length > 200)
      container.append(
        element(
          "p",
          "read-note",
          `Showing the first 200 of ${values.length} relationships. Select a symbol to narrow the list.`,
        ),
      );
  }
  body.append(evidence, unresolved);
}
/** Fetches before/after source and full declaration metadata for the current file. Reuses a twelve-file cache and ignores results from superseded navigation. */
async function loadSource() {
  const id = ++sourceId,
    path = scope.path;
  if (scope.kind !== "file") return;
  try {
    const key = comparison.base + ":" + comparison.head + ":" + path;
    let data = sources.get(key);
    if (!data) {
      data = await api(
        "/api/source?" +
          new URLSearchParams({
            base: comparison.base,
            head: comparison.head,
            path,
          }),
      );
      data.relationshipData = await api(
        "/api/relationships?" +
          new URLSearchParams({
            base: comparison.base,
            head: comparison.head,
            path,
          }),
      );
      sources.set(key, data);
      if (sources.size > 12) sources.delete(sources.keys().next().value);
    }
    if (id !== sourceId || scope.path !== path) return;
    sourceData = data;
    const file = comparison.files.find((file) => file.path === path);
    if (file) {
      file.symbols = data.symbols;
      file.imports = data.imports;
    }
    refreshModel();
    renderDeck();
    renderSelection();
    renderTab();
  } catch (error) {
    if (id === sourceId) {
      showNotice(error.message, true);
      if (tab === "source")
        $("#tabBody").append(element("p", "empty", error.message));
    }
  }
}
/** Shows a full-file or selected-symbol diff, or highlighted source from Before or After. Repository text is rendered as text rather than executable HTML. */
function renderSource(body) {
  if (scope.kind !== "file") {
    body.append(
      element(
        "p",
        "empty",
        "Open a file in the map or Changes list to inspect its source.",
      ),
    );
    return;
  }
  body.append(
    element(
      "h3",
      "source-title",
      scope.path + (selected?.kind === "symbol" ? " → " + selected.name : ""),
    ),
  );
  const tools = element("div", "source-tools"),
    seg = element("div", "seg");
  seg.setAttribute("aria-label", "Source view");
  for (const view of ["diff", "after", "before"]) {
    const b = button("", view[0].toUpperCase() + view.slice(1), () => {
      sourceView = view;
      renderSelection();
      renderTab();
    });
    b.dataset.sourceView = view;
    b.setAttribute("aria-pressed", String(sourceView === view));
    seg.append(b);
  }
  tools.append(seg);
  body.append(tools);
  if (!sourceData) {
    body.append(element("p", "empty", "Loading source…"));
    return;
  }
  body.append(
    element(
      "p",
      "read-note",
      sourceData.analysis +
        (selected?.kind === "symbol" && sourceView === "diff"
          ? " · Diff hunks for the selected symbol."
          : " · Complete file context, including changes outside symbols."),
    ),
  );
  const container = element("div", "patch"),
    code = element("div", "source-code");
  code.id = "source-code";
  code.tabIndex = 0;
  code.setAttribute("aria-label", "Source code");
  container.append(code);
  body.append(container);
  const value =
    sourceView === "diff"
      ? patchForSymbol(
          sourceData.patch,
          selected?.kind === "symbol" ? selected : null,
        )
      : sourceData[sourceView];
  if (!value) {
    code.append(
      element(
        "div",
        "empty",
        value === null
          ? "No readable source at this revision."
          : sourceView === "diff"
            ? selected?.kind === "symbol"
              ? "No code changes in this symbol. Open the full file diff to see other changes."
              : "No text changes. Choose Before or After to read the source."
            : "This file is empty.",
      ),
    );
    return;
  }
  const range =
    selected?.kind === "symbol"
      ? sourceView === "before"
        ? selected.before
        : selected
      : null;
  const fragment = document.createDocumentFragment();
  value.split("\n").forEach((line, index) => {
    let cls = "";
    if (sourceView === "diff")
      cls =
        line.startsWith("+") && !line.startsWith("+++")
          ? "addition"
          : line.startsWith("-") && !line.startsWith("---")
            ? "deletion"
            : line.startsWith("@@")
              ? "hunk"
              : "";
    else if (range && index + 1 >= range.start && index + 1 <= range.end)
      cls = "highlight";
    const row = element("div", "code-line " + cls);
    row.append(
      element("span", "line-number", sourceView === "diff" ? "" : index + 1),
      element("span", "", line),
    );
    fragment.append(row);
  });
  code.append(fragment);
  requestAnimationFrame(() => {
    const highlighted = code.querySelector(".highlight");
    if (highlighted)
      code.scrollTop = highlighted.offsetTop - code.offsetTop - 28;
  });
}
/** Changes the commit under review and reloads the appropriate Time or Diff comparison. */
function chooseHead(sha) {
  if (busy) return;
  headRef = sha;
  before = false;
  if (mode === "time") baseRef = parentRevision(sha);
  loadComparison();
}
document.querySelectorAll("[data-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      if (busy || mode === b.dataset.mode) return;
      mode = b.dataset.mode;
      before = false;
      baseRef = mode === "time" ? parentRevision(headRef) : diffBase;
      loadComparison();
    }),
);
document.querySelectorAll("[data-lens]").forEach(
  (b) =>
    (b.onclick = () => {
      lens = b.dataset.lens;
      renderControls();
      if (comparison) renderDeck();
    }),
);
document.querySelectorAll("[data-ba]").forEach(
  (b) =>
    (b.onclick = () => {
      before = b.dataset.ba === "before";
      selected = null;
      render();
    }),
);
document.querySelectorAll("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.dataset.tab === "ask" && tab !== "ask") ask.open();
      tab = b.dataset.tab;
      if (comparison) renderPanel();
      if (tab === "source" && scope.kind === "file" && !sourceData)
        loadSource();
    }),
);
$("#newComment").onclick = () => {
  workflow.compose();
  $("#reviewScroll").scrollTop = 0;
};
$("#refresh").onclick = () => boot(true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.target.closest("input,select,textarea"))
    return;
  if (selected) {
    selected = null;
    renderDeck();
    renderPanel();
  } else goUp();
});
let resizeFrame;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (comparison) renderDeck();
  });
}).observe($("#deck"));
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  history.replaceState(null, "", location.pathname);
  pair(token).catch((error) => {
    showNotice(error.message, true);
    $("#connect").hidden = false;
    $("#login-error").textContent = error.message;
  });
} else boot();
