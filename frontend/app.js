/** @module Browser controller for repository navigation, committed comparisons and the review panel. */
import { createAsk } from "./ask.js";
import { createWorkflow, renderDiff } from "./workflow.js";
import { mountCanvas } from "./canvas.js";
import { frostSelects } from "./select.js";
import {
  statusIcon,
  interfaceIcon,
  objectTypeIcon,
  fileKindIcon,
  glyph,
  iconButton,
} from "./icons.js";
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
// Static controls declare their glyph in markup; their names come from aria-label or text.
for (const node of document.querySelectorAll("[data-glyph]"))
  node.prepend(glyph(node.dataset.glyph));
frostSelects();
const labels = {
  added: "Added",
  changed: "Modified",
  removed: "Removed",
  unchanged: "Unchanged",
};
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
  tab = "details";
let viewingBranch = new URL(location.href).searchParams.get("branch"),
  bootId = 0;
let baseRef,
  headRef,
  diffBase = new URL(location.href).searchParams.get("base"),
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
    short: sha?.slice(0, 7),
    subject: "Selected revision",
  };
/** Captures the selected declaration or dependency at its displayed immutable revision. */
function reviewContext() {
  const n = selected;
  const useBefore =
    (scope.kind === "file" && sourceView !== "diff"
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
    if (["comments", "runs"].includes(value)) primaryTab = "comments";
    expandSheet();
    renderPanel();
  },
  redraw() {
    if (comparison) renderTab();
  },
  viewBranch: (branch) => switchBranch("refs/heads/" + branch),
  async inspect(base, head, anchor) {
    document.querySelector("#tabs").inert = true;
    try {
      mode = "diff";
      baseRef = base;
      diffBase = base;
      headRef = head;
      before = false;
      await boot(true, head);
      const url = new URL(location.href);
      url.searchParams.set("branch", head);
      history.replaceState(null, "", url);
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
      side: `${before ? "before" : "after"}:${scope.kind === "file" ? sourceView : "map"}`,
    };
  },
  notice: showNotice,
  redraw() {
    tab = "ask";
    expandSheet();
    renderTab();
  },
  async makeDraft(draft) {
    await api("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    await workflow.refresh(false);
    tab = "comments";
    primaryTab = "comments";
    expandSheet();
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
  const headers = new Headers(options.headers);
  const repo = new URL(location.href).searchParams.get("repo");
  if (repo) headers.set("X-Strata-Repository", repo);
  let response;
  try {
    response = await fetch(route, { ...options, headers });
  } catch {
    throw new Error(
      "Cannot reach Strata. Check that the server is running and your phone is connected to its network or Tailscale.",
    );
  }
  const result = await response.json();
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
    body: JSON.stringify({ token, name: navigator.userAgent.slice(0, 100) }),
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
async function boot(refresh = false, branch = viewingBranch) {
  const id = ++bootId;
  ++loadId;
  ++sourceId;
  busy = true;
  $("#branchPicker").disabled = true;
  $("#refresh").disabled = true;
  showNotice("Loading branch…");
  try {
    await setupRepositories();
    const next = await api(
      "/api/repo" + (branch ? "?" + new URLSearchParams({ head: branch }) : ""),
    );
    if (id !== bootId) return;
    metadata = next;
    viewingBranch = metadata.selectedBranch?.ref || branch;
    const picker = $("#branchPicker");
    picker.replaceChildren();
    for (const b of metadata.branches) {
      const option = element(
        "option",
        "",
        b.name + (b.remote ? " · remote" : ""),
      );
      option.value = b.ref;
      picker.append(option);
    }
    if (!metadata.selectedBranch) {
      const option = element(
        "option",
        "",
        "Detached · " + metadata.initialHead.slice(0, 7),
      );
      option.value = branch || "HEAD";
      picker.append(option);
    }
    picker.value = viewingBranch || "HEAD";
    picker.hidden = false;
    $("#repo-sub").hidden = true;
    $("#connect").hidden = true;
    $("#workspace").inert = false;
    $("#repo-name").textContent = metadata.name;
    document.title = metadata.name + " · Repo strata";
    $("#repo-sub").textContent =
      `${metadata.branch} · ${metadata.commits.length} recent commits`;
    headRef = refresh ? metadata.initialHead : headRef || metadata.initialHead;
    baseRef = diffBase || parentRevision(headRef);
    await loadComparison();
    if (document.documentElement.dataset.access !== "reader")
      workflow.refresh(false).catch((error) => showNotice(error.message, true));
  } catch (error) {
    if (id === bootId) {
      $("#branchPicker").value = viewingBranch || "HEAD";
      showNotice(error.message, true);
    }
  } finally {
    if (id === bootId) {
      busy = false;
      $("#branchPicker").disabled = false;
      $("#refresh").disabled = false;
    }
  }
}
/** Switches only the inspected ref. Manual comparison bases and unsent messages survive. */
async function switchBranch(branch) {
  setSheetHeight("peek");
  scope = rootScope();
  selected = null;
  before = false;
  tab = "details";
  await boot(true, branch);
  const url = new URL(location.href);
  if (viewingBranch) url.searchParams.set("branch", viewingBranch);
  history.replaceState(null, "", url);
}
$("#branchPicker").onchange = (event) => switchBranch(event.target.value);
/** Lists registered local checkouts; reload on switching prevents cross-repository task or source state. */
async function setupRepositories() {
  const data = await api("/api/repositories");
  document.documentElement.dataset.access = data.role;
  if (data.role === "reader") {
    $("#openTasks").hidden = true;
    $("#conversationDock").hidden = true;
    $("#loadPrs").title =
      "Read-only: PR listing is available; fetching a new comparison requires owner access";
  }
  const picker = $("#repositoryPicker");
  picker.replaceChildren();
  for (const repo of data.repositories) {
    const option = element("option", "", repo.name);
    option.value = repo.id;
    option.title = repo.path;
    picker.append(option);
  }
  picker.value =
    new URL(location.href).searchParams.get("repo") ||
    data.repositories.find((r) => r.default)?.id;
  $("#repositoryControl").hidden = data.repositories.length < 2;
}
$("#repositoryPicker").onchange = (event) => {
  const unsent = [
    ...document.querySelectorAll("textarea, #conversationDock input"),
  ].some((el) => el.value.trim());
  if (unsent && !confirm("Switch repository? Save any unsent draft first.")) {
    setupRepositories();
    return;
  }
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("repo", event.target.value);
  location.assign(url);
};
$("#loadPrs").onclick = async () => {
  $("#loadPrs").disabled = true;
  $("#prFeedback").textContent = "Loading pull requests…";
  try {
    const prs = await api("/api/prs");
    const picker = $("#prPicker");
    picker.replaceChildren(element("option", "", "Select a pull request…"));
    picker.firstChild.value = "";
    for (const pr of prs) {
      const o = element("option", "", `#${pr.number} ${pr.title}`);
      o.value = pr.number;
      picker.append(o);
    }
    picker.hidden = prs.length === 0;
    $("#prFeedback").textContent = prs.length
      ? "Opening a PR fetches its refs; your checkout stays unchanged."
      : "No open pull requests.";
  } catch (e) {
    $("#prFeedback").textContent = e.message;
  } finally {
    $("#loadPrs").disabled = false;
  }
};
$("#prPicker").onchange = async (event) => {
  const number = Number(event.target.value);
  if (!number) return;
  event.target.disabled = true;
  $("#prFeedback").textContent = "Fetching PR comparison…";
  try {
    const data = await api("/api/prs/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number }),
    });
    mode = "diff";
    before = false;
    scope = rootScope();
    selected = null;
    headRef = data.head;
    diffBase = data.base;
    baseRef = data.base;
    await boot(true, data.head);
    const url = new URL(location.href);
    url.searchParams.set("branch", data.head);
    url.searchParams.set("base", data.base);
    history.replaceState(null, "", url);
    const context = $("#prContext");
    context.replaceChildren();
    context.hidden = false;
    const link = element("a", "", `#${number} ${data.pr.title}`);
    link.href = data.pr.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    context.append(
      link,
      element("p", "read-note", data.pr.body || "No description."),
    );
    for (const check of data.pr.statusCheckRollup || [])
      context.append(
        element(
          "p",
          "read-note",
          `${check.name || check.context}: ${check.conclusion || check.state || check.status}`,
        ),
      );
    for (const entry of [
      ...(data.pr.reviews || []),
      ...(data.pr.comments || []),
    ])
      context.append(
        element(
          "p",
          "read-note",
          `${entry.author?.login || "Reviewer"}${entry.state ? " · " + entry.state : ""}: ${entry.body || ""}`,
        ),
      );
    $("#prFeedback").textContent =
      "PR comparison · merge base → head. Comments here remain local; publish on GitHub explicitly.";
  } catch (e) {
    $("#prFeedback").textContent = e.message;
  } finally {
    event.target.disabled = false;
  }
};
/** Uses the selected commit's first parent, or itself when it has no parent. */
function parentRevision(sha) {
  return commit(sha).parent || sha;
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
  renderMapLegend();
  document
    .querySelectorAll("button[data-mode]")
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
  if (scope.kind !== "repo")
    nav.append(iconButton(button("back", "", goUp), "back", "Up one level"));
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
  // The header keeps the root and current level; Up and the collapsed step reach the rest.
  const visible = parts.length > 2 ? [parts[0], parts.at(-1)] : parts;
  visible.forEach((part, index) => {
    if (index) nav.append(element("span", "chev", "›"));
    if (index && parts.length > 2) {
      const between = parts.at(-2);
      const skip = button("skip", "…", () => navigate(between.scope));
      skip.title = between.scope.path;
      skip.setAttribute("aria-label", "Up to " + between.label);
      nav.append(skip, element("span", "chev", "›"));
    }
    const b = button("", part.label, () => navigate(part.scope));
    b.title = part.scope.path || metadata.name;
    if (index === visible.length - 1) b.setAttribute("aria-current", "page");
    else if (index === 0) {
      // When space runs out the root collapses to an icon, keeping its name for assistive tech.
      b.classList.add("crumb-root");
      b.replaceChildren(
        glyph("home"),
        element("span", "crumb-label", part.label),
      );
    }
    nav.append(b);
  });
  return nav;
}
/** Renders the header breadcrumbs and the active map, moving the persistent Before/After and key controls into the floating canvas controls. */
function renderDeck() {
  const deck = $("#deck"),
    oldScroll =
      deck.querySelector(".sheet:not(.peek) .sheet-body")?.scrollTop || 0;
  const mapLegend = $("#mapLegend"),
    sides = $("#baSeg"),
    crumbHost = $("#crumbHost");
  const crumbs = breadcrumbs();
  crumbHost.replaceChildren(crumbs);
  requestAnimationFrame(() => {
    crumbs.classList.remove("tight");
    const root = crumbs.querySelector(".crumb-root");
    if (root && root.scrollWidth > root.clientWidth + 1)
      crumbs.classList.add("tight");
  });
  deck.replaceChildren();
  const sheet = element("div", "sheet");
  sheet.style.zIndex = "10";
  sheet.dataset.front = "true";
  const body = element("div", "sheet-body");
  sheet.append(body);
  deck.append(sheet);
  renderGraph(body);
  body.querySelector(".map-tools")?.append(mapLegend);
  body.querySelector(".canvas-controls")?.prepend(crumbHost, sides);
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
  // Keep graph nodes readable while using the canvas in both dimensions.
  const graphWidth = Math.min(width, 760);
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
    const cols = Math.min(current.length || 1, graphWidth < 540 ? 2 : 3),
      gap = 24,
      w = (graphWidth - 32 - (cols - 1) * gap) / cols,
      h = 108;
    current.forEach((node, index) =>
      positions.set(node.key, {
        node,
        x: 16 + (index % cols) * (w + gap),
        y: y + Math.floor(index / cols) * (h + 32),
        w,
        h,
      }),
    );
    y += Math.ceil(current.length / cols) * (h + 32);
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
  // Leave room to scroll the last row clear of the floating navigation and controls.
  const height = Math.max(available, y + 112);
  canvas.style.width = graphWidth + "px";
  canvas.style.height = height + "px";
  const verticalOffset = root && y < available ? (available - y) / 2 : 0;
  for (const p of positions.values()) p.y += verticalOffset;
  drawEdges(canvas, positions, graphWidth, height, false);
  for (const p of positions.values()) canvas.append(graphNode(p));
  const controls = element("div", "canvas-controls"),
    tools = element("div", "map-tools");
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "Map controls");
  const filter = iconButton(
    button("change-filter", "", () => {
      changesOnly = !changesOnly;
      if (changesOnly && selected?.status === "unchanged") selected = null;
      render();
    }),
    "filter",
    "Changes only",
  );
  filter.setAttribute("aria-pressed", String(changesOnly));
  tools.append(filter);
  controls.append(tools);
  mountCanvas(
    body,
    canvas,
    graphWidth,
    height,
    [baseRef, headRef, scope.kind, scope.path, changesOnly].join(":"),
    controls,
    tools,
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
  const changedFiles =
    node.files?.filter((f) => f.status !== "unchanged").length || 0;
  card.setAttribute(
    "aria-label",
    `${node.name}, ${node.symbolKind || node.targetKind || node.kind}${node.status ? ", " + labels[node.status] : ""}${node.files ? `, ${changedFiles} of ${node.files.length} files changed` : ""}`,
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
  top.append(objectTypeIcon(node));
  top.append(
    element(
      "span",
      "n-name",
      node.name +
        (node.kind === "symbol" &&
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
    // Counts replace child-name chips, which could not fit without truncation.
    const counts = element("div", "n-counts");
    if (lens === "changes")
      for (const status of ["added", "changed", "removed"]) {
        const count = node.files.filter((f) => f.status === status).length;
        if (!count) continue;
        const item = element("span", "n-count");
        item.dataset.status = status;
        item.append(statusIcon(status), document.createTextNode(count));
        counts.append(item);
      }
    const total = element("span", "n-count");
    total.append(
      glyph("file"),
      document.createTextNode(node.files.length),
      element("span", "visually-hidden", " files"),
    );
    counts.append(total);
    card.append(counts);
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
  if (["comments", "runs"].includes(tab)) tab = "details";
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
    expandSheet();
    sourceView = node.status === "removed" ? "before" : "after";
    renderPanel();
    if (!sourceData) loadSource();
    return;
  }
  if (node.kind === "edge") {
    tab = "dependencies";
    expandSheet();
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
  sourceView = "diff";
  selected = null;
  sourceData = null;
  ++sourceId;
  search = "";
  tab = "details";
  ask.followSelection();
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
  ask.followSelection();

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
    scopeBar.insertBefore(
      statusIcon(selected.status),
      scopeBar.querySelector(".review-kind"),
    );
  if (selected) {
    const clear = button("x", "×", () => {
      selected = null;
      if (tab === "ask") ask.open();
      render();
    });
    clear.setAttribute("aria-label", "Clear selection");
    scopeBar.append(clear);
  }

  $("#panel").dataset.selection = String(!!selected);
  renderCommits();
  renderSelection();
  document
    .querySelectorAll("button[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.tab === tab)),
    );
  document
    .querySelectorAll("[data-compose]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.compose === primaryTab)),
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
  const rail = $("#timeRail");
  rail.replaceChildren();
  rail.hidden = mode !== "time";
  $("#stage").dataset.mode = mode;
  if (mode === "time") rail.append(strip);
  if (mode === "diff") {
    const headRow = element("label", "cmp", "Head revision");
    const headPicker = element("select");
    headPicker.id = "headRevision";
    headPicker.setAttribute("aria-label", "Head revision");
    const candidates = metadata.commits.some((c) => c.sha === headRef)
      ? metadata.commits
      : [commit(headRef), ...metadata.commits];
    for (const c of candidates) {
      const option = element("option", "", `${c.short} ${c.subject}`);
      option.value = c.sha;
      headPicker.append(option);
    }
    headPicker.value = headRef;
    headPicker.onchange = () => chooseHead(headPicker.value);
    headRow.append(headPicker);
    bar.append(headRow);
    const row = element("label", "cmp", "Compare with");
    const picker = element("select");
    picker.id = "base";
    picker.setAttribute("aria-label", "Compare with revision");
    const automatic = element(
      "option",
      "",
      `Previous commit (automatic) · ${commit(parentRevision(headRef)).short}`,
    );
    automatic.value = "__previous__";
    picker.append(automatic);
    for (const c of metadata.commits) {
      const opt = element("option", "", `${c.short} ${c.subject}`);
      opt.value = c.sha;
      picker.append(opt);
    }
    if (![...picker.options].some((o) => o.value === baseRef)) {
      const opt = element("option", "", baseRef.slice(0, 7));
      opt.value = baseRef;
      picker.append(opt);
    }
    picker.value = diffBase || "__previous__";
    picker.onchange = () => {
      diffBase = picker.value === "__previous__" ? null : picker.value;
      baseRef = diffBase || parentRevision(headRef);
      loadComparison();
    };
    row.append(picker);
    bar.append(row);
  }
  if (diffBase) {
    bar.append(
      button("btn", "Use previous commit", () => {
        diffBase = null;
        baseRef = parentRevision(headRef);
        loadComparison();
      }),
    );
  }
  const head = $("#commitHead"),
    c = commit(headRef);
  head.replaceChildren(element("h1", "c-title", c.subject));
  const meta = element(
    "p",
    "c-meta",
    `${c.short} · ${c.time ? new Date(c.time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "commit"} · compared with ${commit(baseRef).short} · ${diffBase ? "manual base" : "previous commit (automatic)"}`,
  );
  head.append(meta);
  $("#revisionSummary").textContent =
    `${metadata.selectedBranch?.name || "detached"} · ${commit(baseRef).short} → ${c.short}`;
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
/** Starts a titled panel section; every Details, Changes and Relations block uses this card. */
function section(className, title) {
  const box = element("section", "p-section " + className);
  if (title) box.append(element("h3", "p-section-title", title));
  return box;
}
/** Builds a directory Details section from committed documentation, with provenance and a link to the complete source file. */
function directoryCard(path, removed = false) {
  const info = directoryInfo(path, removed),
    box = section("directory-details", "Documentation");
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
    box = element("details", "adapter-details p-section");
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
/** Explains what the current scope offers when nothing is selected. */
function scopeHint() {
  return scope.kind === "file"
    ? "Select a declaration to inspect it, or open Source for the whole file."
    : "Select a card to review it; tap it again to open.";
}
/** Describes a selection in one line when it has no committed documentation. */
function selectionLine(node) {
  if (node.kind === "edge")
    return `${node.name} · static ${node.relationshipKind}, not runtime execution.`;
  if (node.kind === "symbol")
    return (
      node.signature || `${node.symbolKind} · lines ${node.start}–${node.end}`
    );
  if (node.kind === "file")
    return `${node.symbolCount ?? node.symbols?.length ?? 0} declarations · ${node.analysis}`;
  return node.files
    ? `${node.files.filter((f) => f.status !== "unchanged").length} of ${node.files.length} files changed.`
    : scopeHint();
}
/** Lists the selection's facts as label/value pairs. */
function selectionFacts(node) {
  const facts = [];
  if (node.files) {
    const counts = Object.keys(labels)
      .map((status) => [
        status,
        node.files.filter((f) => f.status === status).length,
      ])
      .filter(([, count]) => count);
    facts.push(["Files", String(node.files.length)]);
    for (const [status, count] of counts)
      if (status !== "unchanged") facts.push([labels[status], String(count)]);
  } else if (node.kind === "symbol") {
    facts.push(
      ["Kind", node.symbolKind],
      ["Lines", `${node.start}–${node.end}`],
    );
  } else if (node.kind === "file") {
    const total = node.symbolCount ?? node.symbols?.length ?? 0,
      known = node.symbols || node.symbolPreview || [];
    facts.push(["Path", node.path], ["Declarations", String(total)]);
    // The compact preview is capped; report a count only when it covers every declaration.
    if (known.length && known.length === total)
      facts.push([
        "Changed declarations",
        String(known.filter((symbol) => symbol.status !== "unchanged").length),
      ]);
    facts.push(["Analysis", node.analysis]);
  } else if (node.kind === "edge") {
    facts.push(
      ["Kind", node.relationshipKind],
      ["Before → after", `${node.before.size} → ${node.after.size}`],
    );
  }
  return facts;
}
/** Shows changed declarations from the compact preview before a file is opened. */
function changedDeclarations(node) {
  // Names arrive with the file's details; the overview preview carries statuses only.
  const symbols = (node.symbols || []).filter(
    (symbol) => symbol.name && symbol.status && symbol.status !== "unchanged",
  );
  if (!symbols.length) return null;
  const box = section("changed-declarations", "Changed declarations"),
    list = element("ul", "list");
  for (const symbol of symbols.slice(0, 8)) {
    const li = element("li", "plain-row");
    li.append(statusIcon(symbol.status), element("span", "mono", symbol.name));
    list.append(li);
  }
  box.append(list);
  if (symbols.length > 8)
    box.append(
      element("p", "metadata-muted", `${symbols.length - 8} more in Changes`),
    );
  return box;
}
/** Rebuilds selected-item actions and metadata, or directory context when nothing is selected. */
function renderSelection() {
  const side =
    reviewContext().sha === baseRef && baseRef !== headRef ? "before" : "after";
  const module = sourceData?.details?.[side];
  const detail =
    selected?.kind === "symbol"
      ? module?.symbols?.find((item) => item.name === selected.name)
      : scope.kind === "file"
        ? module
        : directoryInfo(selected?.path || scope.path);
  const summaryText = $("#selectionSummary");
  summaryText.scrollTop = 0;
  summaryText.textContent =
    detail?.description?.split("\n")[0] ||
    (selected ? selectionLine(selected) : scopeHint());
  const contract = $("#selectionContract");
  contract.replaceChildren();
  const fact = (label, value) => {
    const term = element("dt", "", label);
    if (label === "In" || label === "Out") {
      term.replaceChildren(interfaceIcon(label));
    }
    contract.append(term, element("dd", "", value));
  };
  if (detail?.parameters) {
    fact(
      "In",
      detail.parameters.length
        ? detail.parameters
            .map(
              (p) =>
                `${p.name}${p.optional ? "?" : ""} · ${p.type || "type unspecified"}`,
            )
            .join("; ")
        : "No parameters",
    );
    fact(
      "Out",
      [detail.returns || "type unspecified", detail.returnDescription]
        .filter(Boolean)
        .join(" · "),
    );
  } else if (detail?.fields?.length) {
    fact(
      "Fields",
      detail.fields
        .map((f) => `${f.name} · ${f.type || "type unspecified"}`)
        .join("; "),
    );
  }
  contract.hidden = !contract.children.length;
  requestAnimationFrame(() => {
    markOverflow(summaryText);
    markOverflow(contract);
  });
  const strip = $("#selStrip");
  strip.replaceChildren();
  if (!selected) {
    if (scope.kind === "file" && sourceData)
      strip.append(metadataCard(), adapterCard());
    if (["repo", "folder", "rootfiles"].includes(scope.kind))
      strip.append(directoryCard(scope.path));
    strip.append(element("div", "hint-strip", scopeHint()));
    return;
  }
  const box = element("div", "selstrip"),
    top = element("div", "sel-top");
  top.append(element("span", "sel-name", selected.name));
  if (selected.status) top.append(statusIcon(selected.status));
  box.append(top);
  // The facts card replaces a bare action bar: what this is, its counts, and what to do next.
  const facts = section("selection-facts");
  facts.append(
    element(
      "p",
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
  const list = element("dl", "fact-list");
  for (const [label, value] of selectionFacts(selected))
    list.append(element("dt", "", label), element("dd", "", value));
  if (list.children.length) facts.append(list);
  const action = button(
    "btn primary",
    selected.kind === "symbol"
      ? "View source"
      : selected.kind === "edge"
        ? "Show evidence"
        : selected.kind === "file"
          ? "Open file"
          : selected.kind === "rootfiles"
            ? "Open file group"
            : "Open folder",
    () => openNode(selected),
  );
  if (selected.kind !== "boundary") {
    const actions = element("div", "sel-acts");
    actions.append(action);
    facts.append(actions);
  }
  box.append(facts);
  if (selected.kind === "file") {
    const changed = changedDeclarations(selected);
    if (changed) box.append(changed);
  }
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
/** Fades the last visible line while more peek text is scrollable, so clipping reads as "scroll for more". */
function markOverflow(node) {
  node.dataset.more = String(
    node.scrollTop + node.clientHeight < node.scrollHeight - 1,
  );
}
for (const id of ["#selectionSummary", "#selectionContract"])
  $(id).addEventListener("scroll", (event) => markOverflow(event.target), {
    passive: true,
  });
/** Displays revision-specific module or symbol documentation and explicit declaration metadata. Description, signature and arguments are readable directly in the expanded sheet. */
function metadataCard() {
  const box = element("section", "code-metadata p-section");
  const useBefore = reviewContext().sha === baseRef && baseRef !== headRef;
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
      "metadata-muted p-section",
      "No declaration documentation at this revision.",
    );
  box.append(
    element(
      "h3",
      "p-section-title",
      (selected?.kind === "symbol" ? "Declaration" : "Module") +
        (useBefore ? " · Before" : " · After"),
    ),
  );
  if (info.signature) box.append(element("pre", "signature", info.signature));
  if (info.description)
    box.append(element("p", "code-description", info.description));
  const contract = element("section", "contract-details");
  const count = info.parameters?.length || 0;
  contract.append(
    element(
      "h4",
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
    const dot = statusIcon(status);
    item.append(
      dot,
      document.createTextNode((files ? count + " " : "") + labels[status]),
    );
    box.append(item);
  }
  return box;
}
/** Explains the active colour lens and static edge notation without occupying canvas space. */
function renderMapLegend() {
  const host = $("#legendContent");
  host.replaceChildren(
    element(
      "strong",
      "",
      lens === "changes" ? "Change colours" : "Structure colours",
    ),
  );
  if (lens === "changes") host.append(legend());
  else
    host.append(
      element("p", "", "Blue marks structure; Git change colours are hidden."),
    );
  const types = element("div", "legend-inline");
  for (const [kind, label] of [
    ["folder", "Directory"],
    ["class", "Class / struct"],
    ["function", "Function / method"],
    ["interface", "Interface / trait"],
    ["enum", "Enum"],
  ]) {
    const item = element("span");
    item.append(objectTypeIcon({ kind }), document.createTextNode(label));
    types.append(item);
  }
  for (const kind of ["code", "document", "data", "image", "sealed", "file"]) {
    const item = element("span"),
      symbol = fileKindIcon(kind);
    item.append(symbol, document.createTextNode(symbol.title));
    types.append(item);
  }
  host.append(element("strong", "", "Object types"), types);
  const lines = element("div", "legend-lines");
  for (const [kind, label] of [
    ["solid", "Import or call"],
    ["implements", "Implementation"],
    ["inherits", "Inheritance"],
    ["removed", "Removed relationship"],
    ["violation", "Dependency rule violation"],
  ]) {
    const row = element("div", "legend-row");
    row.append(
      element("span", "legend-line " + kind),
      element("span", "", label),
    );
    lines.append(row);
  }
  host.append(
    lines,
    element(
      "p",
      "",
      "Arrows point from the using/calling item to its dependency or target. Connections are static declarations, not runtime execution. Select a line for evidence.",
    ),
  );
  const contractKey = element("div", "contract-key");
  contractKey.append(
    interfaceIcon("In"),
    element("span", "", "Inputs"),
    interfaceIcon("Out"),
    element("span", "", "Outputs"),
  );
  host.append(contractKey);
  host.append(
    iconButton(
      button("btn legend-close", "", () => {
        $("#mapLegend").open = false;
      }),
      "close",
      "Close legend",
    ),
  );
}
/** Creates a keyboard-accessible review-list entry that invokes its supplied navigation action. */
function listRow(node, detail, action) {
  const li = element("li"),
    row = button("row", "", action),
    text = element("span", "row-text");
  row.dataset.status = node.status || "unchanged";
  text.append(element("span", "rt", node.name), element("span", "rd", detail));
  row.append(statusIcon(node.status || "unchanged"), text, glyph("forward"));
  li.append(row);
  return li;
}
/** Renders the scoped change inventory, source view or dependency list for the active review tab. */
function renderTab() {
  $("#panel").dataset.view = tab;
  const body = $("#tabBody");
  body.replaceChildren();
  const composerHost = $("#composerHost");
  composerHost.replaceChildren();
  const conversation = element("div", "conversation");
  if (primaryTab === "ask") ask.render(conversation, composerHost);
  else workflow.renderComposer(composerHost);
  const anchor = composerHost.querySelector(".composer-anchor")?.textContent;
  $("#dockContext").replaceChildren(
    ...(anchor ? [glyph("pin"), document.createTextNode(anchor)] : []),
  );
  $("#dockContext").title = anchor || "";
  $("#selectionDetails").hidden = tab !== "details";
  if (tab === "details") return;
  if (tab === "ask") {
    if (primaryTab !== "ask")
      ask.render(conversation, document.createElement("div"));
    body.append(conversation);
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
  const overview = section("change-overview"),
    summary = element(
      "p",
      "sum",
      `${changed.length} changed · ${files.length} files in this scope`,
    );
  summary.id = "change-summary";
  summary.dataset.count = changed.length;
  overview.append(summary, legend(files));
  body.append(overview);
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
  const box = element("details", "rule-summary p-section");
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
      "Static declarations, not runtime execution. The map key explains line styles; select a symbol to focus its calls.",
    ),
  );
  const list = element("ul", "list relation-list");
  body.append(list);
  let relevant = selected?.kind === "edge" ? [selected] : edges;
  if (selected?.kind === "symbol")
    relevant = relevant.filter((e) =>
      [e.from.key, e.to.key].includes(selected.key),
    );
  for (const edge of relevant) {
    const li = element("li"),
      row = button("row", "", () => {
        selected = edge;
        renderDeck();
        renderPanel();
      }),
      text = element("span", "row-text");
    row.dataset.status = edge.status;
    if (selected?.key === edge.key) row.setAttribute("aria-current", "true");
    text.append(
      element("span", "rt", edge.name),
      element(
        "span",
        "rd",
        `${edge.relationshipKind} · ${labels[edge.status]} · ${edge.before.size} before → ${edge.after.size} after`,
      ),
    );
    row.append(statusIcon(edge.status), text, glyph("forward"));
    li.append(row);
    for (const v of before ? edge.violationsBefore : edge.violationsAfter)
      li.append(element("p", "rule-error", `${v.id}: ${v.message}`));
    if (selected?.key === edge.key) {
      const pairs = element("div", "relation-pairs");
      for (const pair of edge.pairs.values())
        for (const path of [pair.from, pair.to])
          pairs.append(
            button("link-button", path, () => navigate({ kind: "file", path })),
          );
      li.append(pairs);
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
  const unresolved = element("details", "unresolved-relations p-section"),
    evidence = element("details", "relationship-evidence p-section");
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
          "rt",
          `${fact.source.symbol || fact.source.path} ${fact.kind} ${fact.target}`,
        ),
        element(
          "small",
          "rd",
          `${fact.resolution} · ${fact.reason} · ${r.status}`,
        ),
      );
      for (const v of fact.violations)
        item.append(element("p", "rule-error", `${v.id}: ${v.message}`));
      item.append(
        button(
          "link-button",
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
  const tools = element("div", "source-tools"),
    seg = element("div", "seg");
  seg.setAttribute("aria-label", "Source view");
  for (const view of ["diff", "after", "before"]) {
    const b = button("", view[0].toUpperCase() + view.slice(1), () => {
      sourceView = view;
      renderPanel();
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
  tools.append(
    element(
      "p",
      "read-note",
      sourceData.analysis +
        (selected?.kind === "symbol" && sourceView === "diff"
          ? " · selected symbol's hunks"
          : " · whole file"),
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
  if (sourceView === "diff") {
    renderDiff(code, value);
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
  baseRef = diffBase || parentRevision(sha);
  loadComparison();
}
document.querySelectorAll("button[data-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      if (busy || mode === b.dataset.mode) return;
      mode = b.dataset.mode;
      before = false;
      baseRef = diffBase || parentRevision(headRef);
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
      sourceView = "diff";
      selected = null;
      render();
    }),
);
document.querySelectorAll("button[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      if (tab !== b.dataset.tab) $("#reviewScroll").scrollTop = 0;
      tab = b.dataset.tab;
      expandSheet();
      if (comparison) renderPanel();
      if (tab === "source" && scope.kind === "file" && !sourceData)
        loadSource();
    }),
);
document.querySelectorAll("[data-compose]").forEach(
  (b) =>
    (b.onclick = () => {
      primaryTab = b.dataset.compose;
      if (primaryTab === "ask") ask.open();
      if (comparison) renderPanel();
      $("#composerHost textarea")?.focus({ preventScroll: true });
    }),
);
$("#openTasks").onclick = () => {
  tab = "comments";
  primaryTab = "comments";
  expandSheet();
  renderPanel();
  workflow.refresh();
};
$("#showDiscussion").onclick = () => {
  tab = primaryTab;
  expandSheet();
  renderPanel();
};
let sheetPointer = null,
  sheetMotion = null;
const sheetLevels = ["peek", "half", "full"];
/** Measures the existing responsive snap heights, including the current draft and keyboard. */
function sheetStops() {
  const panel = $("#panel"),
    previous = panel.dataset.height,
    inline = panel.style.height;
  panel.style.removeProperty("height");
  delete panel.dataset.dragging;
  const stops = sheetLevels.map((level) => {
    panel.dataset.height = level;
    return panel.getBoundingClientRect().height;
  });
  panel.dataset.height = previous;
  panel.style.height = inline;
  return stops;
}
/** Holds the phone map at a fixed height while the sheet moves over it, so the SVG
 * viewport and its HTML cards are not re-laid-out and repainted on every frame. */
function freezeStage(height) {
  const stage = $("#stage");
  if (!matchMedia("(max-width: 899px)").matches || stage.style.height) return;
  stage.style.height = `${height}px`;
}
/** Returns the map to its grid row once the sheet has settled; it resizes once. */
function releaseStage() {
  $("#stage").style.removeProperty("height");
}
/** Raises a peeking sheet to half height for inspection. Never lowers a full sheet, so
 * switching views keeps the height the owner chose. */
function expandSheet() {
  if ($("#panel").dataset.height === "peek") setSheetHeight("half");
}
/** Settles from the current pixel height; reduced motion still follows direct finger movement. */
function setSheetHeight(height) {
  const panel = $("#panel"),
    start = panel.getBoundingClientRect().height,
    stageStart = $("#stage").getBoundingClientRect().height;
  sheetMotion?.cancel();
  sheetMotion = null;
  delete panel.dataset.dragging;
  delete panel.dataset.settling;
  delete panel.dataset.inspection;
  panel.style.removeProperty("height");
  panel.dataset.height = height;
  const end = panel.getBoundingClientRect().height;
  $("#sheetHandle").setAttribute(
    "aria-label",
    height === "full" ? "Collapse review sheet" : "Expand review sheet",
  );
  if (
    !matchMedia("(max-width: 899px)").matches ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    Math.abs(start - end) < 1
  ) {
    releaseStage();
    return;
  }
  // Collapsing reveals map that the sheet covered, so pre-extend it under the sheet.
  freezeStage(stageStart + Math.max(0, start - end));
  panel.dataset.settling = "true";
  const motion = panel.animate(
    [{ height: `${start}px` }, { height: `${end}px` }],
    { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  sheetMotion = motion;
  motion.finished
    .then(() => {
      if (sheetMotion === motion) {
        sheetMotion = null;
        delete panel.dataset.settling;
        releaseStage();
      }
    })
    .catch(() => {});
}
const sheetHandle = $("#sheetHandle");
sheetHandle.onpointerdown = (e) => {
  if (!e.isPrimary || e.button !== 0 || sheetPointer) return;
  const panel = $("#panel"),
    start = panel.getBoundingClientRect().height;
  sheetMotion?.cancel();
  sheetMotion = null;
  delete panel.dataset.settling;
  const stops = sheetStops();
  // Extend the map to its peek-height size; the sheet then slides over it.
  freezeStage(
    $("#stage").getBoundingClientRect().height + start - Math.min(...stops),
  );
  sheetPointer = {
    id: e.pointerId,
    y: e.clientY,
    start,
    level: panel.dataset.height,
    stops,
    moved: false,
  };
  panel.style.height = `${start}px`;
  delete sheetHandle.dataset.dragged;
  sheetHandle.setPointerCapture(e.pointerId);
};
sheetHandle.onpointermove = (e) => {
  if (!sheetPointer || e.pointerId !== sheetPointer.id) return;
  const delta = sheetPointer.y - e.clientY;
  if (Math.abs(delta) < 3 && !sheetPointer.moved) return;
  sheetPointer.moved = true;
  const panel = $("#panel");
  panel.dataset.dragging = "true";
  const height = Math.max(
    Math.min(...sheetPointer.stops),
    Math.min(Math.max(...sheetPointer.stops), sheetPointer.start + delta),
  );
  panel.style.height = `${height}px`;
  panel.dataset.inspection = String(height >= sheetPointer.stops[1] - 24);
};
function finishSheetDrag(e, cancelled = false) {
  if (!sheetPointer || e.pointerId !== sheetPointer.id) return;
  const drag = sheetPointer;
  sheetPointer = null;
  if (drag.moved) sheetHandle.dataset.dragged = "true";
  else delete sheetHandle.dataset.dragged;
  let target = drag.level;
  if (!cancelled && drag.moved) {
    const current = $("#panel").getBoundingClientRect().height;
    let index = drag.stops.reduce(
      (best, value, i) =>
        Math.abs(value - current) < Math.abs(drag.stops[best] - current)
          ? i
          : best,
      0,
    );
    const delta = drag.y - e.clientY,
      previous = sheetLevels.indexOf(drag.level);
    if (index === previous && Math.abs(delta) > 48)
      index = Math.max(0, Math.min(2, index + (delta > 0 ? 1 : -1)));
    target = sheetLevels[index];
  }
  setSheetHeight(target);
  if (sheetHandle.hasPointerCapture(e.pointerId))
    sheetHandle.releasePointerCapture(e.pointerId);
}
sheetHandle.onpointerup = (e) => finishSheetDrag(e);
sheetHandle.onpointercancel = (e) => finishSheetDrag(e, true);
sheetHandle.onlostpointercapture = (e) => finishSheetDrag(e, true);
sheetHandle.onclick = (event) => {
  if (sheetHandle.dataset.dragged && event.detail !== 0) {
    delete sheetHandle.dataset.dragged;
    return;
  }
  delete sheetHandle.dataset.dragged;
  const levels = ["peek", "half", "full"];
  setSheetHeight(levels[(levels.indexOf($("#panel").dataset.height) + 1) % 3]);
};
sheetHandle.onkeydown = (e) => {
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const levels = ["peek", "half", "full"],
      i = levels.indexOf($("#panel").dataset.height);
    setSheetHeight(
      e.key === "Home"
        ? "peek"
        : e.key === "End"
          ? "full"
          : levels[
              Math.max(0, Math.min(2, i + (e.key === "ArrowUp" ? 1 : -1)))
            ],
    );
  }
};
$("#refresh").onclick = () => boot(true);
// Header and map popovers close when the owner interacts elsewhere.
document.addEventListener("pointerdown", (event) => {
  // A select menu belongs to the popover that opened it, though it renders in <body>.
  if (event.target.closest?.(".frost-menu")) return;
  for (const id of ["#revisionDetails", "#mapLegend"])
    if ($(id).open && !$(id).contains(event.target)) $(id).open = false;
});
$("#closeRevision").onclick = () => {
  $("#revisionDetails").open = false;
  $("#revisionDetails > summary").focus();
};
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.target.closest("input,select,textarea"))
    return;
  for (const id of ["#mapLegend", "#revisionDetails"])
    if ($(id).open) {
      $(id).open = false;
      $(id + " > summary").focus();
      return;
    }
  if (selected) {
    selected = null;
    renderDeck();
    renderPanel();
  } else goUp();
});
// Height changes resize the SVG viewport naturally. Rebuild only for width changes,
// so dragging the sheet preserves the graph DOM, selection and pan/zoom transform.
let resizeFrame,
  deckWidth = 0;
new ResizeObserver((entries) => {
  const width = entries[0].contentRect.width;
  if (Math.abs(width - deckWidth) < 1) return;
  deckWidth = width;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (comparison) renderDeck();
  });
}).observe($("#deck"));
$("#mapLegend").addEventListener("toggle", () => {
  if (!$("#mapLegend").open) return;
  $("#revisionDetails").open = false;
  // Fit the key between the map's top edge and its floating toolbar; it scrolls beyond that.
  const map = $(".sheet-body")?.getBoundingClientRect(),
    tools = $(".map-tools")?.getBoundingClientRect();
  if (map && tools)
    $("#mapLegend .legend-popover").style.maxHeight =
      Math.max(160, tools.top - map.top - 16) + "px";
});
$("#revisionDetails").addEventListener("toggle", () => {
  if ($("#revisionDetails").open) $("#mapLegend").open = false;
});
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  history.replaceState(null, "", location.pathname + location.search);
  pair(token).catch((error) => {
    showNotice(error.message, true);
    $("#connect").hidden = false;
    $("#login-error").textContent = error.message;
  });
} else boot();

/** Keeps the interaction dock above a phone keyboard and browser chrome. */
function fitVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale > 1.05) return;
  if (sheetPointer) finishSheetDrag({ pointerId: sheetPointer.id }, true);
  document.documentElement.style.setProperty(
    "--viewer-height",
    `${viewport.height}px`,
  );
  document.documentElement.style.setProperty(
    "--viewer-top",
    `${viewport.offsetTop}px`,
  );
  document.documentElement.classList.toggle(
    "keyboard-open",
    viewport.height < window.innerHeight * 0.8,
  );
}
window.visualViewport?.addEventListener("resize", fitVisualViewport);
window.visualViewport?.addEventListener("scroll", fitVisualViewport);
fitVisualViewport();
