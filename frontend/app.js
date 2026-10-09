/** @module Browser controller for repository navigation, committed comparisons and the review panel. */
import { createAsk } from "./ask.js";
import { createAgents } from "./agents.js";
import { createWorkflow, renderDiff } from "./workflow.js";
import * as sessions from "./session.js";
import { createFixes } from "./fixes.js";
import { createAudit } from "./audit.js";
import { createNotifications } from "./notify.js";
import { createFocus } from "./focus.js";
import { installContextMenus, closeMenu, menuIsOpen } from "./menu.js";
import { createNav } from "./nav.js";
import { mountCanvas } from "./canvas.js";
import { frostSelects } from "./select.js";
import { peek } from "./peek.js";
import { richText } from "./text.js";
import {
  statusIcon,
  interfaceIcon,
  objectTypeIcon,
  fileKindIcon,
  partIcon,
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
/** The address the app shows. Every change of it goes through `replaceUrl`, so the back
 * button's entries (see BACK_BASE) keep it. */
let shownUrl = location.href;
function replaceUrl(url) {
  history.replaceState(history.state, "", url);
  shownUrl = location.href;
}
/** True on an owner device; a read-only device can read the map and the source only. */
const isOwner = () => document.documentElement.dataset.access !== "reader";
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
$("#connectMark").replaceWith(peek("idle", { className: "connect-mark" }));
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
/** The dock's mode on the map: "ask", "comments" (an instruction) or "session". A
 * preference only; what the sheet shows is the view (see nav.js). */
let dockMode = "ask";
let changesOnly = false;
let relationshipKind = "all",
  violationsOnly = false;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The phone layout, with the sheet under the map (style.css uses the same query). A larger
 * phone on its side has the desktop layout. */
const PHONE =
  "(max-width: 639px), (max-width: 899px) and (min-height: 501px), (max-width: 899px) and (orientation: portrait)";
let metadata,
  comparison,
  scope = rootScope(),
  selected = null,
  mode =
    new URL(location.href).searchParams.get("mode") === "time"
      ? "time"
      : "diff",
  lens = "changes",
  before = false;
let viewingBranch = new URL(location.href).searchParams.get("branch"),
  // The pull request on view, if any; it names the comparison instead of "detached".
  viewingPr = new URL(location.href).searchParams.get("pr"),
  // Its details from GitHub (title, description, checks, reviews) for the sheet.
  prData = null,
  // Open and recently merged PRs for the View list; null until the first load.
  prList = null,
  // The PR description shows in full only after "Read full description".
  prExpanded = false,
  bootId = 0;
/** Stops naming the view after a pull request once the owner looks at something else. */
function leavePr() {
  viewingPr = null;
  prData = null;
  const url = new URL(location.href);
  url.searchParams.delete("pr");
  replaceUrl(url);
}
/** True when the sheet shows the pull request itself: one is open, and nothing is
 * selected at the top of the map. */
const prView = () =>
  !!(viewingPr && prData && !selected && scope.kind === "repo");
let baseRef,
  // The head and mode that the address keeps (see rememberPlace), until the first map.
  headRef = new URL(location.href).searchParams.get("head"),
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
/** Words for the changed parts of a declaration, in a fixed order: "signature and implementation". */
const partWords = (changes = []) =>
  changes.length > 1
    ? changes.slice(0, -1).join(", ") + " and " + changes.at(-1)
    : changes[0] || "";
// Keys of cards connected to the current selection; set while the map renders.
let linkedKeys = null;
const nodeScope = (node) => ({
  kind: node.kind === "stub" ? node.targetKind : node.kind,
  path: node.path,
});
/** The newest commit, when the checkout has uncommitted changes on top of it: its
 * `uncommitted` is `{sha, paths}`, a private snapshot (see backend/worktree.rs). */
const pending = () =>
  metadata?.commits[0]?.uncommitted ? metadata.commits[0] : null;
/** The revision that the map shows for commit `sha`: the newest commit shows with the
 * uncommitted changes, so the map is the code as it is now. */
const shownRevision = (sha) => {
  const newest = pending();
  return newest && sha === newest.sha ? newest.uncommitted.sha : sha;
};
/** The paths with uncommitted changes, while the map shows them; otherwise null. */
const uncommittedPaths = () => {
  const newest = pending();
  return newest && headRef === newest.uncommitted.sha && !before
    ? newest.uncommitted.paths
    : null;
};
/** A commit's short name in the interface: "uncommitted" for the snapshot. */
const revisionName = (sha) =>
  commit(sha).worktree ? "uncommitted" : String(sha).slice(0, 7);
/** The commit `sha` from the list. The snapshot is the newest commit with `worktree` set: it
 * has that commit's name, and its parent, so it is compared with the same commit. */
const commit = (sha) => {
  const found = metadata?.commits.find((c) => c.sha === sha);
  if (found) return found;
  const newest = pending();
  if (newest && sha === newest.uncommitted.sha)
    return { ...newest, sha, worktree: true };
  return { sha, short: sha?.slice(0, 7), subject: "Selected revision" };
};
/** The owner's anchor while Follow moves the map for an agent: `{context, base, head}`.
 * Follow never chooses for the owner, so the dock keeps what they selected until they select,
 * move the map or change the comparison themselves. */
let held = null;
/** Captures the selected declaration or dependency at its displayed immutable revision, or
 * the owner's anchor that Follow holds. */
function reviewContext() {
  if (held && held.base === baseRef && held.head === headRef)
    return held.context;
  return currentContext();
}
function currentContext() {
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
/** Compares `base` with `head` (a ref or commit) on the map and opens `anchor` there:
 * a file or folder path, an optional declaration, or the repository root. The map opens as
 * a view over the current one (Back returns to it); `explore` marks a task's branch. */
async function inspectRevision(
  base,
  head,
  anchor,
  { explore = null, aspect = null } = {},
) {
  // Back returns to the comparison and the place on the map from before.
  explore ??= here(null);
  leavePr();
  document.querySelector("#tabs").inert = true;
  try {
    // A commit that is the tip of the branch on the map stays on that branch, not detached.
    const branch = head === headRef && viewingBranch ? viewingBranch : head;
    mode = "diff";
    baseRef = base;
    diffBase = base;
    headRef = head;
    before = false;
    await boot(true, branch);
    const url = new URL(location.href);
    url.searchParams.set("branch", branch);
    replaceUrl(url);
    // The view comes last, from this function; the map moves without changing it.
    if (anchor.path) {
      await navigate(
        {
          kind: anchor.kind === "folder" ? "folder" : "file",
          path: anchor.path,
        },
        "",
        { keepTab: true },
      );
      if (scope.kind === "file") await loadSource();
    } else await navigate(rootScope(), "", { keepTab: true });
    if (anchor.symbol)
      selected = nodes.find((n) => n.name === anchor.symbol) || null;
    sourceView = base === head ? "after" : "diff";
    nav.go({
      name: "inspect",
      aspect:
        aspect ||
        (anchor.path && anchor.kind !== "folder" ? "source" : "changes"),
      ...(explore ? { explore } : {}),
    });
  } finally {
    document.querySelector("#tabs").inert = false;
  }
}
/** The comparison that the map left, from the nearest view that changed it, or null:
 * `{id, branch, base, mode, place}`: the task whose branch it shows (null for another
 * revision, such as an instruction's), and the branch, manual base, mode and place on the map
 * to return to. */
const exploring = () => nav.find((v) => v.explore)?.explore || null;
/** True while a conversation fills the sheet (Ask, or an open session): the map's selection
 * is then the subject of its next message, and the conversation stays in view. */
const onThread = () => {
  const view = nav.view();
  return (
    view.name === "ask" || (view.name === "run" && workflow.isLive(view.id))
  );
};
/** The comparison that an exploration left, while its views are still on the stack. */
let explored = null;
/** "Back to task": back past the explored branch, to the task. */
/** "Back to task": one element for the life of the page, moved into the title row on screen
 * (the title row is drawn again with each selection). */
const taskReturnChip = $("#taskReturn");
taskReturnChip.onclick = () => nav.backWhile((v) => Boolean(v.explore));
// The agent, model and effort for Ask and tasks, kept on this device for each repository.
const agents = createAgents({
  api,
  repo: () => new URL(location.href).searchParams.get("repo"),
});
// Where an agent works, on the map: a session, a running task, or an Ask answer (focus.js).
const focus = createFocus({ followTo });
/** What the sheet shows, and the way back (nav.js). Every change of view comes here. */
const nav = createNav({ changed: viewChanged });
function viewChanged(previous, next) {
  // The views of an explored branch are gone: the map returns to the comparison it left, in
  // its mode, at the same place.
  const now = exploring();
  if (explored && !nav.find((v) => v.explore === explored)) {
    const left = explored;
    explored = now;
    diffBase = left.base;
    mode = left.mode || "diff";
    switchBranch(left.branch || "HEAD")
      .then(() => goToPlace(left.place))
      .catch((e) => showNotice(e.message, true));
  } else explored = now;
  // A page needs room: from the closed sheet it opens to half height.
  if (next.name !== "inspect" && next.name !== previous.name) expandSheet();
  workflow.viewChanged(next);
  if (comparison) renderPanel();
}
const notifications = createNotifications({
  api,
  notice: (text, error = false) => showNotice(text, error),
});
const workflow = createWorkflow({
  api,
  // The Tasks page shows sessions too; app.js connects the two features.
  sessions,
  focus,
  agents,
  nav,
  head: viewHead,
  taskActions: () => (isOwner() ? [notifications.button()] : []),
  revisionName: (sha) => revisionName(sha),
  /** A new instruction: the map, with the dock in Instruction mode (Back returns). */
  writeInstruction() {
    dockMode = "comments";
    nav.toMap();
    focusComposer();
  },
  context: reviewContext,
  notice: showNotice,
  redraw() {
    if (comparison) renderTab();
  },
  /** Shows everything a task's agent did on the map: its branch against where the task
   * started. The sheet drops to peek so the map leads, and a chip leads back to the task. */
  async explore(base, branch, id) {
    await inspectRevision(
      base,
      "refs/heads/" + branch,
      { kind: "repo" },
      { explore: here(id) },
    );
    setSheetHeight("peek");
  },
  inspect: inspectRevision,
  openPlace: (target) => openPlace(target, { keepTab: true }),
  /** Shows a session's branch on the map, at a file when `path` is given; the chip leads back
   * to the session. */
  async showOnMap(r, path) {
    await inspectRevision(
      r.base,
      "refs/heads/" + r.branch,
      path ? { kind: "file", path } : { kind: "repo" },
      {
        explore: exploring()?.id === r.id ? exploring() : here(r.id),
      },
    );
    setSheetHeight(path ? "half" : "peek");
  },
  /** The task being explored, when it can still collect changes for a next round. */
  exploring: () => {
    const id = exploring()?.id;
    return id && workflow.revisable(id) ? id : null;
  },
  // The watched branch moved: show its new commits, as the Refresh button does.
  moved: () => {
    if (!viewingPr && !exploring()) boot(true).catch(() => {});
  },
});
/** A way back for task `id` (or null): the branch, base, mode and place on the map now. */
const here = (id) => ({
  id,
  branch: viewingBranch,
  base: diffBase,
  mode,
  place: placeOf(),
});
// Proposed fixes for the rule breaks at the map's commit (fixes.js): a page that saves the
// fixes the owner selects as instructions, and opens the task form with them.
const fixes = createFixes({
  api,
  write: (route, body) =>
    api(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  head: (title, options) => viewHead(title, options),
  revision: () => headRef,
  // The proposals come from the agent that the owner chose for Ask (read-only lookups).
  using: () => agents.using("ask"),
  agentName: () => agents.label(agents.current("ask")?.agent),
  send: (ids) => workflow.prepareWith(ids),
  saved: (n) => {
    workflow.refresh(false);
    showNotice(
      `Saved ${n} draft instruction${n === 1 ? "" : "s"}. Tasks lists them.`,
    );
    setTimeout(() => showNotice(""), 2500);
  },
  redraw: () => renderPanel(),
  showing: () => nav.view().name === "fixes",
});
// Proposed rules from an audit of the architecture (audit.js): a page that saves the rules
// the owner selects as instructions on the rule file, and opens the task form with them.
const audit = createAudit({
  api,
  write: (route, body) =>
    api(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  head: (title, options) => viewHead(title, options),
  revision: () => headRef,
  using: () => agents.using("ask"),
  agentName: () => agents.label(agents.current("ask")?.agent),
  send: (ids) => workflow.prepareWith(ids),
  saved: (n) => {
    workflow.refresh(false);
    showNotice(
      `Saved ${n} draft instruction${n === 1 ? "" : "s"}. Tasks lists them.`,
    );
    setTimeout(() => showNotice(""), 2500);
  },
  redraw: () => renderPanel(),
  showing: () => nav.view().name === "audit",
});
const ask = createAsk({
  revisionName: (sha) => revisionName(sha),
  api,
  stream: apiStream,
  /** The places an Ask answer read, oldest first, and whether it still works: the map
   * shows them as it does for a session (focus.js). */
  lookedAt(places, running) {
    const recent = [];
    for (const place of places.slice().reverse())
      if (
        !recent.some((p) => p.path === place.path && p.symbol === place.symbol)
      )
        recent.push(place);
    focus.set(
      "ask",
      running || recent.length
        ? { running, current: recent[0] || null, trail: recent.slice(1, 5) }
        : null,
    );
  },
  using: () => agents.using("ask"),
  rootSubject: () => (viewingPr ? `PR #${viewingPr}` : null),
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
    if (comparison) renderTab();
  },
  /** A question was sent: its conversation opens, if it is not on screen. */
  opened() {
    if (nav.view().name !== "ask") nav.go({ name: "ask" });
  },
  /** Shows a place an answer names: the map moves there and selects it, while the
   * conversation stays in view. */
  async openReference(target) {
    await openPlace(target);
  },
  async makeDraft(draft) {
    await api("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    await workflow.refresh(false);
    showNotice("Saved as a draft instruction. Tasks lists it.");
    setTimeout(() => showNotice(""), 2500);
    renderPanel();
  },
  /** The task being explored, when it can still take requested changes. */
  changeTarget: () => workflow.exploringTask(),
  /** Collects an answer's suggestion, at the place it was asked about, for the explored
   * task's next round; exploring carries on. */
  async addToChanges(message) {
    await workflow.collect(
      exploring().id,
      message.asked.anchor,
      message.asked.sha,
      message.suggestion,
    );
    showNotice("Added to this task's requested changes");
    setTimeout(() => showNotice(""), 2000);
  },
});
let noticeTimer = 0,
  noticeView = "",
  noticeName = "";
/** Updates the status banner and distinguishes ordinary progress from errors. An error fades
 * after a few seconds, and leaving the view it happened in clears it; losing the connection
 * stays until a later request succeeds. */
function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  if (error && message && message !== UNREACHABLE)
    noticeTimer = setTimeout(() => showNotice(""), 6000);
  // Errors get Peek's sunken face; progress notices stay plain text.
  $("#notice").replaceChildren(
    // An unreachable server sends Peek to sleep; other errors get its sunken face.
    ...(error && message
      ? [peek(message === UNREACHABLE ? "asleep" : "error")]
      : []),
    document.createTextNode(message),
  );
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = !message;
}
/** Fetches an authenticated same-origin JSON API response. Rejects failed HTTP responses with the server error message. */
const UNREACHABLE =
  "Cannot reach Peekumi. Check that the server is running and your phone is connected to its network or Tailscale.";
async function api(route, options = {}) {
  const headers = new Headers(options.headers);
  const repo = new URL(location.href).searchParams.get("repo");
  if (repo) headers.set("X-Peekumi-Repository", repo);
  let response;
  try {
    response = await fetch(route, { ...options, headers });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const result = await response.json();
  if (response.status === 401) {
    $("#connect").hidden = false;
    $("#workspace").inert = true;
  }
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
/** Posts JSON and hands each newline-delimited JSON event to `onEvent` as it arrives, so an
 * answer can appear while it is written. An exception from `onEvent` stops reading and rejects.
 * Network failures and non-OK responses reject with the server's message, as `api` does. */
async function apiStream(route, body, onEvent) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const repo = new URL(location.href).searchParams.get("repo");
  if (repo) headers.set("X-Peekumi-Repository", repo);
  let response;
  try {
    response = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      $("#connect").hidden = false;
      $("#workspace").inert = true;
    }
    throw new Error(result.error || "Request failed");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}
// The header's height, for the sheet's full height (style.css): one row or two, by width.
new ResizeObserver(([entry]) =>
  document.documentElement.style.setProperty(
    "--top-height",
    `${Math.ceil(entry.target.getBoundingClientRect().height)}px`,
  ),
).observe($("header.top"));
/** Exchanges a private access token for a session cookie and initializes the viewer on success. */
async function pair(token) {
  await api("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, name: navigator.userAgent.slice(0, 100) }),
  });
  await boot();
  await restorePlace();
}
$("#login").onsubmit = (event) => {
  event.preventDefault();
  pair($("#token").value.trim()).catch(
    (error) => ($("#login-error").textContent = error.message),
  );
};
/** Loads repository identity and initial revisions, then renders the comparison. A refresh follows the latest configured head. */
/** Until the first map is drawn, the map area shows Peek loading and the current step. The
 * Peek from the page's first frame stays, so its motion never restarts. `failed` shows the
 * error there instead. */
function startStep(text, failed = false) {
  if (comparison) return false;
  let box = $("#startLoading");
  if (!box) {
    box = element("div", "loading-message");
    box.id = "startLoading";
    box.setAttribute("role", "status");
    const step = element("span", "", text);
    step.id = "startStep";
    box.append(peek("loading"), step);
    $("#deck").replaceChildren(box);
  }
  // An unreachable server sends Peek to sleep, as the notice does; other errors sink it.
  if (failed)
    box
      .querySelector(".peek-mark")
      .replaceWith(peek(text === UNREACHABLE ? "asleep" : "error"));
  $("#startStep").textContent = text;
  return true;
}
async function boot(refresh = false, branch = viewingBranch) {
  const id = ++bootId;
  ++loadId;
  ++sourceId;
  busy = true;
  $("#branchPicker").disabled = true;
  $("#refresh").disabled = true;
  if (!startStep("Connecting to your repository…"))
    showNotice("Loading branch…");
  try {
    await setupRepositories();
    startStep("Reading the branches…");
    const next = await api(
      "/api/repo" + (branch ? "?" + new URLSearchParams({ head: branch }) : ""),
    );
    if (id !== bootId) return;
    metadata = next;
    viewingBranch = metadata.selectedBranch?.ref || branch;
    // Each branch has its own saved Ask conversation; owner devices only.
    if (document.documentElement.dataset.access !== "reader")
      ask
        .switchTo(viewingBranch || metadata.initialHead)
        .then((changed) => changed && nav.view().name === "ask" && renderTab())
        .catch(() => {});
    // Most recent first (the server's order). A remote branch with a local copy and the
    // branches of agent tasks (the Tasks view shows those) stay out of the list, unless
    // one of them is on view.
    const picker = $("#branchPicker"),
      local = new Set(
        metadata.branches.filter((b) => !b.remote).map((b) => b.name),
      ),
      internal = /^(worktree-agent-|peekumi\/(run|session)-|strata\/run-)/;
    picker.replaceChildren();
    if (viewingPr && !metadata.selectedBranch) {
      const option = element("option", "", "Select a branch");
      option.value = "";
      option.disabled = true;
      picker.append(option);
    }
    for (const b of metadata.branches) {
      const copy = b.remote && local.has(b.name.replace(/^[^/]+\//, ""));
      if (
        (copy || internal.test(b.name)) &&
        b.ref !== metadata.selectedBranch?.ref
      )
        continue;
      const option = element(
        "option",
        "",
        b.name + (b.remote ? " · remote" : ""),
      );
      option.value = b.ref;
      picker.append(option);
    }
    if (!metadata.selectedBranch && !viewingPr) {
      const option = element(
        "option",
        "",
        "Detached · " + metadata.initialHead.slice(0, 7),
      );
      option.value = branch || "HEAD";
      picker.append(option);
    }
    picker.value = pickerValue();
    if (viewingPr && !prData) loadPrDetails();
    picker.hidden = false;
    $("#repo-sub").hidden = true;
    $("#connect").hidden = true;
    $("#workspace").inert = false;
    $("#repo-name").textContent = metadata.name;
    document.title = metadata.name + " · Peekumi";
    $("#repo-sub").textContent =
      `${metadata.branch} · ${metadata.commits.length}${metadata.moreCommits ? " recent" : ""} commits`;
    // The newest commit opens with the uncommitted changes, as a new snapshot.
    headRef = shownRevision(
      refresh || commit(headRef).worktree
        ? metadata.initialHead
        : headRef || metadata.initialHead,
    );
    baseRef = diffBase || parentRevision(headRef);
    await loadComparison();
    if (document.documentElement.dataset.access !== "reader")
      workflow.refresh(false).catch((error) => showNotice(error.message, true));
  } catch (error) {
    if (id === bootId) {
      $("#branchPicker").value = pickerValue();
      // Before the first map, the error replaces the loading view; the sheet stays clear.
      if (!startStep(error.message, true)) showNotice(error.message, true);
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
  // A pull request's merge base belongs to it; a branch goes back to its own comparison.
  if (viewingPr) {
    diffBase = null;
    const url = new URL(location.href);
    url.searchParams.delete("base");
    replaceUrl(url);
  }
  leavePr();
  setSheetHeight("peek");
  scope = rootScope();
  selected = null;
  before = false;
  await boot(true, branch);
  const url = new URL(location.href);
  if (viewingBranch) url.searchParams.set("branch", viewingBranch);
  replaceUrl(url);
}
$("#branchPicker").onchange = (event) => {
  if (!event.target.value) return;
  // A new branch starts again from the map; no explored task waits to be returned to.
  explored = null;
  nav.reset();
  switchBranch(event.target.value);
};
/** The branch list entry for what is on the map: none while a PR is open, else the branch
 * or a detached commit. */
const pickerValue = () =>
  viewingPr && !metadata?.selectedBranch ? "" : viewingBranch || "HEAD";
/** Shows one side of the Comparison panel: branches with their commits, or pull requests. */
function showViewKind(kind) {
  for (const b of document.querySelectorAll("#viewKind button"))
    b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  $("#branchView").hidden = kind !== "branch";
  $("#prView").hidden = kind !== "pr";
  if (kind === "pr") {
    renderPrRows();
    loadPrs();
  }
}
for (const b of document.querySelectorAll("#viewKind button"))
  b.onclick = () => showViewKind(b.dataset.kind);
/** A pull request's state as one word: Draft, Open, Merged or Closed. */
const prState = (pr) =>
  pr.isDraft && (pr.state || "OPEN") === "OPEN"
    ? "Draft"
    : { MERGED: "Merged", CLOSED: "Closed" }[pr.state] || "Open";
/** Lists the pull requests as rows: open ones, then recently merged ones, each with its
 * state, author and date. The PR on view has a check mark; a tap on another opens it. */
function renderPrRows() {
  const rows = $("#prRows"),
    list = prList || [],
    open = list.filter((pr) => (pr.state || "OPEN") === "OPEN"),
    merged = list.filter((pr) => pr.state === "MERGED");
  rows.replaceChildren();
  for (const [label, group] of [
    ["Open", open],
    ["Recently merged", merged],
  ]) {
    if (!group.length) continue;
    // Headings only help when both kinds are in the list.
    if (open.length && merged.length)
      rows.append(element("li", "pr-group", label));
    for (const pr of group) {
      const current = String(pr.number) === viewingPr,
        when = pr.mergedAt || pr.createdAt,
        state = element("span", "pr-state-word", prState(pr)),
        meta = element("span", "pr-pick-meta"),
        text = element("span", "pr-pick-text"),
        row = button("pr-pick", "", () =>
          current ? ($("#revisionDetails").open = false) : openPr(pr.number),
        ),
        li = element("li");
      state.dataset.state = prState(pr).toLowerCase();
      meta.append(
        state,
        [
          "",
          pr.author?.login,
          when &&
            new Date(when).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            }),
        ]
          .filter(
            (part) => part !== undefined && part !== null && part !== false,
          )
          .join(" · "),
      );
      text.append(
        element("span", "pr-pick-title", `#${pr.number} ${pr.title}`),
        meta,
      );
      row.append(text);
      if (current) row.append(glyph("check"));
      row.setAttribute("aria-pressed", String(current));
      li.append(row);
      rows.append(li);
    }
  }
  if (prList && !list.length)
    $("#prNote").textContent = "No open or recently merged pull requests.";
}
/** Loads open PRs, then up to 10 merged ones, each time the Comparison panel opens, so
 * new PRs appear. Without the GitHub CLI or access the View list shows branches only.
 * Read-only devices cannot fetch a PR, so they do not see the list. */
let prLoad = null;
async function loadPrs() {
  if (prLoad || document.documentElement.dataset.access === "reader") return;
  prLoad = api("/api/prs");
  if (!prList) $("#prNote").textContent = "Loading pull requests…";
  try {
    const all = await prLoad;
    prList = [
      ...all.filter((pr) => (pr.state || "OPEN") === "OPEN"),
      ...all.filter((pr) => pr.state === "MERGED").slice(0, 10),
    ];
    $("#prNote").textContent = "";
    renderPrRows();
  } catch (error) {
    // Usually GitHub CLI is missing or not signed in on the host; the message says how.
    if (!prList) $("#prNote").textContent = error.message;
  } finally {
    prLoad = null;
  }
}
$("#revisionDetails").addEventListener("toggle", (event) => {
  if (event.target.open) showViewKind(viewingPr ? "pr" : "branch");
});
/** Reads the open PR's details again after a reload; the comparison itself is in the URL. */
async function loadPrDetails() {
  const number = viewingPr;
  try {
    const pr = await api("/api/prs/" + number);
    if (viewingPr !== number) return;
    prData = pr;
    render();
  } catch {
    /* The map still shows the PR's changes; the sheet keeps the repository view. */
  }
}
/** Fetches a PR into private refs and shows its changes: merge base → head. The checkout
 * stays unchanged, and nothing is sent to GitHub. */
async function openPr(number) {
  const rows = $("#prRows");
  rows.inert = true;
  $("#prNote").textContent = `Fetching PR #${number}…`;
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
    explored = null;
    nav.reset();
    headRef = data.head;
    diffBase = data.base;
    baseRef = data.base;
    viewingPr = String(number);
    prData = data.pr;
    prExpanded = false;
    setSheetHeight("peek");
    $("#revisionDetails").open = false;
    await boot(true, data.head);
    const url = new URL(location.href);
    url.searchParams.set("branch", data.head);
    url.searchParams.set("base", data.base);
    url.searchParams.set("pr", viewingPr);
    replaceUrl(url);
    $("#prNote").textContent = "";
    renderPrRows();
  } catch (e) {
    $("#prNote").textContent = e.message;
  } finally {
    rows.inert = false;
  }
}
/** Leaves the pull request and goes back to the checkout's own branch. */
function closePr() {
  const url = new URL(location.href);
  url.searchParams.delete("branch");
  replaceUrl(url);
  switchBranch(null);
}
/** Lists registered local checkouts; reload on switching prevents cross-repository task or source state. */
async function setupRepositories() {
  const data = await api("/api/repositories");
  document.documentElement.dataset.access = data.role;
  // A read-only device has no Tasks, Conversations or dock, and says so once, quietly. Both
  // ways: an owner link opened in a read-only tab brings them back.
  const reader = data.role === "reader";
  if (reader && !$(".access-note"))
    $(".title-block")?.append(
      element("span", "access-note", "Read-only device"),
    );
  if (!reader) $(".access-note")?.remove();
  $("#openTasks").hidden = reader;
  $("#openConversations").hidden = reader;
  $("#conversationDock").hidden = reader;
  // Opening a PR fetches refs, which a read-only device cannot do.
  $("#viewKind").hidden = reader;
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
  if (!startStep("Reading the repository structure…"))
    showNotice("Loading this comparison…");
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
      startStep("Reading the relationships…");
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
    // The first map is drawn: the review sheet appears with it.
    delete document.documentElement.dataset.starting;
    if (scope.kind === "file") loadSource();
  } catch (error) {
    if (id === loadId) {
      busy = false;
      if (!startStep(error.message, true)) showNotice(error.message, true);
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
/** Builds the map's level controls: Home and Up as icon buttons, plus the current level
 * announced to assistive technology. The sheet names the scope visibly. */
function breadcrumbs() {
  const nav = element("nav", "crumbs map-group");
  nav.setAttribute("aria-label", "Level");
  const atRoot = scope.kind === "repo",
    upTo = atRoot ? null : parent(scope.path) || metadata.name;
  const home = iconButton(
    button("crumb-home", "", () => navigate(rootScope())),
    "home",
    "Repository root · " + metadata.name,
  );
  home.append(element("span", "visually-hidden", metadata.name));
  const up = iconButton(
    button("back", "", goUp),
    "up",
    atRoot ? "Already at the repository root" : "Up to " + upTo,
  );
  home.disabled = up.disabled = atRoot;
  const current = element(
    "span",
    "visually-hidden",
    atRoot
      ? metadata.name
      : scope.kind === "rootfiles"
        ? "Repository files"
        : leaf(scope.path),
  );
  current.setAttribute("aria-current", "page");
  nav.append(home, up, current);
  return nav;
}
/** Renders the active map with its floating controls: level navigation and tools along the bottom, Before/After in the top-left corner. */
/** True when the next map drawing should give the keyboard focus to its first card: the
 * owner opened a level with the keyboard. */
let focusFirstCard = false;
function renderDeck() {
  const deck = $("#deck"),
    oldScroll =
      deck.querySelector(".sheet:not(.peek) .sheet-body")?.scrollTop || 0;
  // A card with the keyboard focus keeps it across the redraw (a new element, same key).
  const focusedKey =
    document.activeElement?.closest?.("#deck .node")?.dataset.key;
  const mapLegend = $("#mapLegend"),
    sides = $("#baSeg"),
    crumbHost = $("#crumbHost");
  crumbHost.replaceChildren(breadcrumbs());
  deck.replaceChildren();
  const sheet = element("div", "sheet");
  sheet.style.zIndex = "10";
  sheet.dataset.front = "true";
  const body = element("div", "sheet-body");
  sheet.append(body);
  deck.append(sheet);
  renderGraph(body);
  // The map was drawn again: mark the agents' places again.
  focus.redraw();
  workflow.cueLive();
  body.querySelector(".map-tools")?.append(mapLegend);
  body.querySelector(".canvas-controls")?.prepend(crumbHost);
  // Before/After belongs to the comparison, not navigation: it sits in the top-left corner.
  body.append(sides);
  body.scrollTop = oldScroll;
  const cards = [...body.querySelectorAll(".node")];
  const again = focusFirstCard
    ? cards[0]
    : focusedKey && cards.find((n) => n.dataset.key === focusedKey);
  focusFirstCard = false;
  again?.focus({ preventScroll: true });
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
/** True when the map shows uncommitted changes and `node` has some: a file that the owner
 * changed, a folder with such a file, or the repository files at the top. */
function uncommittedMark(node) {
  const paths = uncommittedPaths();
  if (!paths) return false;
  if (node.kind === "file") return paths.includes(node.path);
  if (node.kind === "folder")
    return paths.some((p) => p.startsWith(node.path + "/"));
  if (node.kind === "rootfiles") return paths.some((p) => !p.includes("/"));
  return false;
}
/** The rule breaks that `node` causes, one for each broken rule on each relationship that
 * starts in it: `{rule, message, target, kind, count}`, on the shown side of the comparison.
 * The map's overview merges the relationships between two files into one pair, so `count` is
 * how many relationships the entry stands for. For a selected relationship (an edge between
 * two cards), the breaks from its source card to its target card. */
function nodeBreaks(node) {
  const edge = node.kind === "edge";
  const from = edge ? node.from : node;
  const inside = (end, path) =>
    end.kind === "rootfiles"
      ? !path.includes("/")
      : path === end.path || path.startsWith(end.path + "/");
  return nodeRelations(from).flatMap((r) => {
    const fact = r[before ? "before" : "after"];
    if (!fact || !startsIn(from, fact.source)) return [];
    const target = fact.targets?.[0]?.path || "";
    const kind = r.kind || fact.kind;
    if (edge && (kind !== node.relationshipKind || !inside(node.to, target)))
      return [];
    return fact.violations.map((v) => ({
      rule: v.id,
      message: v.message,
      source: fact.source.path,
      target,
      kind,
      count: fact.count || 1,
    }));
  });
}
/** `n` relationships of `kind` in words: "1 call", "6 calls", "2 imports". */
function kindCount(n, kind) {
  const nouns = {
    calls: ["call", "calls"],
    imports: ["import", "imports"],
    implements: ["implementation", "implementations"],
    inherits: ["inheritance", "inheritances"],
  }[kind] || ["relationship", "relationships"];
  return `${n} ${nouns[n === 1 ? 0 : 1]}`;
}
/** One line for the sheet about `breaks` (see nodeBreaks): the rule, or how many rules, and
 * what breaks it, for example "Breaks ui-no-db · 3 calls to store.py". */
function breaksLine(breaks) {
  const rules = [...new Set(breaks.map((b) => b.rule))];
  const targets = [...new Set(breaks.map((b) => b.target))];
  const kinds = [...new Set(breaks.map((b) => b.kind))];
  const n = breaks.reduce((sum, b) => sum + b.count, 0);
  const nouns = {
    calls: ["call", "calls", "to"],
    imports: ["import", "imports", "of"],
    implements: ["implementation", "implementations", "of"],
    inherits: ["inheritance", "inheritances", "from"],
  };
  const noun = kinds.length === 1 && nouns[kinds[0]];
  const what =
    noun && targets.length === 1
      ? `${n} ${noun[n === 1 ? 0 : 1]} ${noun[2]} ${targets[0].split("/").pop()}`
      : `${n} relationship${n === 1 ? "" : "s"}`;
  return rules.length === 1
    ? `Breaks ${rules[0]} · ${what}`
    : `Breaks ${rules.length} rules · ${what}`;
}
/** True when a relationship that starts at `source` starts in `node`. */
const startsIn = (node, source) =>
  node.kind === "symbol"
    ? source.path === scope.path && source.symbol === node.name
    : node.kind === "rootfiles"
      ? !source.path.includes("/")
      : source.path === node.path || source.path.startsWith(node.path + "/");
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
  // Start below the top-left Before/After control.
  let y = 56;
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
    // Rows leave room for a line to turn between them and run straight into its arrowhead.
    list.forEach((node, index) =>
      positions.set(node.key, {
        node,
        x: 16 + (index % cols) * (w + 9),
        y: y + Math.floor(index / cols) * 62,
        w,
        h: 36,
      }),
    );
    y += Math.ceil(list.length / cols) * 62 + 4;
  }
  /** Lays `list` out in a compact grid at `top` and returns its bottom edge. Space opens
   * only where a drawn line needs it, and only in that card's column: a gap a line turns
   * through grows enough for a straight run into its arrowhead, so each column is spaced
   * on its own. The gap between columns widens when neighbours in a row are connected,
   * so their arrow can run straight across. */
  function placeGrid(list, { cols, left, span, h, top }) {
    const GAP = 12,
      ROOM = 26;
    const rowOf = new Map(list.map((n, i) => [n.key, Math.floor(i / cols)])),
      colOf = new Map(list.map((n, i) => [n.key, i % cols])),
      above = new Set(root ? [] : incoming.map((n) => n.key)),
      shown = new Set([
        ...rowOf.keys(),
        ...above,
        ...(root ? [] : outgoing.map((n) => n.key)),
        "boundary",
      ]),
      rowFor = (key) =>
        rowOf.has(key) ? rowOf.get(key) : above.has(key) ? -1 : Infinity,
      roomy = new Set(),
      room = (key, row) => roomy.add(colOf.get(key) + ":" + row);
    let across = false;
    for (const e of visibleEdges((key) => shown.has(key))) {
      const a = rowFor(e.from.key),
        b = rowFor(e.to.key);
      if (a === b) {
        if (Math.abs(colOf.get(e.from.key) - colOf.get(e.to.key)) === 1)
          across = true;
        else {
          // Further apart in a row: the line dips under both cards.
          room(e.from.key, a);
          room(e.to.key, b);
        }
        continue;
      }
      const down = b > a;
      for (const [key, leaving] of [
        [e.from.key, true],
        [e.to.key, false],
      ])
        if (rowOf.has(key))
          // Leaving downwards or arriving from below uses the gap under the card.
          room(
            key,
            (leaving ? down : !down) ? rowOf.get(key) : rowOf.get(key) - 1,
          );
    }
    // Connected neighbours need room for an S between their middles plus a straight tail.
    const colGap = across ? 32 : GAP,
      w = (span - (cols - 1) * colGap) / cols;
    // Each column moves down on its own; an arrow between neighbours curves to fit.
    const next = Array(cols).fill(top),
      rows = Math.ceil(list.length / cols);
    for (let row = 0; row < rows; row++)
      list.slice(row * cols, row * cols + cols).forEach((node, c) => {
        positions.set(node.key, {
          node,
          x: left + c * (w + colGap),
          y: next[c],
          w,
          h,
        });
        next[c] += h + (roomy.has(c + ":" + row) ? ROOM : GAP);
      });
    return Math.max(top, ...next.map((y) => y - GAP));
  }
  if (!root) stubRow(incoming, "Depended on by");
  let emptyTop = null;
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
    const cols = Math.min(current.length || 1, graphWidth < 540 ? 2 : 3);
    y =
      placeGrid(current, {
        cols,
        left: 16,
        span: graphWidth - 32,
        h: 108,
        top: y,
      }) + 20;
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
    const single = isFile && cols === 1;
    if (current.length)
      y =
        placeGrid(current, {
          cols,
          left: single ? 28 : 21,
          span: single ? graphWidth - 74 : graphWidth - 42,
          h: isFile ? 46 : 108,
          top: y,
        }) + 20;
    else {
      emptyTop = y;
      y += 150;
    }
    if (scope.kind === "file") positions.get("boundary").h = y - boundaryTop;
  }
  if (!current.length) {
    const message = element(
      "div",
      "map-empty",
      fileWithheld()
        ? fileWithheld()
        : scope.kind === "file" && !sourceData
          ? "Loading symbols…"
          : changesOnly
            ? "No changed symbols or items here. Open Source for file-level changes, or turn off Changes only."
            : scope.kind === "file"
              ? "No extracted symbols. Open Source to inspect the complete file."
              : "No items in this revision.",
    );
    message.prepend(
      peek(scope.kind === "file" && !sourceData ? "loading" : "empty"),
    );
    Object.assign(message.style, {
      position: "absolute",
      top: (emptyTop ?? y) + "px",
      left: "16px",
      width: graphWidth - 32 + "px",
    });
    canvas.append(message);
    if (emptyTop === null) y += 135;
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
  // Leave room to scroll the last row clear of the floating map controls.
  const height = Math.max(available, y + 64);
  canvas.style.width = graphWidth + "px";
  canvas.style.height = height + "px";
  drawEdges(canvas, positions, graphWidth, height, false);
  // A method's card drops its class's name when that class has a card on this level.
  const owners = new Set(
    current.filter((n) => n.kind === "symbol").map((n) => n.name),
  );
  for (const p of positions.values()) canvas.append(graphNode(p, owners));
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
    // The top level sits in the middle of the visible map; a folder starts at its top.
    { contentHeight: y, center: root },
  );
}
/** Fills `host` with `name` and lets it wrap after a dot, a slash, a hyphen or an underscore,
 * and before a capital letter inside a word, so a long name takes a second line at its
 * parts and not at a random letter. Returns `host`. */
function breakable(host, name) {
  const parts = name.split(/(?<=[._/-])|(?<=[a-z0-9])(?=[A-Z])/);
  parts.forEach((part, i) => {
    if (i) host.append(document.createElement("wbr"));
    host.append(part);
  });
  return host;
}
/** Creates an accessible map card with status, preview metadata and select-then-open behavior. */
function graphNode({ node, x, y, w, h }, owners = new Set()) {
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
    linkedKeys && node.kind !== "boundary" && selected?.key !== node.key
      ? linkedKeys.has(node.key)
        ? "linked"
        : "faded"
      : "",
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
  // Uncommitted changes in it: a dashed outline (see uncommittedMark).
  if (uncommittedMark(node)) card.dataset.uncommitted = "true";
  card.dataset.relationshipChanged = String(
    nodeRelations(node).some((r) => r.status !== "unchanged"),
  );
  const changedFiles =
    node.files?.filter((f) => f.status !== "unchanged").length || 0;
  card.setAttribute(
    "aria-label",
    `${node.name}, ${node.symbolKind || node.targetKind || node.kind}${node.status ? ", " + labels[node.status] : ""}${card.dataset.uncommitted ? ", uncommitted changes" : ""}${node.changes?.length ? ": " + partWords(node.changes) : ""}${node.files ? `, ${changedFiles} of ${node.files.length} files changed` : ""}`,
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
  const owner =
    node.kind === "symbol"
      ? node.name.slice(0, node.name.lastIndexOf("."))
      : "";
  const shown =
    owner && owners.has(owner) ? node.name.slice(owner.length + 1) : node.name;
  top.append(
    breakable(
      element("span", "n-name"),
      shown +
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
  // Which parts of a modified declaration changed: signature, documentation, implementation.
  if (lens === "changes" && node.changes?.length) {
    const parts = element("span", "n-parts");
    parts.append(...node.changes.map(partIcon));
    top.append(parts);
  }
  // Rule breaks: a red broken-link icon and how many, in the card's own row (no badge).
  const found = nodeBreaks(node);
  const total = found.reduce((sum, b) => sum + b.count, 0);
  if (total) {
    const breaks = element("span", "n-breaks");
    breaks.append(glyph("broken"), document.createTextNode(total));
    breaks.title = [...new Set(found.map((b) => b.message))].join("; ");
    breaks.setAttribute(
      "aria-label",
      `${total} dependency rule break${total === 1 ? "" : "s"}`,
    );
    top.append(breaks);
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
/** The connections the map draws among the cards `placed` reports as shown: filtered by
 * Changes only, the Before/After side and the colour lens, narrowed to the selection when
 * there are many, and with calls hidden in a busy file unless they touch the selection. */
function visibleEdges(placed) {
  let drawable = edges.filter(
    (e) =>
      (!changesOnly || e.status !== "unchanged") &&
      placed(e.from.key) &&
      placed(e.to.key) &&
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
  return drawable.slice(0, 40);
}
/** Plans one curved path per edge between positioned cards. Every line leaves and arrives
 * through a card's top or bottom edge, from the open gap between rows, so its arrowhead has
 * room and is never squeezed into the narrow gap between columns. Lines sharing a card edge
 * get their own ports, ordered by where they head, and end just short of the card so the
 * arrowhead stays clear of its border. A line whose direct curve would cross another card is
 * routed around it: into the row gap, along the nearest gap between columns, and back.
 * Returns SVG path data in edge order. */
function routeEdges(list, positions, width) {
  // Lines stop just short of their target so the arrowhead clears its border, and end with a
  // straight run longer than the arrowhead.
  const CLEAR = 2,
    TAIL = 12;
  const cards = [...positions.entries()]
    .filter(([key]) => key !== "boundary")
    .map(([key, r]) => ({ key, ...r }));
  const mid = (r) => r.x + r.w / 2;
  const overlaps = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w;
  // The free space above and below a card, up to the next card in its column.
  const gap = (r, below) => {
    const limits = cards
      .filter((c) => c !== r && overlaps(c, r))
      .map((c) => (below ? c.y - (r.y + r.h) : r.y - (c.y + c.h)))
      .filter((d) => d >= 0);
    return Math.max(10, Math.min(36, ...limits, below ? 36 : r.y));
  };
  // Vertical channels: the gaps between card columns, then the outer margins.
  const lanes = [
    ...new Map(
      cards.filter((r) => r.w < width * 0.6).map((r) => [Math.round(r.x), r]),
    ).values(),
  ].sort((p, q) => p.x - q.x);
  const channels = [];
  for (let i = 1; i < lanes.length; i++) {
    const left = lanes[i - 1].x + lanes[i - 1].w;
    if (lanes[i].x - left >= 6)
      channels.push({ x: (left + lanes[i].x) / 2, room: lanes[i].x - left });
  }
  if (lanes.length) {
    channels.push({ x: Math.max(4, lanes[0].x / 2), room: lanes[0].x });
    const last = lanes.at(-1),
      right = last.x + last.w;
    channels.push({
      x: Math.min(width - 4, (right + width) / 2),
      room: width - right,
    });
  }
  const bezier = ([p0, p1, p2, p3], t) => {
    const u = 1 - t;
    return [0, 1].map(
      (i) =>
        u * u * u * p0[i] +
        3 * u * u * t * p1[i] +
        3 * u * t * t * p2[i] +
        t * t * t * p3[i],
    );
  };
  const crosses = (from, to, points) =>
    cards.some(
      (r) =>
        r.key !== from &&
        r.key !== to &&
        points.some(
          ([x, y]) =>
            x > r.x + 2 &&
            x < r.x + r.w - 2 &&
            y > r.y + 2 &&
            y < r.y + r.h - 2,
        ),
    );
  const edgeY = (e, arriving) => {
    const top = e.side === "top";
    const y = top ? e.r.y : e.r.y + e.r.h;
    return arriving ? y + (top ? -CLEAR : CLEAR) : y;
  };
  const rounded = (points, radius) => {
    const pts = points.filter(
      (p, i) =>
        i === 0 ||
        Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.5,
    );
    let d = `M${pts[0]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
      const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]),
        l2 = Math.hypot(n[0] - c[0], n[1] - c[1]),
        r = Math.min(radius, l1 / 2, l2 / 2);
      const into = [
          c[0] + ((p[0] - c[0]) * r) / l1,
          c[1] + ((p[1] - c[1]) * r) / l1,
        ],
        out = [
          c[0] + ((n[0] - c[0]) * r) / l2,
          c[1] + ((n[1] - c[1]) * r) / l2,
        ];
      d += ` L${into} Q${c} ${out}`;
    }
    return d + ` L${pts.at(-1)}`;
  };
  /** Points every few pixels along a polyline, for checking what it passes through. */
  const along = (points) =>
    points.slice(1).flatMap((q, i) => {
      const p = points[i],
        n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 6));
      return Array.from({ length: n - 1 }, (_, k) => [
        p[0] + ((q[0] - p[0]) * (k + 1)) / n,
        p[1] + ((q[1] - p[1]) * (k + 1)) / n,
      ]);
    });
  /** The corners of a route around cards: into the gap beside the source, along the channel
   * at `gx`, and into the gap beside the target, then straight into its arrowhead. The turn
   * by the source stays inside its gap, whatever the line's place in the channel. */
  const lanePoints = (plan, gx, offset = 0) => {
    const [from, to] = plan.ends,
      dir = plan.down ? 1 : -1;
    const x = from.at,
      y = edgeY(from, false),
      x2 = to.at,
      y2 = edgeY(to, true);
    const g = gap(from.r, plan.down),
      ys = y + dir * Math.min(g - 3, g * 0.3 + Math.abs(offset) * 0.4);
    const room = gap(to.r, !plan.down),
      yt = y2 - dir * Math.min(room - 3, Math.max(room * 0.6, TAIL + 5));
    return [
      [x, y],
      [x, ys],
      [gx, ys],
      [gx, yt],
      [x2, yt],
      [x2, y2],
    ];
  };
  const end = (key, r, side, toward) => ({ key, r, side, toward });
  // Plan each line's shape and which card edges it uses; ports are placed afterwards.
  const plans = list.map((edge) => {
    const a = positions.get(edge.from.key),
      b = positions.get(edge.to.key);
    // Columns are spaced independently, so cards in one row may sit slightly apart. Any
    // vertical overlap makes them side by side: a vertical route would have to double back.
    const shared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
      level = shared > 0;
    // Neighbours in a row, with room between them: an arrow across, from the middle of the
    // source's side to the middle of the target's side. Level cards get a straight line; a
    // card set lower gets an S that stays in the gap between them, so it touches no card.
    if (level) {
      const right = b.x > a.x,
        from = right ? a.x + a.w : a.x,
        to = right ? b.x : b.x + b.w,
        // Opposite arrows between the same two cards sit just apart; a lone one is centred.
        apart = list.some(
          (o) => o.from.key === edge.to.key && o.to.key === edge.from.key,
        )
          ? right
            ? -4
            : 4
          : 0,
        y1 = a.y + a.h / 2 + apart,
        y2 = b.y + b.h / 2 + apart,
        between = cards.some(
          (c) =>
            c.y < Math.max(y1, y2) &&
            c.y + c.h > Math.min(y1, y2) &&
            c.x < Math.max(from, to) &&
            c.x + c.w > Math.min(from, to),
        );
      if (!between && Math.abs(to - from) >= 20)
        return {
          kind: "across",
          from,
          to: to + (right ? -CLEAR : CLEAR),
          y1,
          y2,
          ends: [],
        };
      // Otherwise a short dip through the gap below both cards.
      return {
        kind: "row",
        ends: [
          end(edge.from.key, a, "bottom", mid(b)),
          end(edge.to.key, b, "bottom", mid(a)),
        ],
      };
    }
    const down = b.y > a.y;
    return {
      kind: "direct",
      down,
      a,
      b,
      ends: [
        end(edge.from.key, a, down ? "bottom" : "top", mid(b)),
        end(edge.to.key, b, down ? "top" : "bottom", mid(a)),
      ],
    };
  });
  /** Spreads the ports on each card edge, ordered by where each line heads. Ends that reach
   * the same card side through the same channel share a port, so they share an arrowhead. */
  function placePorts() {
    const sides = new Map(),
      ports = new Map();
    for (const plan of plans)
      for (const e of plan.ends) {
        e.port = null;
        if (plan.kind === "lane") {
          const port = `${e.key}:${e.side}:${plan.lane.x}`;
          if (ports.has(port)) {
            e.port = ports.get(port);
            continue;
          }
          ports.set(port, e);
        }
        const id = e.key + ":" + e.side;
        if (!sides.has(id)) sides.set(id, []);
        sides.get(id).push(e);
      }
    for (const group of sides.values()) {
      group.sort((p, q) => p.toward - q.toward);
      const n = group.length,
        step = n > 1 ? Math.min(0.16, 0.64 / (n - 1)) : 0;
      group.forEach(
        (e, i) => (e.at = e.r.x + e.r.w * (0.5 + (i - (n - 1) / 2) * step)),
      );
    }
    for (const plan of plans)
      for (const e of plan.ends) if (e.port) e.at = e.port.at;
  }
  /** Sends a line around the cards between its ends, through the cheapest channel whose
   * route crosses no card; the cheapest overall when none is clear. */
  function goAround(plan) {
    const [ax, bx] = [mid(plan.a), mid(plan.b)];
    const ranked = [...channels].sort(
      (p, q) =>
        Math.abs(p.x - ax) +
        Math.abs(p.x - bx) -
        (Math.abs(q.x - ax) + Math.abs(q.x - bx)),
    );
    const [from, to] = plan.ends;
    plan.kind = "lane";
    plan.lane =
      ranked.find(
        (c) => !crosses(from.key, to.key, along(lanePoints(plan, c.x))),
      ) || ranked[0];
    for (const e of plan.ends) e.toward = plan.lane.x;
  }
  // Check each straight route with its real ports (a wide card spreads them far apart); a
  // route that crosses a card goes around instead, and ports are placed again.
  for (let pass = 0; pass < 3 && channels.length; pass++) {
    placePorts();
    let moved = false;
    for (const plan of plans) {
      if (plan.kind !== "direct") continue;
      const [from, to] = plan.ends,
        y = edgeY(from, false),
        y2 = edgeY(to, true),
        half = (y + y2) / 2;
      const curve = [
        [from.at, y],
        [from.at, half],
        [to.at, half],
        [to.at, y2],
      ];
      const sample = Array.from({ length: 31 }, (_, i) =>
        bezier(curve, (i + 1) / 32),
      );
      if (crosses(from.key, to.key, sample)) {
        goAround(plan);
        moved = true;
      }
    }
    if (!moved) break;
  }
  placePorts();
  // Lines going around to the same card share one trunk in the channel and one arrowhead;
  // trunks to different cards sit side by side.
  const lanesUsed = new Map(),
    trunks = new Map();
  for (const plan of plans)
    if (plan.kind === "lane") {
      const trunk = plan.lane.x + ">" + plan.ends[1].key;
      if (!trunks.has(trunk)) {
        const n = lanesUsed.get(plan.lane) || 0;
        lanesUsed.set(plan.lane, n + 1);
        // Side by side while the channel has room; past its edges they share the middle.
        const step = Math.min(5, Math.max(2, (plan.lane.room - 4) / 4)),
          limit = Math.max(0, plan.lane.room / 2 - 3),
          spread = Math.ceil(n / 2) * step;
        trunks.set(trunk, spread > limit ? 0 : (n % 2 ? 1 : -1) * spread);
      }
      plan.offset = trunks.get(trunk);
    }
  return plans.map((plan) => {
    if (plan.kind === "across") {
      const { from, to, y1, y2 } = plan;
      if (Math.abs(y1 - y2) < 1) return `M${from},${y1} L${to},${y1}`;
      // A gentle S between the two middles, then straight into the arrowhead.
      const dir = Math.sign(to - from),
        tail = Math.min(TAIL, Math.abs(to - from) / 2),
        bend = to - dir * tail,
        middle = (from + bend) / 2;
      return `M${from},${y1} C${middle},${y1} ${middle},${y2} ${bend},${y2} L${to},${y2}`;
    }
    const [from, to] = plan.ends;
    const x = from.at,
      y = edgeY(from, false),
      x2 = to.at,
      y2 = edgeY(to, true);
    // The last stretch is straight, so the line meets the arrowhead's point along its axis
    // instead of cutting across one of its arms.
    if (plan.kind === "row") {
      const dip = Math.min(gap(from.r, true), gap(to.r, true)) * 0.85,
        tail = Math.min(TAIL, dip * 0.6);
      return `M${x},${y} C${x},${y + dip} ${x2},${y2 + dip} ${x2},${y2 + tail} L${x2},${y2}`;
    }
    if (plan.kind === "direct") {
      const sign = Math.sign(y2 - y),
        tail = Math.min(TAIL, Math.abs(y2 - y) / 2),
        end = y2 - sign * tail,
        half = (y + end) / 2;
      return `M${x},${y} C${x},${half} ${x2},${half} ${x2},${end} L${x2},${y2}`;
    }
    // Into the row gap beside each end, then along the channel between them, with wide
    // curves at the turns: a curved line is easier to follow than a sharp elbow.
    return rounded(
      lanePoints(plan, plan.lane.x + plan.offset, plan.offset),
      14,
    );
  });
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
    out: "var(--accent)",
    in: "var(--link-in)",
  })) {
    const marker = document.createElementNS(NS, "marker");
    marker.id = "arrow-" + status;
    // The same chevron at one size for every line, so a thicker highlighted line never
    // gets a head longer than the straight run that leads into it.
    for (const [key, value] of Object.entries({
      viewBox: "0 0 10 10",
      refX: 8.5,
      refY: 5,
      markerUnits: "userSpaceOnUse",
      markerWidth: 11,
      markerHeight: 11,
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
  const drawable = visibleEdges((key) => positions.has(key));
  // A level with many lines draws its unchanged ones fainter, and a selection keeps only its
  // own lines clear: the owner reads one card's lines at a time.
  svg.classList.toggle("dense", drawable.length > 14);
  // A selected card emphasises its own connections by direction and quiets the rest; a
  // selected line does the same for its two ends.
  const focus = selected && selected.kind !== "edge" ? selected.key : null;
  linkedKeys = selected ? new Set() : null;
  for (const edge of drawable)
    if (
      selected &&
      (edge.key === selected.key ||
        edge.from.key === focus ||
        edge.to.key === focus)
    )
      linkedKeys.add(edge.from.key).add(edge.to.key);
  // With nothing connected there is nothing to emphasise, so keep the full context visible.
  if (!linkedKeys?.size) linkedKeys = null;
  const routes = arcs ? null : routeEdges(drawable, positions, width);
  for (const [index, edge] of drawable.entries()) {
    const a = positions.get(edge.from.key),
      b = positions.get(edge.to.key);
    let d;
    if (routes) d = routes[index];
    else if (arcs) {
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
    const direction = !focus
      ? null
      : edge.from.key === focus
        ? "out"
        : edge.to.key === focus
          ? "in"
          : null;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.dataset.from = edge.from.key;
    path.dataset.to = edge.to.key;
    path.setAttribute(
      "class",
      "e " +
        edge.relationshipKind +
        " " +
        (status === "unchanged" ? "quiet" : status) +
        (selected?.key === edge.key
          ? " sel hl"
          : direction
            ? " hl " + direction
            : linkedKeys
              ? " dim"
              : ""),
    );
    path.setAttribute(
      "marker-end",
      `url(#arrow-${direction && status !== "violation" ? direction : status})`,
    );
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
  held = null;
  workflow.ownerMoved();
  // A list or a task gives way to the map (Back returns to it); a conversation stays, and
  // the selection becomes the subject of its next message.
  if (nav.view().name !== "inspect" && !onThread()) nav.toMap();
  if (node.kind === "symbol") {
    sourceView = node.status === "removed" ? "before" : "diff";
  }
  if (!markSelection(node)) renderDeck();
  renderPanel();
  if (scope.kind === "file" && !sourceData) loadSource();
}
/** On a large map, a selection that changes no line only moves the selected mark between two
 * cards: drawing thousands of cards again would block the page for seconds. True when it
 * did so; false when the map must be drawn again. */
function markSelection(node) {
  if (nodes.length < 300 || node.kind === "edge") return false;
  const sheet = document.querySelector('.sheet[data-front="true"]');
  const lines = sheet?.querySelectorAll("path[data-from]").length || 0;
  if (!sheet || lines || visibleEdges(() => true).length) return false;
  const card = [...sheet.querySelectorAll(".node[data-key]")].find(
    (n) => n.dataset.key === node.key,
  );
  if (!card) return false;
  sheet.querySelectorAll(".node.sel").forEach((n) => n.classList.remove("sel"));
  card.classList.add("sel");
  linkedKeys = null;
  return true;
}
/** Follow: shows the place `{path, symbol?}` that an agent works on: inside the file for a
 * declaration, else the folder that holds it (the nearest one that exists at this
 * comparison). The panel keeps its view. */
async function followTo(place) {
  const files = comparison?.files || [];
  const path = place.path.replace(/\/$/, "");
  const isFile = files.some((f) => f.path === path);
  let next;
  if (isFile && place.symbol) next = { kind: "file", path };
  else {
    let dir = isFile ? path.split("/").slice(0, -1).join("/") : path;
    while (dir && !files.some((f) => f.path.startsWith(dir + "/")))
      dir = dir.split("/").slice(0, -1).join("/");
    next = dir ? { kind: "folder", path: dir } : rootScope();
  }
  if (next.kind === scope.kind && next.path === scope.path) return;
  await navigate(next, "", { keepTab: true, follow: true });
}
/** Shows a place that a message names: the map moves there and selects it, while the
 * conversation stays in view. `keepTab` keeps the sheet's view as it is. */
async function openPlace(target, { keepTab = false } = {}) {
  if (busy) return;
  if (mode === "diff") before = target.side === "before";
  await navigate({ kind: "file", path: target.path }, "file:" + target.path, {
    keepTab,
  });
  if (target.kind === "symbol") {
    refreshModel();
    selected =
      nodes.find((n) => n.kind === "symbol" && n.name === target.symbol) ||
      null;
  }
  if ($("#panel").dataset.height === "full") setSheetHeight("half");
  render();
  // The place opens in the middle of the map, never at its edge.
  requestAnimationFrame(() => {
    const card = document.querySelector('.sheet[data-front="true"] .node.sel');
    card?.closest(".map-canvas")?.centerCard?.(card);
  });
}
/* The context menu (menu.js): what a long press or a right-click offers for a map card or a
 * name in a conversation. Each action uses the same path as the app's own controls. */
/** Brings the dock's input into focus, for an action that starts a message. */
function focusComposer() {
  requestAnimationFrame(() =>
    $("#composerHost textarea")?.focus({ preventScroll: true }),
  );
}
/** Copies `text`, and says so. */
function copyText(text) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => {
      showNotice(`Copied ${text}`);
      setTimeout(() => showNotice(""), 1600);
    })
    .catch(() => showNotice("This browser does not allow copying here", true));
}
/** Selects `node` and opens the dock in `mode` (ask, comments or session) about it. In
 * session mode the selection is the pointer that the next reply carries. */
/** Starts an instruction, about relationship `edge`, that asks for a dependency rule which
 * forbids it: a folder becomes `folder/**`, the repository's top-level files `*`, and a file
 * or a declaration its file's path. The owner can edit the text before saving it. */
function forbid(edge) {
  const group = (end) =>
    end.kind === "folder"
      ? `${end.path}/**`
      : end.kind === "rootfiles"
        ? "*"
        : end.path;
  const kind = edge.relationshipKind;
  workflow.prefill(
    `Add a rule to .peekumi.json that forbids ${kind} from ${group(edge.from)} to ${group(edge.to)}, with a message that says why. Then fix the code that breaks the new rule, or list it in your report.`,
  );
  composeAbout(edge, "comments");
}
function composeAbout(node, mode) {
  selectNode(node);
  dockMode = mode;
  // The conversation for this mode, when it is on screen, stays: the card becomes the subject
  // of its next message (Ask's question, or the session's reply). Anything else writes from
  // the map's dock.
  const view = nav.view();
  const stays =
    mode === "ask"
      ? view.name === "ask"
      : mode === "session" && view.name === "run" && workflow.isLive(view.id);
  if (!stays) nav.toMap();
  renderPanel();
  focusComposer();
}
/** The menu for map card `node`. */
function cardMenu(node) {
  const symbol = node.kind === "symbol";
  const files = node.files || [];
  const items = [
    symbol
      ? {
          label: "Source",
          icon: "source",
          key: "Enter",
          run: () => (selectNode(node), openNode(node)),
        }
      : {
          label: "Open",
          icon: "forward",
          key: "Enter",
          run: () => openNode(node),
        },
    // Ask, instructions and sessions belong to owner devices.
    ...(isOwner()
      ? [
          {
            label: "Ask about this",
            icon: "ask",
            key: "A",
            run: () => composeAbout(node, "ask"),
          },
          {
            label: "Add instruction",
            icon: "comment",
            key: "I",
            run: () => composeAbout(node, "comments"),
          },
          workflow.hasLiveSession()
            ? {
                label: "Point the agent here",
                icon: "pin",
                key: "S",
                accent: true,
                run: () => composeAbout(node, "session"),
              }
            : {
                label: "Start a session here",
                icon: "session",
                key: "S",
                run: () => composeAbout(node, "session"),
              },
        ]
      : []),
    "rule",
  ];
  const relations = node.kind === "rootfiles" ? 0 : nodeRelations(node).length;
  if (relations)
    items.push({
      label: "Relations",
      icon: "relations",
      hint: String(relations),
      run: () => {
        selectNode(node);
        nav.toMap("dependencies");
        expandSheet();
      },
    });
  if (node.status && node.status !== "unchanged") {
    const changed = files.filter((f) => f.status !== "unchanged").length;
    items.push({
      label: "Changes",
      icon: "changes",
      hint: files.length
        ? `${changed} file${changed === 1 ? "" : "s"}`
        : node.status,
      run: () => {
        selectNode(node);
        nav.toMap("changes");
        expandSheet();
      },
    });
  }
  if (node.path)
    items.push(
      symbol
        ? {
            label: "Copy name",
            icon: "copy",
            hint: node.name,
            key: "C",
            run: () => copyText(node.name),
          }
        : {
            label: "Copy path",
            icon: "copy",
            key: "C",
            run: () => copyText(node.path),
          },
    );
  const kind = symbol
    ? node.symbolKind || "declaration"
    : node.kind === "rootfiles"
      ? "files at the root"
      : node.kind;
  const line =
    symbol && node.start ? `${node.path.split("/").pop()}:${node.start}` : "";
  return {
    title: node.name || node.path || "Repository",
    subtitle: [
      kind,
      line,
      !symbol && node.status && node.status !== "unchanged" ? node.status : "",
    ]
      .filter(Boolean)
      .join(" · "),
    items,
  };
}
/** The menu for a name in a conversation that names place `place` (a code link). */
function nameMenu(place, link) {
  const file = place.path.split("/").pop();
  const inSession = nav.view().name === "run" && workflow.isLive(nav.view().id);
  const items = [
    {
      label: "Show on the map",
      icon: "pin",
      key: "Enter",
      run: () => link.click(),
    },
    {
      label: "Source",
      icon: "source",
      run: async () => {
        await openPlace(place);
        nav.toMap("source");
        expandSheet();
        if (!sourceData) loadSource();
      },
    },
    {
      label: "Ask about this",
      icon: "ask",
      key: "A",
      run: async () => {
        await openPlace(place, { keepTab: true });
        dockMode = "ask";
        nav.toMap();
        focusComposer();
      },
    },
  ];
  // In a session: the place goes with the next reply, as a pointer.
  if (inSession)
    items.push({
      label: "Reply about this",
      icon: "comment",
      key: "R",
      accent: true,
      run: async () => {
        await openPlace(place, { keepTab: true });
        focusComposer();
      },
    });
  items.push(
    "rule",
    place.symbol
      ? {
          label: "Copy name",
          icon: "copy",
          hint: place.symbol,
          key: "C",
          run: () => copyText(place.symbol),
        }
      : {
          label: "Copy path",
          icon: "copy",
          key: "C",
          run: () => copyText(place.path),
        },
  );
  const folder = place.path.includes("/")
    ? place.path.slice(0, place.path.lastIndexOf("/") + 1)
    : "";
  return {
    title: place.symbol || file,
    subtitle: place.symbol
      ? `${file}${place.line ? ":" + place.line : ""}`
      : folder
        ? `file in ${folder}`
        : "file",
    items,
  };
}
/** What a long press or a right-click on `element` opens: a map card or a name. */
function menuFor(element) {
  const link = element?.closest?.(".code-link[data-target]");
  if (link) {
    try {
      return {
        target: link,
        spec: nameMenu(JSON.parse(link.dataset.target), link),
      };
    } catch {
      return null;
    }
  }
  const card = element?.closest?.('.sheet[data-front="true"] .node[data-key]');
  const node = card && nodes.find((n) => n.key === card.dataset.key);
  if (!node || !["folder", "file", "rootfiles", "symbol"].includes(node.kind))
    return null;
  return { target: card, spec: cardMenu(node) };
}
installContextMenus(menuFor);
/** Drills into a selected directory or file, or opens source for a selected symbol. */
function openNode(node) {
  if (node.kind === "symbol") {
    sourceView = node.status === "removed" ? "before" : "after";
    nav.toMap("source");
    expandSheet();
    if (!sourceData) loadSource();
    return;
  }
  if (node.kind === "edge") {
    nav.toMap("dependencies");
    expandSheet();
    return;
  }
  if (node.kind === "boundary") return;
  navigate(nodeScope(node), node.key);
}
/** Animates a scope change, clears stale selection and source state, and loads file details after entering a file. */
async function navigate(
  next,
  originKey,
  { keepTab = false, follow = false } = {},
) {
  if (busy) return;
  // Follow's moves keep the owner's anchor; the owner's own moves end it.
  if (follow)
    held ??= { context: currentContext(), base: baseRef, head: headRef };
  else held = null;
  // Opened with the keyboard from a card: the focus goes to the new level's first card.
  if (!follow && document.activeElement?.closest?.("#deck .node"))
    focusFirstCard = true;
  // The owner moved the map: Follow pauses (its own moves are ignored there).
  workflow.ownerMoved();
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
  // A conversation in view stays in view as the map moves; the map's own sheet starts again
  // in Details, and a list gives way to it.
  if (!keepTab && !follow) nav.toMap("details", { thread: onThread() });
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
  if (scope.kind === "file") await loadSource();
}
/** Navigates to the parent directory or repository root. */
function goUp() {
  if (scope.kind === "repo") return;
  const path = parent(scope.path);
  navigate(path ? { kind: "folder", path } : rootScope());
}
/** Synchronizes review tabs and rebuilds revision controls, selection details and the active tab. */
let placeRestored = false;
/** The map's place as the address keeps it: `at` (the open folder or file) and `item` (the
 * selection). */
function placeOf() {
  return {
    at: scope.kind === "repo" ? null : `${scope.kind}:${scope.path}`,
    item:
      !selected || selected.kind === "edge"
        ? null
        : selected.kind === "symbol"
          ? selected.name
          : selected.path,
  };
}
/** Keeps the map's place and comparison in the address, so a reload, an app update or a
 * phone that closed the tab opens it again: `at` and `item` (see placeOf), `head` and `mode`
 * when they are not the defaults, and `explore`/`from` while the map shows a task's branch
 * (so Back still returns from it). */
function rememberPlace() {
  // Until the first map has opened the kept place, the address still holds it.
  if (!placeRestored) return;
  const url = new URL(location.href),
    { at, item } = placeOf(),
    away = exploring();
  const values = [
    ["at", at],
    ["item", item],
    [
      "head",
      metadata &&
      !viewingPr &&
      headRef &&
      headRef !== shownRevision(metadata.initialHead)
        ? headRef
        : null,
    ],
    ["mode", mode === "time" ? "time" : null],
    ["explore", away ? away.id || "-" : null],
    ["from", away ? away.branch || "HEAD" : null],
  ];
  for (const [key, value] of values)
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  if (url.href !== location.href) replaceUrl(url);
}
/** Opens a place `{at, item}` on the map: a folder or file, and a selection in it. A place
 * that is not in this comparison leaves the map where it is. */
async function goToPlace(place) {
  if (!place || !comparison) return;
  const { at, item } = place;
  if (at) {
    const [kind, ...rest] = at.split(":"),
      path = rest.join(":");
    const exists = (comparison.files || []).some(
      (f) => f.path === path || f.path.startsWith(path + "/"),
    );
    if (
      !["folder", "file", "rootfiles"].includes(kind) ||
      (kind !== "rootfiles" && !exists)
    )
      return;
    await navigate({ kind, path }, "", { keepTab: true });
  }
  if (!item) return;
  refreshModel();
  selected =
    nodes.find((n) => (n.kind === "symbol" ? n.name : n.path) === item) || null;
  render();
}
/** Opens what the address keeps (see `rememberPlace`), once, after the first map: the place,
 * the way back from a task's branch, then the run that a notification links to. */
async function restorePlace() {
  if (placeRestored) return;
  placeRestored = true;
  await restoreMapPlace();
  openLinkedRun();
}
/** Opens what a notification links to: a run (`?task=`), the Proposed rules page
 * (`?audit=1`) or the Proposed fixes page (`?fixes=1`). The address then drops it, so a reload does not open it again. */
function openLinkedRun() {
  const url = new URL(location.href),
    id = url.searchParams.get("task"),
    rules = url.searchParams.get("audit"),
    fixed = url.searchParams.get("fixes");
  if (!id && !rules && !fixed) return;
  for (const key of ["task", "audit", "fixes"]) url.searchParams.delete(key);
  replaceUrl(url);
  if (!isOwner()) return;
  if (id) workflow.openTask(id).catch(() => {});
  // A rule audit or a fix proposal ended: its notification opens its page.
  else nav.go({ name: rules ? "audit" : "fixes" });
}
async function restoreMapPlace() {
  if (!comparison) return;
  const url = new URL(location.href);
  const id = url.searchParams.get("explore");
  if (id) {
    // The map still shows a task's branch: Back returns to the branch it came from.
    nav.go({
      name: "inspect",
      aspect: "details",
      explore: {
        id: id === "-" ? null : id,
        branch: url.searchParams.get("from"),
        base: null,
        mode: "diff",
        place: null,
      },
    });
  }
  await goToPlace({
    at: url.searchParams.get("at"),
    item: url.searchParams.get("item"),
  });
}
function renderPanel() {
  rememberPlace();
  const name = nav.view().name;
  $("#openTasks").setAttribute(
    "aria-pressed",
    String(["tasks", "history", "prepare"].includes(name)),
  );
  $("#openConversations").setAttribute(
    "aria-pressed",
    String(name === "conversations"),
  );
  taskReturnChip.hidden = !nav.view().explore?.id;
  const view = viewKey();
  // An error belongs to its view; a short note belongs to its page (Tasks, a task, the map).
  // Only a lost connection stays.
  const text = $("#notice").textContent;
  if (
    text !== UNREACHABLE &&
    ((view !== noticeView && $("#notice").classList.contains("error")) ||
      name !== noticeName)
  )
    showNotice("");
  noticeView = view;
  noticeName = name;

  const scopeBar = $("#reviewScope");
  scopeBar.replaceChildren(
    element(
      "strong",
      "review-name",
      selected?.name || scope.path || metadata?.name || "Repository",
    ),
  );
  // Plain words for the kinds that the map names internally.
  const kindWords = {
    repo: "Repository",
    rootfiles: "Repository files",
    edge: "Relationship",
    stub: "Outside this folder",
    boundary: "Outside this folder",
  };
  const kind = selected?.kind || scope.kind;
  const caption =
    selected?.kind === "symbol"
      ? `${selected.symbolKind} · ${scope.path}`
      : kindWords[kind] || kind;
  scopeBar.append(element("span", "review-kind", caption));
  // A selection that breaks a rule says so in one line; it opens only the breaks.
  const breaks = selected ? nodeBreaks(selected) : [];
  if (breaks.length) {
    const line = button("review-breaks", "", () => {
      violationsOnly = true;
      nav.toMap("dependencies");
      render();
    });
    line.append(
      glyph("broken"),
      element("span", "", breaksLine(breaks)),
      element("span", "go", "›"),
    );
    line.title = [...new Set(breaks.map((b) => b.message))].join("; ");
    scopeBar.append(line);
  }
  if (selected?.changes?.length) {
    // Say what changed inside a modified declaration, so the reader knows what to inspect.
    const parts = element("span", "review-parts");
    parts.append(
      ...selected.changes.map(partIcon),
      document.createTextNode(
        partWords(selected.changes).replace(/^./, (c) => c.toUpperCase()) +
          " changed",
      ),
    );
    scopeBar.append(parts);
  }
  if (selected?.status)
    scopeBar.insertBefore(
      statusIcon(selected.status),
      scopeBar.querySelector(".review-kind"),
    );
  if (selected) {
    const clear = button("x", "×", () => {
      selected = null;
      held = null;
      render();
    });
    clear.setAttribute("aria-label", "Clear selection");
    scopeBar.append(clear);
  }

  // With a pull request open and nothing selected, the sheet is about the PR.
  if (prView()) scopeBar.replaceChildren(prHead());
  $("#panel").dataset.pr = String(prView());
  $("#panel").dataset.selection = String(!!selected);
  renderCommits();
  renderSelection();
  renderTab();
}
/** What the dock offers in the current view: "ask", "comments" (an instruction), "session",
 * or null for none. On the map it is the owner's mode; in a conversation, that conversation's
 * box; on a task that can take changes, the box for them. */
function dockKind() {
  const view = nav.view();
  if (!isOwner()) return null;
  if (view.name === "inspect") return dockMode;
  if (view.name === "ask") return "ask";
  if (view.name === "instructions") return "comments";
  if (view.name === "run")
    return workflow.isLive(view.id)
      ? "session"
      : workflow.revisable(view.id)
        ? "comments"
        : null;
  return null;
}
/** The last option of a commit picker while older commits exist: it loads them. */
const EARLIER = "__earlier__";
const earlierOption = () => {
  const option = element("option", "", "Earlier commits…");
  option.value = EARLIER;
  return option;
};
/** Loads the next page of older first-parent commits (the server sends 80 at a time) and
 * draws the history controls again. In Time, the rail keeps the commits that were in view. */
let loadingEarlier = null;
function loadEarlier() {
  const last = metadata?.commits.at(-1);
  if (!last || !metadata.moreCommits) return Promise.resolve();
  loadingEarlier ||= api("/api/commits?before=" + encodeURIComponent(last.sha))
    .then((page) => {
      const known = new Set(metadata.commits.map((c) => c.sha));
      metadata.commits.push(...page.commits.filter((c) => !known.has(c.sha)));
      metadata.moreCommits = page.more;
      const strip = $("#timeRail .commits"),
        before = strip ? strip.scrollWidth - strip.scrollLeft : 0;
      renderCommits();
      const after = $("#timeRail .commits");
      if (strip && after) after.scrollLeft = after.scrollWidth - before;
    })
    .catch((error) => {
      showNotice(error.message, true);
      renderCommits();
    })
    .finally(() => (loadingEarlier = null));
  return loadingEarlier;
}
/** Builds commit history controls and the base-revision picker from the loaded repository history. */
function renderCommits() {
  const bar = $("#commitBar");
  bar.replaceChildren();
  const strip = element("div", "commits");
  strip.setAttribute("aria-label", "Commit history");
  // The oldest loaded commit is at the left end; older ones load from there.
  if (metadata.moreCommits) {
    const earlier = button("chip earlier", "", () => loadEarlier());
    earlier.append(
      element("b", "", "Earlier"),
      element("span", "subject", "Load older commits"),
    );
    earlier.setAttribute("aria-label", "Load older commits");
    strip.append(earlier);
  }
  for (const c of metadata.commits.slice().reverse()) {
    const b = button(
      "chip" + (mode === "diff" && c.sha === baseRef ? " is-base" : ""),
      "",
      () => chooseHead(c.sha),
    );
    b.dataset.sha = c.sha;
    b.setAttribute("aria-selected", String(shownRevision(c.sha) === headRef));
    b.title = c.subject;
    // The newest commit names the uncommitted changes that its map includes.
    const changes = c.uncommitted?.paths.length;
    b.append(
      element("b", "", c.short),
      element(
        "span",
        "subject",
        changes ? `+ ${changes} uncommitted` : c.subject,
      ),
    );
    strip.append(b);
  }
  const rail = $("#timeRail");
  // A redraw keeps the rail where the owner scrolled it; a new commit is centered in it.
  const scrolled = rail.querySelector(".commits")?.scrollLeft || 0;
  rail.replaceChildren();
  rail.hidden = mode !== "time";
  $("#stage").dataset.mode = mode;
  if (mode === "time") {
    rail.append(strip);
    const chosen = strip.querySelector('[aria-selected="true"]');
    if (chosen && rail.dataset.centered !== headRef) {
      rail.dataset.centered = headRef;
      requestAnimationFrame(() => {
        const at =
          chosen.getBoundingClientRect().left -
          strip.getBoundingClientRect().left +
          strip.scrollLeft;
        strip.scrollLeft = at - (strip.clientWidth - chosen.offsetWidth) / 2;
      });
    } else strip.scrollLeft = scrolled;
  } else delete rail.dataset.centered;
  if (mode === "diff") {
    const headRow = element("label", "cmp", "Head revision");
    const headPicker = element("select");
    headPicker.id = "headRevision";
    headPicker.dataset.noun = "commits";
    headPicker.setAttribute("aria-label", "Head revision");
    const chosen = commit(headRef).worktree ? pending().sha : headRef;
    const candidates = metadata.commits.some((c) => c.sha === chosen)
      ? metadata.commits
      : [commit(headRef), ...metadata.commits];
    for (const c of candidates) {
      const changes = c.uncommitted?.paths.length;
      const option = element(
        "option",
        "",
        `${c.short} ${c.subject}${changes ? ` + ${changes} uncommitted` : ""}`,
      );
      option.value = c.sha;
      headPicker.append(option);
    }
    if (metadata.moreCommits) headPicker.append(earlierOption());
    headPicker.value = chosen;
    headPicker.onchange = () =>
      headPicker.value === EARLIER
        ? loadEarlier()
        : chooseHead(headPicker.value);
    headRow.append(headPicker);
    bar.append(headRow);
    const row = element("label", "cmp", "Compare with");
    const picker = element("select");
    picker.id = "base";
    picker.dataset.noun = "commits";
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
    if (metadata.moreCommits) picker.append(earlierOption());
    if (![...picker.options].some((o) => o.value === baseRef)) {
      const opt = element("option", "", baseRef.slice(0, 7));
      opt.value = baseRef;
      picker.append(opt);
    }
    picker.value = diffBase || "__previous__";
    picker.onchange = () => {
      if (picker.value === EARLIER) return loadEarlier();
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
    `${c.short} · ${c.time ? new Date(c.time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "commit"}${c.worktree ? ` + ${c.uncommitted.paths.length} uncommitted` : ""} · compared with ${commit(baseRef).short} · ${diffBase ? "manual base" : "previous commit (automatic)"}`,
  );
  head.append(meta);
  // A long branch name (such as an agent's run branch) shortens with an ellipsis; the
  // compared commits always stay readable.
  const branchName = element(
    "span",
    "rev-branch",
    viewingPr && !metadata.selectedBranch
      ? `PR #${viewingPr}`
      : metadata.selectedBranch?.name || "detached",
  );
  branchName.title = branchName.textContent;
  branchName.classList.toggle("pr", !!(viewingPr && !metadata.selectedBranch));
  $("#revisionSummary").replaceChildren(
    branchName,
    // Both commits use the same short form, whichever list they come from.
    element(
      "span",
      "rev-compare",
      ` · ${baseRef.slice(0, 7)} → ${revisionName(c.sha)}`,
    ),
  );
  if (viewingPr && !metadata.selectedBranch) {
    // The way out of a pull request sits beside its name.
    const leave = iconButton(
      button("rev-leave", "", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closePr();
      }),
      "close",
      "Leave pull request",
    );
    $("#revisionSummary").append(leave);
  }
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
    // Plain text like a file's description; the link names the file it came from.
    box = element("section", "directory-details");
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
  const read = button(
    "documentation-link link-button",
    `Read ${leaf(info.path)}`,
    async () => {
      await navigate({ kind: "file", path: info.path });
      sourceView = before || removed ? "before" : "after";
      nav.toMap("source");
    },
  );
  read.title = `${info.provenance} · ${info.path} · ${info.revision.slice(0, 7)}`;
  box.append(read);
  return box;
}
/** Why Peekumi shows no source for a file, from the engine's analysis label, or null when
 * the file is readable. Every such file stays on the map with this explicit label. */
function withheld(analysis = "") {
  const reasons = [
    [
      "restricted",
      "Source hidden. The name of this file often holds secrets (passwords, keys or tokens), so Peekumi does not show it or send it to Ask.",
    ],
    ["binary", "Binary file. Peekumi shows no source for it."],
    [
      "large file",
      "Large file. Peekumi does not show the source of files this large.",
    ],
    ["symlink", "Symbolic link. Peekumi does not follow links."],
    ["submodule", "Submodule. Peekumi does not open the other repository."],
  ];
  return reasons.find(([key]) => analysis.startsWith(key))?.[1] || null;
}
/** Builds a disclosure identifying the selected file's language adapter, capabilities, analysis status and limitations. */
function adapterCard() {
  const adapter = comparison?.directoryMetadata?.adapters?.find((a) =>
      a.extensions.includes(scope.path.split(".").at(-1)),
    ),
    // Background detail: a one-line note that expands, not a card.
    box = element("details", "adapter-note");
  box.append(
    element(
      "summary",
      "",
      adapter
        ? (adapter.name || adapter.id) + " adapter"
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
  } else {
    // A file without source says why, open, so the label is never hidden.
    const reason = withheld(sourceData?.analysis);
    box.open = Boolean(reason);
    box.append(
      element(
        "p",
        "metadata-muted",
        reason || "Symbol extraction is not supported for this file type.",
      ),
    );
  }
  return box;
}
/** Explains what the current scope offers when nothing is selected. */
function scopeHint() {
  return (
    fileWithheld() ||
    (scope.kind === "file"
      ? "Select a declaration to inspect it, or open Source for the whole file."
      : "Select a card to review it; tap it again to open.")
  );
}
/** Why the open file has no source (restricted, binary, large, a link or a submodule), from
 * the comparison, or null for a readable file or another scope. */
function fileWithheld() {
  if (scope.kind !== "file") return null;
  return withheld(
    comparison?.files?.find((f) => f.path === scope.path)?.analysis,
  );
}
/** The sheet's top for an open pull request: its state and branches, its title, and who
 * made it, when, and how large it is. */
function prHead() {
  const pr = prData,
    state = prState(pr),
    head = element("div", "pr-head"),
    top = element("div", "pr-top"),
    meta = element("span", "pr-meta");
  top.append(
    element("span", "pr-state", state),
    element(
      "span",
      "pr-branches",
      `PR #${viewingPr} · ${pr.headRefName || "head"} → ${pr.baseRefName || "base"}`,
    ),
  );
  top.firstChild.dataset.state = state.toLowerCase();
  const [word, when] = pr.mergedAt
    ? ["merged", pr.mergedAt]
    : pr.closedAt
      ? ["closed", pr.closedAt]
      : ["opened", pr.createdAt];
  const date = when
    ? new Date(when).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
  meta.append(
    [
      pr.author?.login,
      date && `${word} ${date}`,
      pr.changedFiles != null &&
        `${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  if (pr.additions != null)
    meta.append(
      " ",
      element("span", "pr-add", `+${pr.additions.toLocaleString()}`),
      " ",
      element("span", "pr-del", `−${(pr.deletions || 0).toLocaleString()}`),
    );
  head.append(
    top,
    element("strong", "pr-title", pr.title || `PR #${viewingPr}`),
    meta,
  );
  return head;
}
/** One quiet row of the PR sheet. With `items` it opens to list them; otherwise it only
 * states `value`. */
function prRow(label, value, tone, items = []) {
  const row = element(items.length ? "details" : "div", "pr-row"),
    line = element(items.length ? "summary" : "div", "pr-row-line"),
    text = element("span", "pr-row-value", value);
  if (tone) text.dataset.tone = tone;
  line.append(element("span", "", label), text);
  row.append(line, ...items);
  return row;
}
/** The pull request in the sheet: the start of its description, then one row each for
 * checks, reviews and the link to GitHub. Lists open only when the reader asks. */
function prCard() {
  const pr = prData,
    box = element("section", "pr-card"),
    body = pr.body?.trim() || "";
  // The first paragraph of prose, without Markdown headings, emphasis or code marks.
  const first =
    body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(
        (part) =>
          part && !/^(#|[-*+] |\d+\. |```|<)/.test(part) && part.length > 30,
      ) ||
    body.split(/\n\s*\n/)[0] ||
    "";
  if (!body) box.append(element("p", "pr-summary empty", "No description."));
  else if (prExpanded) box.append(richText(body, "pr-body"));
  else
    box.append(
      element(
        "p",
        "pr-summary",
        first.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, ""),
      ),
    );
  if (body && body !== first)
    box.append(
      button(
        "pr-more link-button",
        prExpanded ? "Show less" : "Read full description",
        () => {
          prExpanded = !prExpanded;
          renderSelection();
        },
      ),
    );
  // Checks: one line that says what matters most; the list opens on request.
  const checks = pr.statusCheckRollup || [],
    result = (c) => (c.conclusion || c.state || c.status || "").toUpperCase(),
    failing = checks.filter((c) =>
      [
        "FAILURE",
        "ERROR",
        "CANCELLED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
      ].includes(result(c)),
    ).length,
    running = checks.filter((c) =>
      ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(
        result(c),
      ),
    ).length;
  box.append(
    prRow(
      "Checks",
      !checks.length
        ? "None reported"
        : failing
          ? `${failing} failing of ${checks.length}`
          : running
            ? `${running} running of ${checks.length}`
            : `All ${checks.length} passed`,
      !checks.length ? "" : failing ? "bad" : running ? "wait" : "good",
      checks.map((c) =>
        element(
          "p",
          "pr-entry",
          `${c.name || c.context}: ${(result(c) || "unknown").toLowerCase()}`,
        ),
      ),
    ),
  );
  // Reviews: each reviewer's latest decision, then the comments.
  const reviews = pr.reviews || [],
    comments = pr.comments || [],
    latest = new Map();
  for (const r of reviews)
    if (r.state !== "COMMENTED") latest.set(r.author?.login, r.state);
  const decisions = [...latest.values()],
    approvals = decisions.filter((d) => d === "APPROVED").length,
    talk = reviews.filter((r) => r.body?.trim()).length + comments.length,
    summary = [
      decisions.includes("CHANGES_REQUESTED")
        ? "Changes requested"
        : approvals
          ? `${approvals} approved`
          : "",
      talk ? `${talk} comment${talk === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  box.append(
    prRow(
      "Reviews",
      summary || "None",
      decisions.includes("CHANGES_REQUESTED")
        ? "wait"
        : approvals
          ? "good"
          : "",
      [...reviews, ...comments]
        .filter((entry) => entry.body?.trim() || entry.state)
        .map((entry) => {
          const note = element("div", "pr-entry");
          note.append(
            element(
              "p",
              "pr-author",
              `${entry.author?.login || "Reviewer"}${entry.state ? " · " + entry.state.toLowerCase().replace("_", " ") : ""}`,
            ),
          );
          if (entry.body?.trim()) note.append(richText(entry.body, "pr-body"));
          return note;
        }),
    ),
  );
  if (pr.url) {
    const link = element("a", "pr-row pr-link");
    link.href = pr.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(element("span", "", "Open on GitHub"), glyph("external"));
    box.append(link);
  }
  return box;
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
    facts.push(["Lines", `${node.start}–${node.end}`]);
    if (node.changes?.length)
      facts.push([
        "Changed",
        partWords(node.changes).replace(/^./, (c) => c.toUpperCase()),
      ]);
  } else if (node.kind === "file") {
    const total = node.symbolCount ?? node.symbols?.length ?? 0,
      known = node.symbols || node.symbolPreview || [];
    facts.push(["Declarations", String(total)]);
    // The compact preview is capped; report a count only when it covers every declaration.
    if (known.length && known.length === total)
      facts.push([
        "Changed declarations",
        String(known.filter((symbol) => symbol.status !== "unchanged").length),
      ]);
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
/** Fills `list` with the In, Out or Fields lines of a declaration: each one line of name/type
 * tokens that scrolls sideways. Shared by the peek summary and expanded Details. */
function fillContract(list, detail) {
  const row = (kind, tokens) => {
    const term = element("dt"),
      line = element("dd", "contract-line");
    term.append(interfaceIcon(kind));
    for (const [name, type] of tokens) {
      const token = element("span", "contract-token");
      if (name) token.append(element("b", "", name));
      if (type) token.append(element("span", "", type));
      line.append(token);
    }
    line.addEventListener("scroll", () => markOverflowX(line), {
      passive: true,
    });
    contractLines.observe(line);
    list.append(term, line);
  };
  if (detail?.parameters) {
    row(
      "In",
      detail.parameters.length
        ? detail.parameters.map((p) => [
            p.name + (p.optional ? "?" : ""),
            [p.type, p.default != null ? "= " + p.default : ""]
              .filter(Boolean)
              .join(" "),
          ])
        : [["", "No parameters"]],
    );
    if (detail.returns || detail.returnDescription)
      row("Out", [[detail.returns || "", detail.returnDescription || ""]]);
  } else if (detail?.fields?.length) {
    row(
      "Fields",
      detail.fields.map((f) => [
        f.name + (f.optional ? "?" : ""),
        f.type || "",
      ]),
    );
  }
}
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
  contract
    .querySelectorAll(".contract-line")
    .forEach((line) => contractLines.unobserve(line));
  contract.replaceChildren();
  fillContract(contract, detail);
  contract.hidden = !contract.children.length;
  requestAnimationFrame(() => {
    markOverflow(summaryText);
    contract.querySelectorAll(".contract-line").forEach(markOverflowX);
  });
  const strip = $("#selStrip");
  strip.replaceChildren();
  if (prView()) {
    strip.append(prCard());
    return;
  }
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
  // What the selection is comes first; facts follow as one quiet line with the next action.
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
  const facts = element("div", "selection-facts");
  // The header already names the kind and path; only an edge needs saying what it is.
  if (selected.kind === "edge")
    facts.append(
      element(
        "p",
        "sel-kind",
        selected.relationshipKind === "imports"
          ? "Static import dependency"
          : "Static " + selected.relationshipKind + " relationship",
      ),
    );
  const line = selectionFacts(selected)
    .map(([label, value]) =>
      // "1 file", "3 files": a count reads with its noun in the right number.
      /^\d+$/.test(value)
        ? `${value} ${value === "1" ? label.toLowerCase().replace(/s$/, "") : label.toLowerCase()}`
        : `${label} ${value}`,
    )
    .join(" · ");
  if (line) facts.append(element("p", "fact-line", line));
  if (selected.kind !== "boundary")
    facts.append(
      button(
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
      ),
    );
  // A relationship that should not exist becomes a rule: an instruction draft that asks for
  // it in .peekumi.json, through the normal review.
  if (selected.kind === "edge" && isOwner())
    facts.append(
      button("link-button forbid-edge", "Forbid this dependency ›", () =>
        forbid(selected),
      ),
    );
  box.append(facts);
  if (scope.kind === "file") box.append(adapterCard());
  strip.append(box);
}
/** Fades the last visible line while more peek text is scrollable, so clipping reads as "scroll for more". */
function markOverflow(node) {
  node.dataset.more = String(
    node.scrollTop + node.clientHeight < node.scrollHeight - 1,
  );
}
/** Fades a contract line's trailing edge while more tokens are scrollable sideways. */
function markOverflowX(node) {
  node.dataset.more = String(
    node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
  );
}
// Lines are often measured while the sheet hides them; re-check when they gain size.
const contractLines = new ResizeObserver((entries) =>
  entries.forEach((entry) => markOverflowX(entry.target)),
);
for (const id of ["#selectionSummary"])
  $(id).addEventListener("scroll", (event) => markOverflow(event.target), {
    passive: true,
  });
/** Displays revision-specific module or symbol documentation and explicit declaration metadata. Description, signature and arguments are readable directly in the expanded sheet. */
function metadataCard() {
  const box = element("section", "code-metadata");
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
  // The expanded twin of the peek summary: the whole description and the same In/Out lines,
  // without cards. The header names the selection and the In line carries the signature.
  if (info.description)
    box.append(element("p", "code-description", info.description));
  const lines = element("dl", "contract-lines");
  fillContract(lines, info);
  if (lines.children.length) {
    box.append(lines);
    requestAnimationFrame(() =>
      lines.querySelectorAll(".contract-line").forEach(markOverflowX),
    );
  }
  // Parameter notes only where the code documents them.
  const notes = (info.parameters || []).filter((param) => param.description);
  if (notes.length) {
    const list = element("dl", "metadata-parameters");
    for (const param of notes)
      list.append(
        element("dt", "", param.name),
        element("dd", "", param.description),
      );
    box.append(list);
  }
  // Where the description came from matters only for a file's own documentation.
  const source = [
    selected?.kind === "symbol" ? "" : info.provenance,
    useBefore ? "before" : "",
  ].filter(Boolean);
  if (source.length)
    box.append(element("small", "metadata-source", source.join(" · ")));
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
  host.replaceChildren();
  // While a session is open, its agent's marks on the map lead the key.
  // The agent's marks, while any agent's focus shows: a session, a task at work, or Ask.
  if (
    document.querySelector(
      ".node.agent-here, .node.agent-trail, .node.agent-changed",
    ) ||
    workflow.hasLiveSession()
  ) {
    const marks = element("div", "legend-inline");
    for (const [kind, label] of [
      ["here", "Agent is here"],
      ["trail", "Looked at"],
      ["changed", "Changed"],
    ]) {
      const item = element("span");
      item.append(
        element("i", "agent-swatch " + kind),
        document.createTextNode(label),
      );
      marks.append(item);
    }
    host.append(element("strong", "", "Agent"), marks);
  }
  host.append(
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
  if (lens === "changes") {
    const parts = element("div", "legend-inline");
    for (const [part, label] of [
      ["signature", "Signature"],
      ["documentation", "Documentation"],
      ["implementation", "Implementation"],
    ]) {
      const item = element("span");
      item.append(partIcon(part), document.createTextNode(label));
      parts.append(item);
    }
    host.append(element("strong", "", "Changed inside a declaration"), parts);
  }
  const lines = element("div", "legend-lines");
  for (const [kind, label] of [
    ["out", "The selection uses"],
    ["in", "Uses the selection"],
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
  // The card's mark for a rule break: the broken-link icon and how many.
  const breakRow = element("div", "legend-row legend-breaks");
  breakRow.append(
    glyph("broken"),
    element("span", "", "Rule breaks that start in a card, and how many"),
  );
  lines.append(breakRow);
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
/** The chip beside the composer: what Ask, or a new task, uses on this device. A tap opens
 * that list in Agents. It shows once the agent list has loaded. */
function showDockAgent() {
  // A read-only device has no dock and may not read the agent list.
  if (!isOwner()) return;
  // A task or session continues with its own agent, which its buttons name.
  if (nav.view().name === "run") {
    $("#dockAgent").hidden = true;
    return;
  }
  const chip = $("#dockAgent"),
    kind = dockKind(),
    job = kind === "ask" ? "ask" : "task",
    uses = agents.describe(job);
  // Sessions use the agent chosen for tasks.
  chip.hidden = !uses;
  if (!uses) {
    agents
      .load()
      .then((c) => c && showDockAgent())
      .catch(() => {});
    return;
  }
  // The agent's name stays; its model and effort shorten first.
  const [agent, ...detail] = uses.split(" · ");
  chip.replaceChildren(
    element("span", "chip-agent", agent),
    ...(detail.length
      ? [element("span", "chip-detail", "\u00a0· " + detail.join(" · "))]
      : []),
  );
  const what =
    job === "ask"
      ? "Ask uses"
      : kind === "session"
        ? "Sessions use"
        : "New tasks use";
  chip.title = `${what} ${uses}. Change`;
  chip.setAttribute("aria-label", chip.title);
  chip.onclick = () => agents.open(job, () => renderTab());
}
/* The review sheet's scroll position follows one rule, for every view:
 * - the same view drawn again (a poll, a new message, the map moving under it) keeps the
 *   reader's place, and a reader at the end of a conversation stays at its end;
 * - a conversation (Ask, an open session) opens at its latest message;
 * - any other view opens at its top.
 * `viewKey()` tells views apart. Nothing else sets #reviewScroll's position. */
const reading = { key: "", top: 0, atEnd: true };
/** What the review sheet shows, as a key: the same key is the same view. */
function viewKey() {
  const view = nav.view();
  if (view.name === "inspect")
    return `${view.aspect}:${scope.kind}:${scope.path}:${selected?.key || ""}`;
  if (view.name === "ask") return `ask:${viewingBranch || ""}`;
  if (view.name === "run")
    return `run:${view.id}:${workflow.runShape(view.id)}`;
  return view.name;
}
/** True for a view whose newest part is at its end: Ask, and an open session. */
const conversationView = () => {
  const view = nav.view();
  return (
    view.name === "ask" || (view.name === "run" && workflow.isLive(view.id))
  );
};
/** Remembers the reader's place in the current view, while the sheet shows it. */
function rememberReading() {
  const scroller = $("#reviewScroll");
  if (!scroller.clientHeight) return;
  reading.top = scroller.scrollTop;
  reading.atEnd =
    scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24;
}
/** Puts the reader where the rule says, after the view is drawn. */
function placeReader() {
  const scroller = $("#reviewScroll"),
    key = viewKey(),
    same = key === reading.key;
  if (same)
    scroller.scrollTop =
      reading.atEnd && conversationView() ? scroller.scrollHeight : reading.top;
  else scroller.scrollTop = conversationView() ? scroller.scrollHeight : 0;
  reading.key = key;
  // A view that is shown for the first time starts from the rule, not from an old place.
  if (!same) reading.atEnd = conversationView();
  reading.top = scroller.scrollTop;
}
$("#reviewScroll").addEventListener("scroll", rememberReading, {
  passive: true,
});
function renderTab() {
  drawTab();
  // After the title rows are drawn: the live line, and the way back to an explored task, go
  // into the one on screen.
  workflow.cueLive();
  const title = $("#reviewScope");
  if (title && taskReturnChip.parentElement !== title)
    title.append(taskReturnChip);
  placeReader();
}
/** The header row of a page: Back, the title, an optional quiet line, and the page's few
 * actions. Every page uses it, so the way back is always in the same place. */
function viewHead(title, { meta = "", actions = [], mood = "" } = {}) {
  const row = element("div", "view-head"),
    back = iconButton(element("button", "view-back"), "back", "Back"),
    text = element("div", "view-text");
  back.type = "button";
  back.onclick = () => nav.back();
  text.append(element("h2", "view-title", title));
  if (meta) text.append(element("p", "view-meta", meta));
  row.append(back, text, ...actions);
  if (mood) row.append(peek(mood, { className: "task-peek" }));
  $("#viewHead").replaceChildren(row);
  return row;
}
/** The branch on the map, as a short name for titles. */
const branchName = () =>
  (viewingBranch || metadata?.branch || "HEAD").replace(/^refs\/heads\//, "");
/** Conversations: the open sessions, and the Ask conversation of the branch on the map. */
function renderConversations(body) {
  viewHead("Conversations");
  const row = (title, line, open, mark) => {
    const b = element("button", "conversation-row");
    b.type = "button";
    const text = element("span", "conversation-text");
    text.append(element("strong", "", title), element("small", "", line));
    b.append(mark, text, glyph("forward"));
    b.onclick = open;
    return b;
  };
  const sessions = workflow.liveSessions();
  if (sessions.length)
    body.append(
      element("h3", "workflow-group", "Sessions"),
      ...sessions.map((s) =>
        row(
          s.title,
          s.line,
          () => workflow.openTask(s.id),
          peek(s.mood, { className: "conversation-peek" }),
        ),
      ),
    );
  const askMark = element("span", "conversation-icon");
  askMark.append(glyph("ask"));
  body.append(
    element("h3", "workflow-group", "Ask"),
    row(
      `Ask · ${branchName()}`,
      ask.lastQuestion() || "No questions yet",
      () => nav.go({ name: "ask" }),
      askMark,
    ),
  );
}
/** Under Details: the instructions left on this selection, as one quiet link to them. */
function renderInstructionsHere(body) {
  const count = isOwner() ? workflow.instructionsHere() : 0;
  if (!count) return;
  const link = button(
    "link-button instructions-here",
    `${count} instruction${count === 1 ? "" : "s"} here ›`,
    () => nav.go({ name: "instructions" }),
  );
  body.append(link);
}
function drawTab() {
  const view = nav.view(),
    page = view.name !== "inspect",
    panel = $("#panel");
  // The way back to an explored task says how many changes are waiting to go with it.
  const away = view.explore?.id,
    waiting = away ? workflow.collected(away) : 0,
    what = away && workflow.runKind(away) === "session" ? "session" : "task";
  taskReturnChip.textContent = waiting
    ? `‹ Back to ${what} · ${waiting} to send`
    : `‹ Back to ${what}`;
  // A page (a list, a task, a conversation) takes the whole sheet, under its header row; the
  // map's own views keep the selection's header and the aspect buttons.
  panel.dataset.view = page ? view.name : view.aspect;
  panel.dataset.sheet = page ? "page" : "inspect";
  document
    .querySelectorAll("button[data-tab]")
    .forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(!page && b.dataset.tab === view.aspect),
      ),
    );
  // The dock follows the view: its modes on the map, a conversation's own box elsewhere.
  const kind = dockKind();
  $("#conversationDock").hidden = !kind;
  $("#tabs").hidden = page;
  document
    .querySelectorAll("[data-compose]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.compose === kind)),
    );
  const body = $("#tabBody");
  body.replaceChildren();
  $("#viewHead").replaceChildren();
  const composerHost = $("#composerHost");
  // Redraws replace the composer; keep focus and the caret so the keyboard stays open.
  const typing = document.activeElement?.closest?.("#composerHost textarea");
  const caret = typing && [typing.selectionStart, typing.selectionEnd];
  composerHost.replaceChildren();
  const conversation = element("div", "conversation");
  if (kind === "ask") ask.render(conversation, composerHost);
  else if (kind === "session")
    workflow.renderSessionComposer(
      composerHost,
      view.name === "run" ? view.id : null,
    );
  else if (kind === "comments") workflow.renderComposer(composerHost);
  const box = composerHost.querySelector("textarea");
  if (box) {
    // The box grows with its text up to the CSS max-height (four lines), then scrolls.
    const fit = () => {
      box.style.height = "auto";
      box.style.height = box.scrollHeight + 2 + "px";
    };
    box.addEventListener("input", fit);
    requestAnimationFrame(fit);
  }
  if (caret) {
    box?.focus({ preventScroll: true });
    box?.setSelectionRange(...caret);
  }
  const anchor = composerHost.querySelector(".composer-anchor")?.textContent;
  // The place's name stays readable on a phone: the commit after it shortens first.
  const [, place = anchor, commit] =
    anchor?.match(/^(.*?)( · [0-9a-f]{7,}| · uncommitted| · [^·]+\/[^·]+)?$/) ||
    [];
  $("#dockContext").replaceChildren(
    ...(anchor
      ? [
          glyph("pin"),
          element("span", "dock-text", place),
          ...(commit
            ? [element("span", "dock-commit", commit.replace(/^ /, "\u00a0"))]
            : []),
        ]
      : []),
  );
  $("#dockContext").title = anchor || "";
  showDockAgent();
  $("#selectionDetails").hidden = page || view.aspect !== "details";
  if (view.name === "ask") {
    const fresh = iconButton(
      element("button", "view-action"),
      "add",
      "New conversation",
    );
    fresh.type = "button";
    fresh.disabled = !ask.hasMessages();
    fresh.onclick = () => ask.clear();
    viewHead(`Ask · ${branchName()}`, { actions: [fresh] });
    body.append(conversation);
    return;
  }
  if (view.name === "conversations") return renderConversations(body);
  if (view.name === "fixes") return fixes.render(body);
  if (view.name === "audit") return audit.render(body);
  if (page) return workflow.render(body, view);
  if (view.aspect === "details") return renderInstructionsHere(body);
  if (view.aspect === "source") {
    renderSource(body);
    return;
  }
  if (view.aspect === "dependencies") {
    renderDependencies(body);
    return;
  }
  const files = comparison.files.filter((f) => inScope(f, scope)),
    changed = files.filter((f) => f.status !== "unchanged");
  const overview = element("div", "change-overview"),
    summary = element(
      "p",
      "sum",
      `${changed.length} changed · ${files.length} file${files.length === 1 ? "" : "s"} in this scope`,
    );
  summary.id = "change-summary";
  summary.dataset.count = changed.length;
  overview.append(summary);
  if (changed.length) overview.append(legend(files));
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
            ? [
                node.symbolKind,
                node.changes?.length
                  ? partWords(node.changes) + " changed"
                  : "",
                `lines ${node.start}–${node.end}`,
              ]
                .filter(Boolean)
                .join(" · ")
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
            : fileWithheld()
              ? fileWithheld()
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
  if (scope.kind === "file" && !fileWithheld())
    body.append(
      button("btn", "Open full file diff", () => {
        sourceView = "diff";
        nav.toMap("source");
        if (!sourceData) loadSource();
      }),
    );
}
/** Shows configuration health without implying that unresolved code passed a rule check: the
 * breaks that this comparison adds (on the after side), the warnings about rules that check
 * nothing, and for each rule what it checked, what broke it and what stayed unresolved. */
function ruleSummary() {
  const phase = before ? "before" : "after",
    checks = comparison.relationshipData?.checks?.[phase],
    added = before ? [] : comparison.relationshipData?.checks?.added || [];
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
          : `${added.length ? `${added.length} new rule break${added.length === 1 ? "" : "s"} · ` : ""}${checks.violations ? `${checks.violations} rule violation${checks.violations === 1 ? "" : "s"}` : "No rule violations"} · ${checks.rules} rule${checks.rules === 1 ? "" : "s"}`,
    ),
  );
  if (added.length) box.classList.add("has-added");
  box.dataset.state = checks.state;
  if (checks.violations) box.classList.add("has-violations");
  if (nav.view().aspect !== "dependencies")
    box.append(
      button("btn sm", "Review relationships", () => nav.toMap("dependencies")),
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
  // A rule that checks nothing passes silently, so its warning comes first.
  for (const warning of checks.warnings || [])
    box.append(element("p", "rule-warning", warning));
  if (added.length) {
    box.append(element("p", "rule-added-head", "Added by this comparison:"));
    for (const b of added.slice(0, 20))
      box.append(
        element(
          "p",
          "rule-added",
          `${b.rule}: ${b.source.path} → ${b.target.path} (${b.kind})`,
        ),
      );
    if (added.length > 20)
      box.append(element("p", "", `${added.length - 20} more`));
  }
  for (const c of checks.coverage || [])
    box.append(
      element(
        "p",
        "rule-coverage",
        `${c.id}: checked ${c.checked}, broke ${c.broke}, unresolved ${c.unresolved}`,
      ),
    );
  if (checks.state === "not configured")
    box.append(
      element(
        "p",
        "",
        "Commit a .peekumi.json file to define path groups and forbidden relationships. No rules have been assumed.",
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
  sourceView = before || !relation.after ? "before" : "after";
  renderDeck();
  nav.toMap("source");
}
/** Lists typed relationships, rule evidence and unresolved targets for the current scope. */
function renderDependencies(body) {
  body.append(ruleSummary());
  // The breaks at this commit become proposed fixes: the view's one primary action.
  const after = comparison.relationshipData?.checks?.after;
  if (!before && after?.state === "evaluated" && after.violations && isOwner())
    body.append(
      button(
        "btn primary propose-fixes",
        `Propose fixes for ${after.violations} rule break${after.violations === 1 ? "" : "s"}`,
        () => nav.go({ name: "fixes" }),
      ),
    );
  // An agent audits the architecture and proposes rules: the primary action when there is
  // no break to fix.
  if (!before && isOwner())
    body.append(
      button(
        after?.state === "evaluated" && after.violations
          ? "btn propose-rules"
          : "btn primary propose-rules",
        "Propose rules",
        () => nav.go({ name: "audit" }),
      ),
    );
  // The breaks that start inside the selection. The list below shows only the lines between
  // cards on this level, so breaks between files inside a folder would not show there.
  const inside =
    selected && selected.kind !== "edge" ? nodeBreaks(selected) : [];
  if (inside.length) {
    const pairs = new Map();
    for (const b of inside) {
      const key = `${b.source}→${b.target}:${b.kind}`;
      const entry = pairs.get(key) || { ...b, rules: new Set(), count: 0 };
      entry.rules.add(b.rule);
      entry.count = Math.max(entry.count, b.count);
      pairs.set(key, entry);
    }
    const breaks = element("ul", "break-list");
    for (const b of [...pairs.values()].sort((a, c) => c.count - a.count)) {
      const row = button("break-row", "", () =>
        navigate({ kind: "file", path: b.source }),
      );
      const text = element("span", "row-text");
      text.append(
        element(
          "span",
          "rt",
          `${b.source.split("/").pop()} → ${b.target.split("/").pop()}`,
        ),
        element(
          "span",
          "rd",
          `${kindCount(b.count, b.kind)} · ${[...b.rules].join(", ")}`,
        ),
      );
      row.append(glyph("broken"), text, glyph("forward"));
      const li = element("li");
      li.append(row);
      breaks.append(li);
    }
    body.append(
      element("h3", "workflow-group", "Rule breaks from this selection"),
      breaks,
    );
  }
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
  const violations = button("violations-toggle", "Violations only", () => {
    violationsOnly = !violationsOnly;
    render();
  });
  violations.setAttribute("aria-pressed", String(violationsOnly));
  controls.append(filter, violations);
  body.append(controls);
  controls.title =
    "Static declarations, not runtime execution. Select a symbol to focus its calls.";
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
        edge.status === "unchanged"
          ? edge.relationshipKind
          : `${edge.relationshipKind} · ${labels[edge.status]} · ${edge.before.size} → ${edge.after.size}`,
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
      element(
        "li",
        "empty",
        inside.length
          ? "No other connections on this level."
          : "No resolved connections in this selection.",
      ),
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
      if (nav.view().aspect === "source")
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
  // A file that Peekumi does not read says why, in every view, and whether Git changed it.
  const reason =
    sourceData.before == null && sourceData.after == null
      ? withheld(sourceData.analysis)
      : null;
  if (reason) {
    const status = comparison?.files?.find(
      (f) => f.path === scope.path,
    )?.status;
    const changed = {
      added: "Added in this comparison.",
      changed: "Changed in this comparison.",
      removed: "Removed in this comparison.",
    }[status];
    code.append(
      element("div", "empty", changed ? `${reason} ${changed}` : reason),
    );
    return;
  }
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
  // Bring the declaration into view once the code box has its size: on a phone the sheet may
  // still open (from peek to half), and a box with no height cannot scroll yet.
  const reveal = (frames = 0) => {
    const highlighted = code.querySelector(".highlight");
    if (!highlighted || !code.isConnected) return;
    if ((!code.clientHeight || $("#panel").dataset.settling) && frames < 60)
      return requestAnimationFrame(() => reveal(frames + 1));
    code.scrollTop = highlighted.offsetTop - code.offsetTop - 28;
  };
  requestAnimationFrame(() => reveal());
}
/** Changes the commit under review and reloads the appropriate Time or Diff comparison. */
function chooseHead(sha) {
  if (busy) return;
  headRef = shownRevision(sha);
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
// The aspect buttons switch the map's view in place; Back from another aspect returns to
// Details.
document.querySelectorAll("button[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      expandSheet();
      nav.toMap(b.dataset.tab);
      if (b.dataset.tab === "source" && scope.kind === "file" && !sourceData)
        loadSource();
    }),
);
// The dock's modes on the map: what the next message is. Only a preference: the view stays.
document.querySelectorAll("[data-compose]").forEach(
  (b) =>
    (b.onclick = () => {
      dockMode = b.dataset.compose;
      if (comparison) renderPanel();
      $("#composerHost textarea")?.focus({ preventScroll: true });
    }),
);
/* The phone's back button (and the browser's back) steps back inside the app, one layer at a
 * time, before it leaves. The app keeps two history entries of its own: a base, and a guard
 * on top of it. A back press lands on the base; the app undoes one layer and puts the guard
 * back. Any other history event (a change of only the address's #fragment, say) is not a
 * back press and is left alone. Escape does the same as Back. */
const BACK_BASE = { peekumiBase: true };
const BACK_GUARD = { peekumiBack: true };
/** Undoes one layer: an open menu, dialog or popover; then the view on top (nav.js); then
 * the selection; then one map level. False when nothing is left. */
function goBack() {
  if (menuIsOpen()) {
    closeMenu();
    return true;
  }
  const dialog = document.querySelector("dialog[open]");
  if (dialog) {
    // Through the dialog's own cancel, so its owner tidies up (agents.js, a merge sheet).
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    if (dialog.open) dialog.close();
    return true;
  }
  const popover = document.querySelector(
    "#mapLegend[open], #revisionDetails[open]",
  );
  if (popover) {
    popover.open = false;
    popover.querySelector("summary")?.focus();
    return true;
  }
  if (nav.back()) return true;
  if (selected) {
    selected = null;
    held = null;
    render();
    return true;
  }
  if (scope.kind !== "repo") {
    goUp();
    return true;
  }
  return false;
}
if (history.state?.peekumiBack !== true) {
  history.replaceState(BACK_BASE, "", location.href);
  history.pushState(BACK_GUARD, "", location.href);
}
addEventListener("popstate", (event) => {
  // Only a back press onto the app's base counts.
  if (!event.state?.peekumiBase) return;
  // The base entry holds an older address; the app's own address comes first, so the views
  // that redraw now keep its branch and place.
  history.replaceState(BACK_BASE, "", shownUrl);
  if (goBack()) {
    // The base and the guard keep the address the app shows now.
    history.replaceState(BACK_BASE, "", shownUrl);
    history.pushState(BACK_GUARD, "", shownUrl);
  }
  // Nothing left inside the app: this back press leaves it.
  else history.back();
});
/** A header button opens its page; pressed again on that page, it goes back. */
function toggle(name) {
  // A header page with its own pages (History, the task form) counts as that page.
  const family = name === "tasks" ? ["tasks", "history", "prepare"] : [name];
  const header = ["tasks", "history", "prepare", "conversations"];
  if (family.includes(nav.view().name))
    return nav.backWhile((v) => family.includes(v.name));
  // One header page at a time: the other one gives way, so they do not pile up.
  nav.backWhile((v) => header.includes(v.name));
  nav.go({ name });
}
$("#openTasks").onclick = () => toggle("tasks");
$("#openConversations").onclick = () => toggle("conversations");
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
  if (!matchMedia(PHONE).matches || stage.style.height) return;
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
  // A closed sheet shows the open session's line, also from the session itself.
  workflow.cueLive();
  const end = panel.getBoundingClientRect().height;
  $("#sheetHandle").setAttribute(
    "aria-label",
    height === "full" ? "Collapse review sheet" : "Expand review sheet",
  );
  if (
    !matchMedia(PHONE).matches ||
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
// Back in the app on the newest commit: read the uncommitted changes again, because files may
// have changed.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || busy || viewingPr || !metadata)
    return;
  if (headRef !== shownRevision(metadata.initialHead)) return;
  const fresh = await api(
    "/api/repo" +
      (viewingBranch ? "?" + new URLSearchParams({ head: viewingBranch }) : ""),
  ).catch(() => null);
  const snapshot = (data) => data?.commits[0]?.uncommitted?.sha || null;
  if (
    fresh &&
    (fresh.initialHead !== metadata.initialHead ||
      snapshot(fresh) !== snapshot(metadata))
  )
    boot(true).catch(() => {});
});
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
  // A menu or a dialog handles its own Escape (it closes, and only it).
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
  // Escape steps back as the Back button does. The keyboard focus stays where the owner was:
  // on the map (its selected card, else the map itself), or in the sheet's header row.
  const inMap = Boolean(event.target.closest?.("#deck"));
  goBack();
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const map = document.querySelector('.sheet[data-front="true"]');
    const target = inMap
      ? map?.querySelector(".node.sel") || map?.querySelector(".map-canvas")
      : document.querySelector("#viewHead:not([hidden]) button") ||
        map?.querySelector(".map-canvas");
    target?.focus({ preventScroll: true });
  });
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
  // A session may have started or ended since the map was drawn.
  renderMapLegend();
  $("#revisionDetails").open = false;
  // Fit the key between the map's top edge and its floating toolbar; it scrolls beyond that.
  const map = $(".sheet-body")?.getBoundingClientRect(),
    tools = $(".map-tools")?.getBoundingClientRect();
  if (map && tools) {
    const popover = $("#mapLegend .legend-popover");
    popover.style.maxHeight = Math.max(160, tools.top - map.top - 16) + "px";
    // Its padding and border add to that height: keep its top inside the map, so the first
    // part of the key is never cut off.
    requestAnimationFrame(() => {
      const over = map.top + 8 - popover.getBoundingClientRect().top;
      if (over > 0)
        popover.style.maxHeight =
          Math.max(120, parseFloat(popover.style.maxHeight) - over) + "px";
    });
  }
});
$("#revisionDetails").addEventListener("toggle", () => {
  if ($("#revisionDetails").open) $("#mapLegend").open = false;
});
/** Pairs with the access link in the address, if any: on load, and when a second link opens
 * in the same tab (only the part after # changes, so the page does not load again). */
function pairFromLink() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return false;
  replaceUrl(location.pathname + location.search);
  pair(token).catch((error) => {
    showNotice(error.message, true);
    $("#connect").hidden = false;
    $("#login-error").textContent = error.message;
  });
  return true;
}
addEventListener("hashchange", pairFromLink);
if (!pairFromLink()) boot().then(restorePlace);

/** Fits the app to the area above a phone keyboard. With Chrome's resizes-content keyboard
 * mode the layout itself shrinks; elsewhere the app follows the visual viewport. Because the
 * window shrinks too, the keyboard is detected from a focused text field plus a large drop
 * from the tallest height seen at this width, not from innerHeight. */
const tallestHeight = new Map();
let fittedHeight = 0;
function fitVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale > 1.05) return;
  // A real resize invalidates a sheet drag; focus changes alone (pressing the handle) do not.
  if (sheetPointer && Math.abs(viewport.height - fittedHeight) > 1)
    finishSheetDrag({ pointerId: sheetPointer.id }, true);
  fittedHeight = viewport.height;
  const width = Math.round(viewport.width),
    tallest = Math.max(tallestHeight.get(width) || 0, viewport.height);
  tallestHeight.set(width, tallest);
  const typing = !!document.activeElement?.matches?.(
      "input, textarea, [contenteditable]",
    ),
    keyboard = typing && viewport.height < tallest * 0.8;
  // A focused field can scroll the page; undo it so the offset below is not applied twice.
  if (keyboard && window.scrollY) window.scrollTo(0, 0);
  const root = document.documentElement;
  root.style.setProperty("--viewer-height", `${viewport.height}px`);
  root.style.setProperty("--viewer-top", `${viewport.offsetTop}px`);
  root.classList.toggle("keyboard-open", keyboard);
}
window.visualViewport?.addEventListener("resize", fitVisualViewport);
window.visualViewport?.addEventListener("scroll", fitVisualViewport);
for (const type of ["focusin", "focusout"])
  document.addEventListener(type, () =>
    requestAnimationFrame(fitVisualViewport),
  );
fitVisualViewport();

// Tapping empty map space leaves Tasks, or else clears the selection, as Escape does.
// Cards, lines and map controls keep their own actions; a drag is not a tap.
let stagePress = null;
$("#stage").addEventListener("pointerdown", (event) => {
  stagePress = { x: event.clientX, y: event.clientY, at: performance.now() };
});
$("#stage").addEventListener("click", (event) => {
  const dragged =
    stagePress &&
    event.detail !== 0 &&
    // A drag, or a long press, is not a tap.
    (Math.hypot(event.clientX - stagePress.x, event.clientY - stagePress.y) >
      5 ||
      performance.now() - stagePress.at > 450);
  // The path from when the tap began: a control that redrew itself during its own click
  // (the Follow eye) is no longer the target's ancestor, but it is still in the path.
  const control =
    '.node, [role="button"], button, a, summary, details, input, select';
  if (dragged || event.composedPath().some((n) => n.matches?.(control))) return;
  // A list or a task gives way to the map; on the map, the selection clears.
  if (nav.view().name !== "inspect" && !onThread()) nav.back();
  else if (selected) {
    selected = null;
    held = null;
    renderDeck();
    renderPanel();
  }
});
