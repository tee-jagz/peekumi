/** @module Anchored drafts, exact task previews, run reports and human verification. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";
import {
  Button,
  Checkbox,
  Command,
  Composer,
  Disclosure,
  FactGrid,
  IconButton,
  InlineError,
  List,
  Note,
  PickRow,
  DataNote,
  EvidenceItem,
  EvidenceQuestion,
  EvidenceSection,
  InboxCue,
  InboxRow,
  ProvenanceChips,
  RuleCheck,
  SegmentedControl,
  Spinner,
  Stack,
  Text,
  Actions,
  Row,
  Modal,
  openModal,
  Prose,
  TextArea,
  TextField,
} from "./ui.js";
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  n.className = cls || "";
  if (text !== undefined) n.textContent = text;
  return n;
};
const states = {
  draft: "Draft",
  with_agent: "With agent",
  addressed: "Ready for review",
  flagged: "Flagged",
  verified: "Approved",
  unreported: "Not done",
};
const active = (r) => ["starting", "running", "interrupted"].includes(r.status);
/** Short anchor for the one-line dock: file name plus declaration, never the full path. */
const dockLabel = (a) =>
  [a.path?.split("/").at(-1) || "Repository", a.symbol || a.target]
    .filter(Boolean)
    .join(" · ");
const label = (a) =>
  a.symbol
    ? `${a.path} · ${a.symbol}`
    : a.kind === "edge"
      ? `${a.path} → ${a.target} · ${a.relationship}`
      : a.path || "Repository";

/** An agent's error line in plain words: no "Error:" prefix, and each path shortened to its
 * file name, so no host path (a temporary folder, a home folder) reaches the screen. */
const plainError = (line = "") =>
  String(line)
    .replace(/^\s*(error|Error):\s*/, "")
    .replace(/(?:~|[A-Za-z]:)?(?:\/[^\s'"`/]+){2,}\/?/g, (path) =>
      path.replace(/\/$/, "").split("/").pop(),
    )
    .slice(0, 300);
/** Extracts only user-facing agent messages and activity labels from JSONL.
 * Partial lines and tool payloads stay in diagnostics, never in the conversation. */
export function agentActivity(output = "") {
  const messages = [],
    errors = [];
  let activity = "Preparing the task…";
  for (const line of output.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (/^(error:|Error:)/.test(line)) errors.push(plainError(line));
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const item = event.item;
    if (item?.type === "agent_message" && item.text) messages.push(item.text);
    if (event.type === "assistant") {
      for (const part of event.message?.content || []) {
        if (part.type === "text" && part.text) messages.push(part.text);
        if (part.type === "tool_use")
          activity = "Working on the requested changes…";
      }
    }
    if (event.type === "result" && event.result && !event.is_error)
      messages.push(event.result);
    if (
      event.type === "error" ||
      event.type === "turn.failed" ||
      event.is_error
    ) {
      const reason = event.error?.message || event.message || event.result;
      if (typeof reason === "string") errors.push(plainError(reason));
    }
    if (item?.type === "command_execution") {
      activity = /\b(test|pytest|cargo test|playwright)\b/.test(
        item.command || "",
      )
        ? "Checking the changes…"
        : "Inspecting the repository…";
      if (item.status === "failed") activity = "Investigating a failed check…";
    }
    if (item?.type === "file_change") activity = "Editing files…";
  }
  return {
    messages: [...new Set(messages)].slice(-5),
    errors: errors.slice(-2),
    activity,
  };
}
/** Converts a unified patch into readable rows with old/new line numbers. */
export function diffRows(patch = "") {
  const rows = [];
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of (patch || "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({
        kind: "hunk",
        text: `Around line ${newLine || oldLine}${hunk[3] ? " · " + hunk[3].trim() : ""}`,
      });
    } else if (inHunk && /^[ +\-]/.test(line)) {
      const kind =
        line[0] === "+" ? "addition" : line[0] === "-" ? "deletion" : "context";
      rows.push({
        kind,
        text: line.slice(1),
        old: kind === "addition" ? "" : oldLine++,
        new: kind === "deletion" ? "" : newLine++,
      });
    } else if (line.startsWith("diff --git")) inHunk = false;
  }
  return rows;
}
/** Appends a mobile unified diff without Git transport headers; source remains plain text. */
export function renderDiff(host, patch) {
  const rows = diffRows(patch);
  if (!rows.length) {
    host.append(
      el("p", "read-note", "No readable text changes in this selection."),
    );
    return;
  }
  const key = el(
    "p",
    "diff-key",
    "+ Added · − Removed · left line: before / right line: after",
  );
  host.append(key);
  const code = el("div", "readable-diff");
  code.tabIndex = 0;
  code.setAttribute("aria-label", "Code changes");
  for (const row of rows) {
    const line = el("div", "code-line " + row.kind);
    if (row.kind === "hunk")
      line.append(el("span", "diff-hunk-label", row.text));
    else
      line.append(
        el("span", "line-number", row.old),
        el("span", "line-number", row.new),
        el(
          "span",
          "diff-sign",
          row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : "",
        ),
        el("code", "diff-text", row.text || " "),
      );
    code.append(line);
  }
  host.append(code);
}
/** Creates a panel controller; writes are explicit owner actions and poll updates preserve input. */
export function createWorkflow({
  api,
  // The agent choice for tasks and Ask on this device (see agents.js).
  agents,
  context,
  // The view stack (nav.js): which list, form or run the sheet shows, and the way back.
  nav,
  // The header row of a page (app.js viewHead): back, a title, a quiet line and actions.
  head = () => {},
  // Opens the map's dock in Instruction mode, for a new instruction (app.js).
  writeInstruction = () => {},
  // More buttons for the Tasks page's header row (the notifications bell, see notify.js).
  taskActions = () => [],
  // A commit's short name: "uncommitted" for the snapshot of uncommitted changes.
  revisionName = (sha) => sha.slice(0, 7),
  redraw,
  notice,
  inspect,
  explore,
  exploring,
  // Called after Peekumi moves the target branch (a merge, an undo, the owner's commit).
  moved = () => {},
  // Shows a session's branch on the map, at a file when a path is given (see session.js).
  showOnMap = async () => {},
  // Moves the map to a place that a session's message names, and keeps the session on screen.
  openPlace = async () => {},
  // The map's agent focus (focus.js), which shows where a run's agent is.
  focus = { set() {}, ownerMoved() {}, moving: () => false },
  // The session feature (session.js), which app.js gives here: one feature module never
  // imports another, so each one can change alone.
  sessions,
  // Notifications on this device (notify.js), for "Tell me when it is done".
  notifications = { isOn: () => false, canTurnOn: () => false, ensureOn() {} },
  // Review Inbox navigation helpers for committed branches and already-loaded read-only PRs.
  openBranch = () => {},
  openPr = () => {},
  loadedPrs = () => [],
}) {
  const {
    createSession,
    live,
    activity,
    focusOf,
    syncItems,
    itemsOf,
    seqOf,
    changedOf,
    savedPermissions,
    savePermissions,
  } = sessions;
  let data = { comments: [], runs: [] },
    loaded = false,
    lastSignature = "",
    refreshQueue = Promise.resolve();
  let composer = null,
    draft = "",
    editing = null,
    preview = null;
  // The end of an open session's log while another view is open (see cueLive).
  let brief = "",
    picks = new Set(),
    // The send sheet: "background" starts a task, "live" a session (With me). A preview is
    // being made while `previewing` is true; `notifyMe` is the owner's choice for this send.
    sendMode = "background",
    previewing = false,
    notifyMe = true,
    runDetail = null,
    // The open task's merge state from the server (see backend/merge.rs), or null.
    mergeInfo = null,
    // Below a finished task's actions: null, or "note" while the Approve note is open.
    reply = null;
  let verificationNote = "";
  /** The run on screen (a task or a session), from the view on top, or null. */
  const runId = () => (nav.view().name === "run" ? nav.view().id : null);
  const write = (path, body, method = "POST") =>
    api(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const action = (text, fn, primary = false) => {
    const b = el("button", "btn" + (primary ? " primary" : ""), text);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        notice(e.message, true);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  const field = (title, value, changed, rows = 3) => {
    const l = el("label", "workflow-field", title),
      t = el("textarea");
    t.rows = rows;
    t.setAttribute("aria-label", title);
    t.value = value;
    t.maxLength = 20000;
    t.oninput = () => changed(t.value);
    l.append(t);
    return l;
  };
  const session = createSession({
    write,
    refresh: () => refresh(),
    notice,
    context,
    using: (job) => agents.using(job),
    agentName: (id) => agents.short(id),
    asksBeforeCommands: (id) => agents.asksBeforeCommands(id),
    capabilities: (id) => agents.capabilities(id),
    openTask: (id) => openTask(id),
    showOnMap: (r, path) => showOnMap(r, path),
    openPlace: (target) => openPlace(target),
    pointed: () => ownerPointed,
    sent: () => (ownerPointed = false),
    references: (body) => write("/api/references", body),
    back: () => nav.back(),
  });
  /** The open session: the one on screen, else the one the owner opened last (while it is
   * open), else the newest still open. */
  let lastSession = null;
  function liveSession() {
    const shown =
      runDetail && runDetail.id === runId() && live(runDetail)
        ? runDetail
        : null;
    if (shown) lastSession = shown.id;
    const last = data.runs.find((r) => r.id === lastSession && live(r));
    return shown || last || data.runs.slice().reverse().find(live) || null;
  }
  /** The finished task on screen, when it can still collect changes for a next round. */
  function viewedTask() {
    const r = runDetail;
    if (!r || r.id !== runId()) return null;
    return !active(r) &&
      !live(r) &&
      !endedSession(r) &&
      r.status !== "preview" &&
      !r.revisedBy &&
      !r.applied
      ? r.id
      : null;
  }
  /** A session that the owner ended without review: a closed record, not a failed task. */
  const endedSession = (r) => r?.kind === "session" && r.status === "cancelled";
  /** Drafts waiting for a new task; those collected for a finished task go back with it. */
  const sendable = (c) => c.status === "draft" && !c.forRun;
  /** Instructions collected for task `id`'s next round while exploring its changes. */
  const collected = (id) =>
    data.comments.filter((c) => c.forRun === id && c.status === "draft");
  /** Reloads workflow state. `render` redraws the open view; "poll" redraws only when the
   * data changed and a task view is open, so polling never rebuilds Source or Details. */
  function refresh(render = true) {
    const pending = refreshQueue
      .catch(() => {})
      .then(async () => {
        data = await api("/api/workflow");
        inboxData = await api("/api/inbox").catch(() => inboxData);
        loaded = true;
        const shown = runId();
        if (shown) runDetail = await api("/api/runs/" + shown);
        if (
          !autoOpenedOnce &&
          verifyActions.autoOpenEnabled() &&
          nav.view().name === "inspect" &&
          data.runs.some((r) => r.kind !== "session" && stageOf(r) === "needs")
        ) {
          autoOpenedOnce = true;
          nav.go({ name: "tasks" });
        }
        // The conversation of the run on screen, and of a running run or an open session
        // outside its view (for the sheet's line and the map's agent focus): only the items
        // that changed since the last read (see backend/conversation.rs).
        const open = data.runs
          .slice()
          .reverse()
          .find((r) => active(r) || live(r));
        for (const id of new Set([shown, open?.id].filter(Boolean)))
          await syncItems(api, id).catch(() => {});
        // A task to approve, approved or merged shows what a merge would do now: before the
        // approval, the server's `next` decides between Approve and Approve and merge.
        const r = shown && runDetail?.id === shown && runDetail;
        // A finished run also needs it for the files its agent left uncommitted (`loose`).
        mergeInfo =
          r &&
          ["completed", "failed", "cancelled"].includes(r.status) &&
          !r.revisedBy
            ? await api(`/api/runs/${r.id}/merge`).catch(() => null)
            : null;
        bar();
        const signature = JSON.stringify([
            data,
            runDetail,
            mergeInfo,
            shown && seqOf(shown),
          ]),
          changed = signature !== lastSignature;
        lastSignature = signature;
        // A poll redraws only a page that shows this data (never the map's own views).
        if (render === "poll")
          render =
            changed &&
            [
              "tasks",
              "history",
              "instructions",
              "run",
              "conversations",
            ].includes(nav.view().name);
        if (render) {
          const focused = document.activeElement;
          const focusLabel = focused?.matches("textarea,input,select")
            ? focused.getAttribute("aria-label")
            : null;
          const selection =
            focused?.tagName === "TEXTAREA"
              ? [focused.selectionStart, focused.selectionEnd]
              : null;
          const opened = [
            ...document.querySelectorAll("#tabBody details[open]"),
          ]
            .map((d) => d.dataset.key)
            .filter(Boolean);
          const kept = document.querySelector("#viewHead .task-peek");
          redraw();
          // The same Peek carries on across a redraw rather than restarting its loop.
          const fresh = document.querySelector("#viewHead .task-peek");
          if (kept && fresh && kept.dataset.state === fresh.dataset.state)
            fresh.replaceWith(kept);
          for (const d of document.querySelectorAll("#tabBody details"))
            if (opened.includes(d.dataset.key)) d.open = true;
          if (focusLabel) {
            const field = [
              ...document.querySelectorAll("textarea,input,select"),
            ].find((n) => n.getAttribute("aria-label") === focusLabel);
            field?.focus({ preventScroll: true });
            if (field && selection) field.setSelectionRange(...selection);
          }
        } else updateLive();
      });
    refreshQueue = pending;
    return pending;
  }
  // The Tasks button's look: "working", "attention", "ready" or "" (its usual icon).
  let cue = "",
    tasksIcon = null,
    settle = 0;
  /** A task stopped partway with instructions still open: it waits for the owner. */
  const stalled = (r) =>
    ["failed", "interrupted"].includes(r.status) &&
    !r.revisedBy &&
    open(r).length > 0;
  /** The task the Tasks button opens directly: one running, else one that stopped. */
  function focusRun() {
    return (data.runs.find(active) || data.runs.find(stalled))?.id || null;
  }
  /** Shows a running or stalled task on the Tasks button, visible from every view: Peek
   * works in place of the icon while an agent runs, hops once when it finishes, and droops
   * on a warm tint when a task stopped partway. Rebuilt only when the state changes, so
   * polling never restarts the animation. */
  function cueTasks(button, ready) {
    tasksIcon ||= button.querySelector("svg");
    // Tasks only: an open session shows in the sheet's live line (see cueLive).
    const running = data.runs.find((r) => active(r) && r.kind !== "session"),
      stuck = !running && data.runs.find(stalled);
    const waitingCount = ready.length + loadedPrs().length;
    const next = running
      ? "working"
      : stuck
        ? "attention"
        : waitingCount > 0
          ? "ready"
          : "";
    const cueKey = next === "ready" ? `ready:${waitingCount}` : next;
    const agent = (r) => agents.label(r.agent);
    const label = running
      ? `${agent(running)} is working on a task`
      : stuck
        ? "A task stopped and needs your attention"
        : waitingCount > 0
          ? `Tasks, ${waitingCount} waiting on you`
          : "Tasks";
    button.setAttribute("aria-label", label);
    button.title =
      running || stuck
        ? label
        : waitingCount > 0
          ? `${waitingCount} change${waitingCount === 1 ? "" : "s"} waiting for your review`
          : "Open tasks";
    if (cueKey === cue) return;
    const finished = cue === "working" && next !== "working";
    cue = cueKey;
    clearTimeout(settle);
    button.dataset.cue = next;
    button.dataset.ready = String(next === "ready");
    if (next === "working") button.replaceChildren(peek("working"));
    else if (next === "attention") button.replaceChildren(peek("stopped"));
    else if (finished && next === "ready") {
      // One short hop as the agent finishes, then the amber waiting pill.
      button.replaceChildren(peek("ready"));
      settle = setTimeout(
        () =>
          cue === cueKey &&
          button.replaceChildren(tasksIcon, InboxCue(waitingCount)),
        2600,
      );
    } else if (next === "ready") {
      button.replaceChildren(tasksIcon, InboxCue(waitingCount));
    } else button.replaceChildren(tasksIcon);
  }
  /** The sheet's live line: a small Peek and one state word at the right of the sheet's title
   * row (the selection's name, or a page's header row), for an agent at work or an open
   * session that is not on screen: a request that waits for the owner first, then work in
   * progress, then a session that waits for a reply. A tap opens it. It adds no row and no
   * box. One element for the life of the page: the title rows are drawn again, and it goes
   * back into the row on screen. It is rebuilt only when what it says changes, so Peek's
   * animation carries on. */
  let liveLine = null;
  function cueLive() {
    // The map shows where the agent is, from every view (see focus.js).
    runFocus();
    liveLine ??= document.querySelector("#liveLine");
    const line = liveLine;
    if (!line) return;
    const row =
      nav.view().name === "inspect"
        ? document.querySelector("#reviewScope")
        : document.querySelector(
            "#viewHead .view-head, #viewHead .pk-page-header",
          );
    if (row && line.parentElement !== row) row.append(line);
    const view = nav.view(),
      runs = data.runs.slice().reverse(),
      waitingTasks = runs.filter(
        (x) => x.kind !== "session" && stageOf(x) === "needs",
      );
    const r =
      runs.find((x) => live(x) && x.approval) ||
      runs.find((x) => live(x) && x.status === "running") ||
      runs.find((x) => active(x) && x.kind !== "session") ||
      runs.find(live) ||
      (view.name === "tasks" ? null : waitingTasks[0]);
    line.hidden = !r || (view.name === "run" && view.id === r.id);
    if (line.hidden) return;
    const session = r.kind === "session";
    // What the agent does now, from the items of its conversation.
    const full = runDetail?.id === r.id ? runDetail : r;
    const now = session
      ? activity(full)
      : active(r)
        ? { state: "running", title: "Working", label: taskTitle(r), code: "" }
        : {
            state: "needs",
            title: `${waitingTasks.length} waiting`,
            label: taskTitle(r),
            code: "",
          };
    const name = session ? r.title || "Session" : taskTitle(r);
    // Just out of a running session's view: read its conversation now, not at the next poll.
    if (session && r.status === "running" && !seqOf(r.id) && !tailLoading) {
      tailLoading = true;
      syncItems(api, r.id)
        .catch(() => {})
        .finally(() => {
          tailLoading = false;
          cueLive();
        });
    }
    const plain = (t) => t.replace(/[`*#>]/g, "").trim();
    const what =
      `${now.title}${now.label ? ": " + plain(now.label) : ""}${now.code ? " " + now.code : ""}`.replace(
        /[.\s]+$/,
        "",
      );
    const label = `${session ? "Session" : "Task"} ${name} · ${what}. Open it`;
    line.setAttribute("aria-label", label);
    line.title = label;
    line.onclick = () => openTask(r.id);
    const key = [r.id, now.state, now.title].join("|");
    if (line.dataset.key === key) return;
    line.dataset.key = key;
    line.dataset.state = now.state;
    line.replaceChildren(
      peek(
        now.state === "running"
          ? now.pose || "working"
          : now.state === "needs"
            ? "thinking"
            : "ready",
        { className: "live-peek" },
      ),
      el("span", "live-state", now.title),
    );
  }
  let tailLoading = false;
  // True once the owner moved or selected on the map since their last session message.
  let ownerPointed = false;
  /** The run whose agent the map shows (see focus.js): an agent at work first (the one on
   * screen, else any), then the open session on screen, then any open session. */
  function markedRun() {
    const shown = runDetail?.id === runId() ? runDetail : null;
    // The run on screen comes from a later read than the list: its copy is the newer one.
    const all = data.runs
      .slice()
      .reverse()
      .map((r) => (r.id === shown?.id ? shown : r));
    if (shown && active(shown)) return shown;
    return (
      all.find(active) ||
      (shown && live(shown) ? shown : null) ||
      all.find(live) ||
      null
    );
  }
  /** Gives the map's agent focus where the marked run's agent is, from the fullest copy of
   * its log at hand: the open run, the end of its log, or nothing yet. */
  function runFocus() {
    const r = markedRun();
    if (!r) return focus.set("run", null);
    const full = runDetail?.id === r.id ? runDetail : r;
    const where = focusOf(itemsOf(r.id));
    focus.set("run", {
      running: r.status === "running",
      live: live(r),
      activity: where.activity,
      current: where.current,
      trail: where.trail,
      changed: full.changed || changedOf(r.id),
    });
  }
  function bar() {
    cueLive();
    const host = document.querySelector("#runBar");
    host.replaceChildren();
    const ready = data.runs.filter(
      (r) =>
        r.status === "completed" &&
        !r.applied &&
        data.comments.some((c) => c.runId === r.id && c.status === "addressed"),
    );
    const tasksButton = document.querySelector("#openTasks");
    // The cue is Peek or the icon colour plus the accessible name, never a count badge.
    if (tasksButton) cueTasks(tasksButton, ready);
    // Changes that wait to be sent show in the tray (the sheet's title row, app.js); work in
    // progress shows in the live line.
  }
  /** True when instruction `c` is on the map's selection (or inside it). */
  function visible(c) {
    if (c.status === "deleted") return false;
    const a = context().anchor;
    if (a.kind === "repo") return true;
    if (a.kind === "symbol")
      return c.anchor.path === a.path && c.anchor.symbol === a.symbol;
    if (a.kind === "edge")
      return c.anchor.path === a.path && c.anchor.target === a.target;
    return c.anchor.path === a.path || c.anchor.path.startsWith(a.path + "/");
  }
  async function transition(c, op, extra = {}) {
    await write(
      "/api/comments/" + c.id,
      { action: op, version: c.version, ...extra },
      "PATCH",
    );
    await refresh();
  }
  /** The map's composer (ui.js Composer, intent): one field, then Add as a change (a draft
   * at the current place, for the tray) or Ask (`onAsk` gets the text). While a task's
   * changes are explored, a change joins that task's requested changes. Returns the place
   * line for the dock. */
  function renderIntent(composerHost, { onAsk, asking = false }) {
    if (!composer || (!draft && !editing && !composer.pinned))
      composer = context();
    if (!composer) return "";
    const target = editing ? null : exploring() || viewedTask();
    const place =
      dockLabel(composer.anchor) +
      " · " +
      (composer.sha.startsWith("refs/heads/")
        ? composer.sha.slice(11)
        : revisionName(composer.sha));
    composerHost.append(
      Composer({
        intent: true,
        docked: true,
        place: null,
        value: draft,
        asking,
        onInput: (text) => {
          draft = text;
          if (text) {
            if (!composer) composer = context();
            if (composer) composer.pinned = true;
          }
        },
        onAdd: async (text) => {
          draft = text;
          if (!draft.trim()) return;
          try {
            if (target) {
              await write("/api/comments", {
                ...composer,
                text: draft,
                forRun: target,
              });
              notice("Added to this task's requested changes");
            } else {
              await write("/api/comments", { ...composer, text: draft });
              notice("Change added. Send it from the tray.");
            }
            setTimeout(() => notice(""), 2500);
            composer = null;
            draft = "";
            await refresh();
          } catch (e) {
            notice(e.message, true);
          }
        },
        onSend: (text) => {
          draft = "";
          composer = null;
          onAsk(text);
        },
      }),
    );
    return place;
  }
  /** Renders the persistent draft input independently of the current inspection view. */
  function renderComposer(composerHost) {
    if (!composer || (!draft && !editing && !composer.pinned))
      composer = context();
    if (composer) {
      const box = el("section", "composer");
      box.append(
        el(
          "p",
          "composer-anchor",
          (editing ? "Edit · " : "") +
            dockLabel(composer.anchor) +
            " · " +
            (composer.sha.startsWith("refs/heads/")
              ? composer.sha.slice(11)
              : revisionName(composer.sha)),
        ),
        field("What should change, and why", draft, (v) => (draft = v), 1),
      );
      const buttons = el("div", "sel-acts");
      const target = editing ? null : exploring() || viewedTask();
      const save = action(
        target ? "Add to requested changes" : "Save draft",
        async () => {
          if (target) {
            // Collected for the explored task's next round; exploring carries on.
            await write("/api/comments", {
              ...composer,
              text: draft,
              forRun: target,
            });
            composer = null;
            draft = "";
            notice("Added to this task's requested changes");
            setTimeout(() => notice(""), 2000);
            await refresh();
            // On the task itself, bring the button that sends the list into view.
            document
              .querySelector("#sendChanges")
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
            return;
          }
          if (editing)
            await write(
              "/api/comments/" + editing.id,
              { action: "edit", version: editing.version, text: draft },
              "PATCH",
            );
          else await write("/api/comments", { ...composer, text: draft });
          // The view stays: a new draft is counted under Details, and Tasks lists it.
          if (!editing) {
            notice("Saved as a draft. Tasks lists it.");
            setTimeout(() => notice(""), 2500);
          }
          composer = null;
          draft = "";
          editing = null;
          await refresh();
        },
        true,
      );
      const cancel = action("Cancel", () => {
        composer = null;
        draft = "";
        editing = null;
        redraw();
      });
      iconButton(cancel, "close", "Cancel");
      iconButton(
        save,
        "check",
        target ? "Add to requested changes" : "Save draft",
      );
      for (const b of [cancel, save]) b.classList.add("icon-action");
      buttons.append(cancel, save);
      const input = box.querySelector("textarea");
      // Nothing to save until something is written.
      save.disabled = !draft.trim();
      input.addEventListener(
        "input",
        () => (save.disabled = !input.value.trim()),
      );
      input.placeholder = target
        ? "What should change in this work?"
        : "What should change, and why?";
      input.setAttribute("aria-label", "What should change, and why");
      input.parentElement.firstChild.textContent = "";
      input.parentElement.classList.add("dock-input");
      box.append(buttons);
      buttons.classList.add("draft-buttons");
      composerHost.append(box);
    }
  }
  /** A list of instructions: on the map's selection (the "instructions" view), the Tasks
   * list (the "tasks" view), or the instructions of `task`. */
  function comments(body, task = null) {
    const name = nav.view().name;
    const here = !task && name === "instructions";
    if (here) {
      head(`Instructions · ${label(context().anchor)}`);
      body.append(
        el("p", "read-note", "Drafts wait here until you send them as a task."),
      );
    }
    const overview = !task && name === "tasks";
    if (!task && name === "history") {
      history(body);
      return;
    }
    if (overview) {
      // The Agents sheet opens from here; the line says what a new task uses.
      // Agents is a quiet icon in the header row, as the back arrow is.
      const choose = IconButton({
        icon: "agents",
        label: "Agents",
        quiet: true,
        onClick: () => agents.open(null, () => redraw()),
      });
      choose.id = "openAgents";
      const shown = data.runs
        .filter((r) => r.status !== "preview" && !r.revisedBy)
        .slice()
        .reverse();
      // Open sessions are conversations (see Conversations); a session sent to review is work.
      const drafts = data.comments.filter(sendable);
      const needs = shown.filter((r) => stageOf(r) === "needs");
      const working = shown.filter((r) => stageOf(r) === "working");
      const branches = (inboxData?.needsYou || []).filter(
        (item) => item.kind === "branch",
      );
      const prs = loadedPrs();
      const totalWaiting = needs.length + prs.length;
      const meta = [
        totalWaiting ? `${totalWaiting} waiting on you` : "All caught up",
        working.length && `${working.length} working`,
      ]
        .filter(Boolean)
        .join(" · ");
      head("Tasks", {
        meta,
        actions: [...taskActions().filter(Boolean), choose],
      });
      const uses = agents.describe("task");
      if (uses)
        body.append(el("p", "read-note tasks-uses", `New tasks use ${uses}`));
      else
        agents
          .load()
          .then((c) => c && redraw())
          .catch(() => {});
      if (drafts.length || needs.length || prs.length)
        body.append(el("h3", "workflow-group", "Needs you"));
      if (drafts.length)
        body.append(
          action(
            `Send ${plural(drafts.length, "change")}`,
            () => openSend(),
            true,
          ),
        );
      // The drafts belong with the button that sends them, under Needs you.
      renderCards(body, drafts);
      // A task's earlier rounds open from its latest one. Tasks are grouped by what they
      // need from you; applied and closed tasks leave this list for History.
      body.append(...needs.map(taskCard));
      for (const pr of prs) {
        const chips = [];
        if (pr.isDraft) chips.push({ text: "Draft", tone: "quiet" });
        if (pr.reviewDecision === "CHANGES_REQUESTED")
          chips.push({ text: "Changes requested", tone: "open" });
        body.append(
          InboxRow({
            title: `PR #${pr.number} · ${pr.title}`,
            source: "GitHub PR",
            chips,
            onClick: () => openPr(pr.number),
          }),
        );
      }
      if (working.length)
        body.append(
          el("h3", "workflow-group", "Working"),
          ...working.map((r) => taskCard(r, false)),
        );
      const done = shown.filter((r) => stageOf(r) === "done");
      if (done.length)
        body.append(
          el("h3", "workflow-group quiet-group", "Done · waiting to merge"),
          ...done.map((r) => taskCard(r, true)),
        );
      if (branches.length)
        body.append(
          Disclosure(
            {
              summary: `Other branches (${branches.length})`,
              key: "other-branches",
            },
            Stack(
              ...branches.map((br) => {
                const v = br.verification;
                const ran = (v?.checks || []).filter(
                  (c) => c.observed !== "skipped",
                );
                const passed = ran.filter((c) => c.matched).length;
                const chip =
                  v?.state === "failed"
                    ? {
                        text: ran.length
                          ? `Checks failed · ${passed}/${ran.length} passed`
                          : "Checks failed",
                        tone: "bad",
                      }
                    : v?.state === "passed"
                      ? {
                          text: ran.length
                            ? `${passed}/${ran.length} checks passed`
                            : "Checks passed",
                          tone: "good",
                        }
                      : v?.state === "skipped"
                        ? { text: "No checks matched", tone: "open" }
                        : { text: "Not checked yet", tone: "quiet" };
                return InboxRow({
                  title: br.name || br.title,
                  chips: [chip],
                  urgent: v?.state === "failed",
                  onClick: () => openBranch(br.start, br.head, br.name),
                });
              }),
            ),
          ),
        );
    }
    const items = task
      ? data.comments.filter(
          (c) =>
            instructionsOf(task).some((snapshot) => snapshot.id === c.id) &&
            c.status !== "deleted",
        )
      : here
        ? data.comments.filter(visible)
        : // The Tasks list already shows its drafts under Needs you.
          [];
    if (here && !items.length) {
      const empty = el(
        "p",
        "empty",
        loaded
          ? `No instructions for ${label(context().anchor)} yet. Write one below.`
          : "Loading instructions…",
      );
      empty.prepend(peek(loaded ? "empty" : "loading"));
      body.append(empty);
    } else if (
      overview &&
      !data.comments.some(sendable) &&
      !data.runs.some(
        (r) =>
          r.status !== "preview" && !r.revisedBy && stageOf(r) !== "history",
      )
    )
      body.append(
        el(
          "p",
          "empty",
          loaded
            ? "No tasks yet. Write an instruction on the map to start one."
            : "Loading tasks…",
        ),
      );
    // On a selection, finished instructions (approved, or in an applied task) collapse into
    // one line, so drafts and open instructions stay in front.
    const settled = (c) =>
      c.status === "verified" ||
      data.runs.find((r) => r.id === c.runId)?.applied;
    const earlier = here ? items.filter(settled) : [];
    renderCards(body, here ? items.filter((c) => !settled(c)) : items, task);
    if (earlier.length) {
      const fold = el("details", "workflow-evidence earlier-instructions");
      fold.dataset.key = "earlier-instructions";
      fold.append(
        el(
          "summary",
          "",
          `${earlier.length} earlier instruction${earlier.length === 1 ? "" : "s"}`,
        ),
      );
      renderCards(fold, earlier);
      body.append(fold);
    }
    if (overview) {
      const past = data.runs.filter(
        (r) =>
          r.status !== "preview" && !r.revisedBy && stageOf(r) === "history",
      ).length;
      if (past) {
        const link = action(`History · ${past}`, () =>
          nav.go({ name: "history" }),
        );
        link.classList.add("link-button", "history-link");
        body.append(link);
      }
      body.append(
        Disclosure(
          { summary: "Inbox settings", key: "inbox-settings" },
          Checkbox({
            label: "Auto-open inbox when items wait",
            checked: verifyActions.autoOpenEnabled(),
            onChange: (e) => {
              verifyActions.setAutoOpen(e.target.checked);
              redraw();
            },
          }),
        ),
      );
    }
  }
  /** The instruction cards in `list`, grouped by state, added to `target`. */
  function renderCards(target, list, task = null) {
    for (const state of Object.keys(states)) {
      const group = list.filter((c) => c.status === state);
      if (!group.length) continue;
      if (state === "draft" && nav.view().name === "tasks")
        target.append(el("h3", "workflow-group", "Your draft instructions"));
      for (const c of group) {
        const card = el("article", "workflow-card");
        card.dataset.commentId = c.id;
        // The instruction comes first; where it was left is a quiet line under it.
        const foot = el("div", "cm-top");
        const anchor = action(label(c.anchor), () =>
          inspect(c.sha, c.sha, c.anchor),
        );
        anchor.classList.add("link-button");
        anchor.title = `Open ${label(c.anchor)} · left on ${c.uncommitted ? "uncommitted changes" : c.sha.slice(0, 7)}, ${new Date(c.createdAt).toLocaleString()}`;
        foot.append(anchor);
        // Inside a task its status line already says this, so only exceptions are labelled.
        if (!task || !["with_agent", "addressed"].includes(c.status)) {
          const state = el(
            "span",
            "card-state",
            c.forRun
              ? "To send with its task"
              : endedSession(task) && c.status === "unreported"
                ? "Not reviewed"
                : states[c.status],
          );
          state.dataset.state =
            endedSession(task) && c.status === "unreported"
              ? "ended"
              : c.status;
          foot.append(state);
        }
        card.append(richText(c.text, "workflow-text"), foot);
        const report = c.report;
        if (report) {
          // Keep long agent essays collapsed behind a toggle so signal stays first on mobile.
          const summaryText = String(report.note || report.reason || "").trim();
          if (summaryText.length > 180) {
            const lead =
              summaryText.split(/(?<=[.!?])\s+/)[0]?.slice(0, 160) ||
              summaryText.slice(0, 160);
            card.append(
              richText(
                lead + (lead.length < summaryText.length ? "…" : ""),
                "workflow-text report-text",
              ),
              Disclosure(
                { summary: "Full agent note" },
                richText(summaryText, "workflow-text report-text"),
              ),
            );
          } else if (summaryText) {
            card.append(richText(summaryText, "workflow-text report-text"));
          }
          if (
            report.checks &&
            (!task ||
              task.applied ||
              task.revisedBy ||
              task.status !== "completed")
          ) {
            card.append(
              Disclosure(
                { summary: "Agent-reported checks" },
                Prose(report.checks),
              ),
            );
          }
        }
        if (c.verification)
          card.append(
            el(
              "p",
              "verification-note",
              c.verification.note
                ? "Approved by you: " + c.verification.note
                : "Approved by you",
            ),
          );
        const controls = el("div", "sel-acts");
        if (c.status === "draft")
          controls.append(
            action("Edit", () => {
              editing = c;
              composer = { anchor: c.anchor, sha: c.sha };
              draft = c.text;
              redraw();
            }),
            action("Delete draft", () => transition(c, "delete")),
          );
        // Sent instructions are reviewed from their task: Approve or Request changes there.
        if (c.runId && !task)
          controls.append(action("View task", () => openTask(c.runId)));
        if (controls.childElementCount) card.append(controls);
        target.append(card);
      }
    }
  }
  /** Opens the send sheet with every change that waits, or with `ids` only. */
  function openSend({ ids, live: wantLive = sendMode === "live" } = {}) {
    picks = new Set(ids || data.comments.filter(sendable).map((c) => c.id));
    preview = null;
    sendMode = wantLive ? "live" : "background";
    nav.go({ name: "prepare" });
  }
  /** Makes the frozen preview of the task for the picked changes, once for each choice, so the
   * owner always sees the exact task before Start task. */
  async function ensurePreview() {
    if (preview || previewing || !picks.size || sendMode !== "background")
      return;
    previewing = true;
    try {
      preview = await write("/api/runs/preview", {
        using: agents.using("task"),
        commentIds: [...picks],
        brief,
      });
    } catch (e) {
      notice(e.message, true);
    } finally {
      previewing = false;
      redraw();
    }
  }
  /** The send sheet: the changes to send, how the work runs (a task in the background, or a
   * session with the owner), the exact task, and Start (docs/design/19-flows.md, flow 1). */
  function prepare(body) {
    const drafts = data.comments.filter(sendable);
    for (const id of [...picks])
      if (!drafts.some((c) => c.id === id)) picks.delete(id);
    const chosen = drafts.filter((c) => picks.has(c.id));
    const watched = (data.watched || "main").replace("refs/heads/", "");
    if (!agents.describe("task"))
      agents
        .load()
        .then((c) => c && redraw())
        .catch(() => {});
    const changed = () => {
      preview = null;
      redraw();
    };
    body.append(
      drafts.length
        ? List(
            ...drafts.map((c) =>
              PickRow({
                title: c.text,
                meta: label(c.anchor),
                checked: picks.has(c.id),
                onChange: (on) => {
                  if (on) picks.add(c.id);
                  else picks.delete(c.id);
                  changed();
                },
              }),
            ),
          )
        : Note("No changes wait to be sent. Add one from the map."),
      FactGrid([
        [
          "Starts from",
          preview ? `${watched} · ${preview.base.slice(0, 7)}` : watched,
        ],
        ["Agent", agents.describe("task") || "The default agent"],
      ]),
      Button({
        label: "Change agent",
        variant: "plain",
        onClick: () => agents.open("task", changed),
      }),
      SegmentedControl({
        label: "How it runs",
        value: sendMode,
        options: [
          { value: "background", label: "In the background" },
          { value: "live", label: "With me" },
        ],
        onChange: (mode) => {
          sendMode = mode;
          changed();
        },
      }),
    );
    const live = sendMode === "live";
    if (live && agents.asksBeforeCommands(agents.current("task")?.agent))
      body.append(
        Checkbox({
          label: "Allow all commands",
          checked: savedPermissions() === "allow",
          onChange: (e) => savePermissions(e.target.checked ? "allow" : "ask"),
        }),
      );
    if (notifications.canTurnOn())
      body.append(
        Checkbox({
          label: "Tell me when it is done",
          checked: notifyMe,
          onChange: (e) => (notifyMe = e.target.checked),
        }),
      );
    body.append(
      DataNote("The agent sends the code that it reads to its provider."),
    );
    const note = TextArea({
      label: "Extra instructions (optional)",
      value: brief,
      onInput: (e) => {
        brief = e.target.value;
        preview = null;
      },
    });
    // The exact task changes with the note: make it again when the field is left. A session
    // needs no preview, so nothing is redrawn there (a redraw would swallow the next tap).
    note
      .querySelector("textarea")
      .addEventListener("change", () => sendMode === "background" && changed());
    body.append(note);
    if (!live && chosen.length) {
      const blocked = agents.problem("task");
      if (blocked)
        body.append(
          InlineError({
            title: "Not ready",
            text: `${blocked}. Change it in Agents, or fix it on your computer.`,
          }),
        );
      if (preview)
        body.append(
          Disclosure(
            { summary: "The exact task" },
            Note(
              `${agents.label(preview.agent)} works on ${plural(preview.comments.length, "change")} on the new branch ${preview.branch}. ${watched} stays unchanged.`,
            ),
            Command(preview.task),
          ),
        );
      else {
        body.append(Spinner("Preparing the exact task"));
        ensurePreview();
      }
    }
    const start = Button({
      label: live ? "Start session" : "Start task",
      variant: "primary",
      block: true,
      disabled: !chosen.length || (!live && !preview),
      onClick: async () => {
        start.disabled = true;
        try {
          // The browser asks for the permission on this tap, before anything waits.
          if (notifyMe && notifications.canTurnOn())
            await notifications.ensureOn();
          if (live) {
            const first = chosen[0];
            // The first change is the first line, so it names the session; the others follow.
            const text = [
              first.text,
              ...chosen
                .slice(1)
                .map((c) => `- ${c.text} (at ${label(c.anchor)})`),
              brief,
            ]
              .filter(Boolean)
              .join("\n");
            const started = await write("/api/runs/session", {
              anchor: first.anchor,
              sha: first.sha,
              text,
              using: agents.using("task"),
              permissions: savedPermissions(),
            });
            // The session carries these changes now; they leave the tray.
            for (const c of chosen) await transition(c, "delete");
            brief = "";
            nav.back();
            await openTask(started.id);
            return;
          }
          const result = await write("/api/runs", { previewId: preview.id });
          preview = null;
          brief = "";
          // The sheet is done: the new task takes its place, over the list.
          nav.back();
          await openTask(result.id);
        } catch (e) {
          notice(e.message, true);
          start.disabled = false;
        }
      },
    });
    start.id = "dispatchRun";
    body.append(start);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  /** One line per changed file: its path and line counts. */
  function fileList(files) {
    const list = el("ul", "merge-files");
    for (const f of files) {
      const row = el("li");
      row.append(el("code", "", f.path));
      const counts = el("span", "merge-counts");
      if (f.added != null)
        counts.append(el("span", "merge-add", `+${f.added}`));
      if (f.removed)
        counts.append(" ", el("span", "merge-del", `−${f.removed}`));
      row.append(counts);
      list.append(row);
    }
    return list;
  }
  /** Opens a modal sheet; `build(box, close)` fills it. Closing removes it. */
  function sheet(label, build) {
    const dialog = el("dialog", "merge-dialog");
    dialog.setAttribute("aria-label", label);
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    dialog.addEventListener("cancel", close);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
    const box = el("div", "merge-sheet");
    dialog.append(box);
    document.body.append(dialog);
    dialog.showModal();
    build(box, close);
    return dialog;
  }
  /** Brings the target's new commits into the task. A clean update adds a merge commit, so
   * the approval is cleared and the owner approves the new head; a conflict opens the new
   * round in which the agent resolves it. */
  async function updateTask(r) {
    const out = await write(`/api/runs/${r.id}/update`, {});
    if (out.round) {
      notice(
        `The task and ${mergeInfo?.target || "main"} conflict. The agent resolves it in round ${out.round.round}.`,
      );
      setTimeout(() => notice(""), 5000);
      await openTask(out.round.id);
    } else {
      notice(
        `Updated with ${mergeInfo?.target || "main"}. No conflicts. Approve the new head.`,
      );
      setTimeout(() => notice(""), 3000);
      await refresh();
    }
  }
  /** The rule check of a task's last result (the server's `rule_check`): against the commit
   * that the owner started the task from, under the rules of that commit. Loaded once for each
   * pair of commits. A failure keeps its reason, so it never looks clean. */
  const ruleChecks = new Map();
  function ruleCheckOf(r) {
    const head = r.results?.at(-1);
    const start = r.start || r.base;
    if (!start || !head) return null;
    const key = `${start}:${head}`;
    if (!ruleChecks.has(key)) {
      ruleChecks.set(key, { loading: true });
      api(`/api/rule-check?start=${start}&head=${head}`)
        .then((check) => ruleChecks.set(key, { check }))
        .catch((e) =>
          ruleChecks.set(key, {
            failed: true,
            check: {
              state: "not checked",
              reason: `The rule check failed: ${e.message}`,
              head,
            },
          }),
        )
        .finally(redraw);
    }
    return { key, ...ruleChecks.get(key) };
  }
  /** The rule check of a task before Approve. It always shows, also when it finds nothing, and
   * a failed check offers Retry. */
  function ruleCheckView(r) {
    const known = ruleCheckOf(r);
    if (!known) return null;
    return RuleCheck({
      check: known.check,
      loading: known.loading,
      actions: known.failed
        ? [
            {
              label: "Retry",
              onClick: () => {
                ruleChecks.delete(known.key);
                redraw();
              },
            },
          ]
        : [],
    });
  }
  /** A fresh rule check of the commit that a merge moves to (`head`), for the merge
   * confirmation: the branch can change after the review. */
  function freshRuleCheck(r, head) {
    const start = r.start || r.base;
    if (!start || !head) return null;
    const shown = RuleCheck({ loading: true });
    api(`/api/rule-check?start=${start}&head=${head}`)
      .then((check) => shown.replaceWith(RuleCheck({ check })))
      .catch((e) =>
        shown.replaceWith(
          RuleCheck({
            check: {
              state: "not checked",
              reason: `The rule check failed: ${e.message}`,
              head,
            },
          }),
        ),
      );
    return shown;
  }
  /** Records the owner's approval of task `r` in one request, bound to the exact start and
   * head of the merge state `m` that the owner saw, with the note when one is written. The
   * server refuses when either commit changed (see backend/review.rs). */
  async function approve(r, m = mergeInfo) {
    if (!m?.start || !m?.head)
      throw new Error(
        "Peekumi could not read the task's commits. Check again, then approve.",
      );
    await write(`/api/runs/${r.id}/approve`, {
      start: m.start,
      head: m.head,
      note: verificationNote,
    });
    verificationNote = "";
    reply = null;
  }
  /** Asks the owner to confirm the merge, with the files it changes and what happens to
   * their checkout. Sends the exact state shown, so a change in between stops the merge.
   * With `approveFirst` (the instructions to approve), the same confirmation records the
   * approval, then merges; Approve only records the approval and stops. */
  function confirmMerge(r, m, approveFirst = null) {
    const title = approveFirst
      ? `Approve and merge into ${m.target}?`
      : "Merge into " + m.target;
    sheet(title, (box, close) => {
      const note = !m.checkedOut
        ? `${m.target} is not checked out, so only the branch moves. No files in your folder change.`
        : m.uncommitted
          ? `${m.target} is checked out in your folder. Your ${plural(m.uncommitted, "uncommitted change")} do not touch these files, and they stay as they are.`
          : `${m.target} is checked out in your folder. Its files change to the merged result.`;
      const buttons = el("div", "merge-buttons");
      buttons.append(
        action("Cancel", close),
        ...(approveFirst
          ? [
              action("Approve only", async () => {
                try {
                  await approve(r, m);
                } finally {
                  close();
                  await refresh();
                }
                requestAnimationFrame(() =>
                  document
                    .querySelector(".apply-step")
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                );
              }),
            ]
          : []),
        Object.assign(
          action(
            approveFirst ? "Approve and merge" : "Merge",
            async () => {
              try {
                if (approveFirst) await approve(r, m);
                await write(`/api/runs/${r.id}/merge`, {
                  target: m.targetSha,
                  head: m.head,
                });
              } catch (e) {
                // Something changed since the sheet opened: show what is in the way now.
                close();
                await refresh();
                throw e;
              }
              close();
              notice(`Merged into ${m.target}`);
              setTimeout(() => notice(""), 3000);
              await refresh();
              moved();
            },
            true,
          ),
          { id: "confirmMerge" },
        ),
      );
      box.append(
        el(
          "h2",
          "merge-title",
          approveFirst
            ? `Approve and merge ${plural(m.commits, "commit")} into ${m.target}?`
            : `Merge ${plural(m.commits, "commit")} into ${m.target}?`,
        ),
        el(
          "p",
          "read-note",
          `From ${r.branch} · fast-forward to ${m.head.slice(0, 7)}`,
        ),
        fileList(m.files || []),
        el("p", "merge-note", note),
        ...[freshRuleCheck(r, m.head || r.results?.at(-1))].filter(Boolean),
        buttons,
        el(
          "p",
          "read-note merge-foot",
          `Nothing is pushed. You can undo until ${m.target} changes.`,
        ),
      );
    });
  }
  /** Commits the owner's own files that block the merge: an agent drafts the message, the
   * owner checks the files and the message, then the task is brought up to date. */
  function commitMine(r, m) {
    sheet("Commit your changes", async (box, close) => {
      box.append(
        el("h2", "merge-title", `Commit your changes to ${m.target}?`),
        el("p", "read-note", "The agent writes a commit message…"),
      );
      let draft;
      try {
        draft = await write(`/api/runs/${r.id}/commit-draft`, {
          using: agents.using("ask"),
        });
      } catch (e) {
        box.replaceChildren(
          el("h2", "merge-title", "Cannot commit now"),
          el("p", "merge-note", e.message),
          action("Close", close),
        );
        return;
      }
      let message = draft.message;
      const others = (m.uncommitted || 0) - draft.files.length;
      const buttons = el("div", "merge-buttons");
      buttons.append(
        action("Cancel", close),
        Object.assign(
          action(
            "Commit",
            async () => {
              await write(`/api/runs/${r.id}/commit-mine`, {
                message,
                head: draft.head,
                hash: draft.hash,
              });
              close();
              moved();
              await updateTask(r);
            },
            true,
          ),
          { id: "commitMine" },
        ),
      );
      box.replaceChildren(
        el("h2", "merge-title", `Commit your changes to ${m.target}?`),
        el(
          "p",
          "read-note",
          `Only the ${plural(draft.files.length, "file")} in the way.` +
            (others > 0
              ? ` Your other ${plural(others, "change")} stay uncommitted.`
              : ""),
        ),
        fileList(draft.files),
        field(
          draft.agent
            ? "Commit message · written by the agent, you can edit it"
            : "Commit message · you can edit it",
          message,
          (value) => (message = value),
        ),
        buttons,
        el(
          "p",
          "read-note merge-foot",
          `The commit is yours, on ${m.target}. Nothing is pushed.`,
        ),
      );
    });
  }
  /** The step after approval: merge into the target branch on the owner's tap, or what is in
   * the way and the way past it. Null while there is nothing to merge. Peekumi never pushes. */
  /** Files the agent left uncommitted in its worktree: they are not in the task's results,
   * and a later round would not see them. The owner can keep them as one commit. */
  function looseStep(r) {
    // `loose` is a count, or why Peekumi cannot count (shown under Blind spots).
    const n = mergeInfo?.loose?.state === "counted" ? mergeInfo.loose.count : 0;
    if (!n || r.merge) return null;
    return Stack(
      Text(`The agent left ${plural(n, "file")} uncommitted.`),
      Note(
        "They are not part of this task's results, and a new round starts without them. You can keep them as one commit on the task branch, then review it.",
      ),
      Actions(
        {},
        Button({ label: "Keep these files", onClick: () => keepLoose(r) }),
      ),
    );
  }
  /** Shows the agent's loose files and commits exactly those on the owner's action. A
   * restricted file is listed but never read or kept. */
  function keepLoose(r) {
    const states = {
      new: "New",
      changed: "Changed",
      staged: "Staged",
      deleted: "Deleted",
    };
    const box = Stack(Note("Reading the agent's files…"));
    let close = () => {};
    close = openModal(
      Modal({ label: "Keep the agent's files", onClose: () => close() }, box),
    );
    (async () => {
      let loose;
      try {
        loose = await api(`/api/runs/${r.id}/loose`);
      } catch (e) {
        box.replaceChildren(
          Text(e.message),
          Actions({}, Button({ label: "Close", onClick: close })),
        );
        return;
      }
      let message = "Keep the work that the agent left uncommitted";
      const kept = loose.files.filter((f) => !f.restricted);
      box.replaceChildren(
        Stack(
          Text(`Commit ${plural(kept.length, "file")} on ${loose.branch}?`),
          List(
            ...loose.files.map((f) =>
              Row({
                title: f.path,
                meta: f.restricted
                  ? "Restricted: not kept, never read"
                  : states[f.state] +
                    (f.added == null
                      ? ""
                      : ` · +${f.added}${f.removed ? ` −${f.removed}` : ""}`),
                chevron: false,
                small: true,
              }),
            ),
          ),
          TextArea({
            label: "Commit message",
            value: message,
            onInput: (e) => (message = e.target.value),
          }),
          Note(
            "Peekumi commits in the agent's worktree, not in your folder. The work is not approved: review it as usual.",
          ),
          Actions(
            {},
            Button({ label: "Cancel", onClick: close }),
            Button({
              label: "Keep and commit",
              variant: "primary",
              disabled: !kept.length,
              onClick: async () => {
                try {
                  await write(`/api/runs/${r.id}/salvage`, {
                    message,
                    head: loose.head,
                    hash: loose.hash,
                  });
                } catch (e) {
                  box.replaceChildren(
                    Text(e.message),
                    Actions({}, Button({ label: "Close", onClick: close })),
                  );
                  return;
                }
                // The view behind the sheet is current before it shows again: a merge
                // started at once must see the new branch head.
                await refresh();
                close();
              },
            }),
          ),
        ),
      );
    })();
  }
  let inboxData = null,
    autoOpenedOnce = false;
  /** Cached CRAP comparisons by `start:head`, loaded alongside review evidence. */
  const crapChecks = new Map();
  /** Async API actions and caches for verification, inbox, acceptance, and CRAP (never build DOM elements). */
  const verifyActions = {
    autoOpenEnabled() {
      try {
        return localStorage.getItem("peekumi.autoOpenInbox") === "1";
      } catch {
        return false;
      }
    },
    setAutoOpen(on) {
      try {
        localStorage.setItem("peekumi.autoOpenInbox", on ? "1" : "0");
      } catch {}
    },
    splitArgv(raw) {
      const out = [];
      let cur = "",
        quote = "";
      for (const ch of String(raw || "").trim()) {
        if (quote) {
          if (ch === quote) quote = "";
          else cur += ch;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (/\s/.test(ch)) {
          if (cur) {
            out.push(cur);
            cur = "";
          }
        } else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    },
    inbox() {
      api("/api/inbox")
        .then((res) => {
          inboxData = res;
          redraw();
        })
        .catch(() => {});
    },
    crap(start, head) {
      if (!start || !head) return null;
      const key = `${start}:${head}`;
      if (!crapChecks.has(key)) {
        crapChecks.set(key, { loading: true });
        api(`/api/crap?${new URLSearchParams({ base: start, head })}`)
          .then((crap) => crapChecks.set(key, { crap }))
          .catch((e) =>
            crapChecks.set(key, {
              failed: true,
              reason: e.message,
            }),
          )
          .finally(redraw);
      }
      return { key, ...crapChecks.get(key) };
    },
    async start(r, prepare = false, configRef = null) {
      const start = mergeInfo?.start || r.start || r.base;
      const head = mergeInfo?.head || resultCommit(r);
      if (!start || !head) return;
      try {
        await write("/api/verify/runs", {
          start,
          head,
          prepare,
          runId: r.id,
          ...(configRef ? { configRef } : {}),
        });
        crapChecks.delete(`${start}:${head}`);
        notice(
          prepare
            ? "Preparing and running checks in sandbox…"
            : "Running checks in sandbox…",
        );
        setTimeout(() => notice(""), 3000);
        await refresh();
      } catch (e) {
        notice(e.message, true);
      }
    },
    async saveAcceptance(r, rawCmd, expectFailOnStart) {
      const command = this.splitArgv(rawCmd);
      if (!command.length) {
        notice(
          "Enter a shell-free command, for example: node --test test/model.test.mjs",
          true,
        );
        return;
      }
      try {
        await write(`/api/runs/${r.id}/acceptance`, {
          command,
          expectFailOnStart: Boolean(expectFailOnStart),
        });
        notice("Saved owner acceptance check. Run checks to verify.");
        setTimeout(() => notice(""), 3500);
        await refresh();
      } catch (e) {
        notice(e.message, true);
      }
    },
    async clearAcceptance(r) {
      try {
        await write(`/api/runs/${r.id}/acceptance`, { command: null });
        notice("Removed owner acceptance check.");
        setTimeout(() => notice(""), 3000);
        await refresh();
      } catch (e) {
        notice(e.message, true);
      }
    },
    async sendFailureBack(r, verifyRun) {
      const failed = (verifyRun.checks || []).filter(
        (c) => !c.matched && c.observed !== "skipped",
      );
      const details = failed
        .map((c) => {
          const tail = (c.output || "").trim().slice(-1500);
          return `Check "${c.name}" (${c.id}) ${c.observed} (expected ${c.expected}):\nCommand: ${(c.command || []).join(" ")}${tail ? `\nOutput:\n${tail}` : ""}`;
        })
        .join("\n\n");
      const feedback = `Fix the failed Peekumi verification check${failed.length === 1 ? "" : "s"}:\n\n${details}`;
      try {
        await write("/api/comments", {
          anchor: { kind: "repo", path: "" },
          sha: mergeInfo?.head || resultCommit(r) || r.base,
          text: feedback,
          forRun: r.id,
        });
        const next = await write(`/api/runs/${r.id}/revise`, { feedback });
        notice(`Sent failed checks back to the agent (round ${next.round}).`);
        setTimeout(() => notice(""), 4000);
        await openTask(next.id);
      } catch (e) {
        notice(e.message, true);
      }
    },
  };
  /** The results of Peekumi's own verification runs for a task, when the server has them
   * (`verification` on the run or on its merge state), as evidence items. Each result keeps
   * its own state; nothing adds them up to one verdict. */
  function verificationItems(r) {
    const found = r.verification ?? mergeInfo?.verification;
    const start = mergeInfo?.start || r.start || r.base;
    const head = mergeInfo?.head || resultCommit(r);
    const items = [];
    if (found && !Array.isArray(found) && found.id) {
      if (found.state === "running") {
        items.push(Spinner("Running checks in sandbox"));
      } else if (found.state === "blocked") {
        items.push(
          EvidenceItem({
            label: "Sandboxed verification blocked",
            outcome: "Blocked",
            tone: "open",
            meta: found.reason || found.summary,
          }),
        );
      } else {
        for (const c of found.checks || []) {
          const observed = String(c.observed || "unknown").toLowerCase();
          const outcomeLabel =
            {
              fail_to_pass: "Fail → Pass",
              weak_test: "Weak test",
              inconclusive: "Inconclusive",
              skipped: "Skipped",
              timed_out: "Timed out",
            }[observed] || observed;
          const tone = c.matched
            ? "good"
            : ["blocked", "skipped", "inconclusive"].includes(observed)
              ? "open"
              : "bad";
          items.push(
            EvidenceItem({
              label: c.name || c.id || "Check",
              outcome: outcomeLabel,
              tone,
              meta: [
                c.skipReason || c.detail,
                !c.skipReason &&
                  !c.detail &&
                  `expected ${c.expected || "pass"}`,
                c.durationMs != null &&
                  observed !== "skipped" &&
                  `${c.durationMs}ms`,
                found.sandbox?.engine &&
                  observed !== "skipped" &&
                  found.sandbox.engine,
                head &&
                  observed !== "skipped" &&
                  `at ${String(head).slice(0, 7)}`,
              ]
                .filter(Boolean)
                .join(" · "),
              onClick:
                c.file && start && head
                  ? () => inspect(start, head, { kind: "file", path: c.file })
                  : undefined,
            }),
          );
          if (!c.matched && observed !== "skipped" && c.output)
            items.push(
              Disclosure(
                {
                  summary: `${c.name || c.id} output`,
                  key: `check-output-${c.id || c.name}`,
                },
                Command(c.output),
              ),
            );
        }
        if (found.limits?.notes?.length)
          for (const note of found.limits.notes) items.push(Note(note));
      }
      const actionButtons = [];
      if (found.state === "failed" && !r.revisedBy && !r.applied && !r.merge)
        actionButtons.push(
          Button({
            label: "Send failure to agent",
            variant: "danger",
            onClick: () => verifyActions.sendFailureBack(r, found),
          }),
        );
      if (found.state !== "running" && start && head) {
        const missingAtStart =
          found.state === "blocked" &&
          !found.configRef &&
          /has no checks section|No \.peekumi\.json configuration/i.test(
            found.reason || "",
          );
        const fallbackRef = r.targetBranch || "main";
        const activeRef = found.configRef || null;
        if (missingAtStart) {
          actionButtons.push(
            Button({
              label: `Run checks from ${fallbackRef}`,
              variant: "secondary",
              onClick: () => verifyActions.start(r, false, fallbackRef),
            }),
          );
        } else {
          actionButtons.push(
            Button({
              label: activeRef
                ? `Run checks again (${activeRef})`
                : "Run checks again",
              variant: "secondary",
              onClick: () => verifyActions.start(r, false, activeRef),
            }),
          );
          if (
            found.manifestsChanged ||
            found.limits?.notes?.some((n) => /--prepare/.test(n))
          )
            actionButtons.push(
              Button({
                label: "Prepare and run",
                variant: "secondary",
                onClick: () => verifyActions.start(r, true, activeRef),
              }),
            );
        }
      }
      if (actionButtons.length) items.push(Actions({}, ...actionButtons));
      items.push(...acceptanceControl(r));
      return { run: found, items };
    }
    const list = Array.isArray(found)
      ? found
      : found?.results || found?.checks || [];
    for (const v of list) {
      const state = String(
        v.state || v.status || v.outcome || "unknown",
      ).toLowerCase();
      items.push(
        EvidenceItem({
          label: v.name || v.id || v.command || "Check",
          outcome: state,
          tone:
            {
              passed: "good",
              success: "good",
              failed: "bad",
              failure: "bad",
              error: "bad",
              running: "wait",
              pending: "wait",
            }[state] || "open",
          meta: [
            v.head && `at ${String(v.head).slice(0, 7)}`,
            v.reason || v.summary,
          ]
            .filter(Boolean)
            .join(" · "),
        }),
      );
    }
    if (!items.length) {
      items.push(
        EvidenceItem({
          label: "Sandboxed tests",
          outcome: "Not run",
          tone: "open",
        }),
      );
      if (start && head && !r.revisedBy && !r.applied)
        items.push(
          Actions(
            {},
            Button({
              label: "Run checks",
              variant: "secondary",
              onClick: () => verifyActions.start(r, false),
            }),
          ),
        );
    }
    items.push(...acceptanceControl(r));
    return { run: null, items };
  }
  /** Phase 3: Owner-only shell-free acceptance check editor bound into approvalRecord by hash. */
  function acceptanceControl(r) {
    if (r.revisedBy || r.applied || r.merge) return [];
    const ac = mergeInfo?.acceptanceCheck ?? r.acceptanceCheck;
    const out = [];
    if (ac?.command?.length) {
      out.push(
        EvidenceItem({
          label: `Acceptance: ${ac.command.join(" ")}`,
          outcome: ac.expectFailOnStart ? "Fail → Pass" : "Must pass",
          tone: "quiet",
          meta: `owner-only · #${String(ac.commandHash || "").slice(0, 8)}`,
        }),
      );
    }
    let cmdValue = ac?.command?.join(" ") || "";
    let expectFail = Boolean(ac?.expectFailOnStart);
    out.push(
      Disclosure(
        {
          summary: ac?.command?.length
            ? "Edit owner acceptance check"
            : "Add owner acceptance check",
          key: "owner-acceptance",
        },
        Stack(
          TextField({
            label: "Shell-free command (argv words)",
            value: cmdValue,
            placeholder: "node --test test/model.test.mjs",
            help: "Runs inside Seatbelt; changing it clears prior approval.",
            onInput: (e) => {
              cmdValue = e.target.value;
            },
          }),
          Checkbox({
            label: "Must fail on start commit (fail → pass)",
            checked: expectFail,
            onChange: (e) => {
              expectFail = e.target.checked;
            },
          }),
          Actions(
            {},
            Button({
              label: "Save acceptance check",
              variant: "secondary",
              onClick: () =>
                verifyActions.saveAcceptance(r, cmdValue, expectFail),
            }),
            ...(ac?.command?.length
              ? [
                  Button({
                    label: "Remove",
                    variant: "plain",
                    onClick: () => verifyActions.clearAcceptance(r),
                  }),
                ]
              : []),
          ),
        ),
      ),
    );
    return out;
  }
  /** Formats CRAP items concisely: changed Python functions before/after, or a one-line
   * "Not available" reason for other languages. Clicking a function jumps to it on the map. */
  function crapItems(crapState, start, head) {
    if (!crapState) return [];
    if (crapState.loading) return [Note("Checking CRAP…")];
    if (crapState.failed)
      return [
        EvidenceItem({
          label: "CRAP",
          outcome: "Unavailable",
          tone: "open",
          meta: crapState.reason,
        }),
      ];
    const c = crapState.crap;
    if (!c) return [];
    const items = [];
    const src = c.afterSource;
    const num = (entry) =>
      entry?.state === "measured"
        ? Number(entry.crap).toFixed(1)
        : entry?.state === "not_present"
          ? "new"
          : "n/a";
    if (c.functions?.length) {
      for (const fn of c.functions.slice(0, 12)) {
        const after = fn.after;
        const measured = after?.state === "measured";
        items.push(
          EvidenceItem({
            label: `${fn.path} · ${fn.name}`,
            outcome: measured
              ? `CRAP ${Number(after.crap).toFixed(1)}${after.risky ? " risky" : ""}`
              : "Not available",
            tone: measured ? (after.risky ? "bad" : "good") : "open",
            meta: measured
              ? `${num(fn.before)} → ${num(after)} · ${Math.round((after.coverage || 0) * 100)}% cov · tap to focus`
              : after?.reason || "No coverage run",
            onClick:
              start && head
                ? () =>
                    inspect(start, head, {
                      kind: "symbol",
                      path: fn.path,
                      symbol: fn.name,
                    })
                : undefined,
          }),
        );
      }
      if (src?.state === "available")
        items.push(
          Note(
            `Coverage: ${src.verifyRunId} (${src.checkId}) at ${String(src.commit || "").slice(0, 7)}`,
          ),
        );
    } else if (c.filesChanged > 0) {
      const langs = [
        ...new Set((c.excludedFiles || []).map((f) => f.language)),
      ].filter(Boolean);
      items.push(
        EvidenceItem({
          label: "CRAP",
          outcome: "Not available",
          tone: "open",
          meta: langs.length
            ? `${langs.join(", ")} · Python only`
            : src?.reason || "No coverage run",
        }),
      );
    }
    return items;
  }
  /** Short, scannable blind spots: what nobody checked, skipped checks, inline tests,
   * changed tests/CI/rules, CRAP gaps, blocked checks, and loose files. */
  function blindSpots(check, verifyRun, crapData, start, head) {
    const items = [];
    const m = mergeInfo || {};
    if (verifyRun?.state === "blocked")
      items.push(
        EvidenceItem({
          label: "Sandboxed tests blocked",
          outcome: "Blocked",
          tone: "open",
          meta: verifyRun.reason,
        }),
      );
    else if (verifyRun?.state === "skipped")
      items.push(
        EvidenceItem({
          label: "All configured checks were skipped",
          outcome: "0 passed",
          tone: "open",
          meta: "Skipped checks never count as passing evidence",
        }),
      );
    else if (!verifyRun)
      items.push(
        EvidenceItem({
          label: "No sandboxed tests ran",
          outcome: "Not run",
          tone: "open",
        }),
      );
    for (const c of verifyRun?.checks || []) {
      if (c.observed === "skipped")
        items.push(
          EvidenceItem({
            label: `${c.name || c.id} skipped`,
            outcome: "Skipped",
            tone: "open",
            meta: `${(c.paths || []).join(", ")} unmatched · never counts as passed`,
          }),
        );
    }
    for (const inlinePath of verifyRun?.inlineTestFiles || []) {
      items.push(
        EvidenceItem({
          label: `Inline #[cfg(test)] edited · ${inlinePath}`,
          outcome: "Inline test",
          tone: "open",
          meta: "fail-to-pass not run · tap to inspect on map",
          onClick:
            start && head
              ? () => inspect(start, head, { kind: "file", path: inlinePath })
              : undefined,
        }),
      );
    }
    const t = m.tamper;
    const kinds = {
      tests: "Test edited",
      ci: "CI edited",
      config: "Rules/checks edited",
    };
    const words = {
      A: "added",
      M: "modified",
      D: "deleted",
      T: "type changed",
    };
    if (t?.state === "unavailable")
      items.push(
        EvidenceItem({
          label: "Test/CI/rule changes",
          outcome: "Unavailable",
          tone: "open",
          meta: t.reason,
        }),
      );
    else if (t)
      for (const [kind, outcome] of Object.entries(kinds))
        for (const f of t[kind] || [])
          items.push(
            EvidenceItem({
              label: f.path,
              outcome,
              tone: "open",
              meta: `${words[f.status] || f.status} · tap to inspect on map`,
              onClick:
                start && head
                  ? () => inspect(start, head, { kind: "file", path: f.path })
                  : undefined,
            }),
          );
    const loose = m.loose;
    if (loose?.state === "unavailable")
      items.push(
        EvidenceItem({
          label: "Loose files",
          outcome: "Unavailable",
          tone: "open",
          meta: loose.reason,
        }),
      );
    else if (loose?.count)
      items.push(
        EvidenceItem({
          label: `${plural(loose.count, "loose file")} uncommitted`,
          outcome: "Not in head",
          tone: "open",
        }),
      );
    if (crapData && crapData.filesChanged > 0 && crapData.excludedFiles?.length)
      items.push(
        EvidenceItem({
          label: `CRAP skipped ${crapData.excludedFiles.length} of ${crapData.filesChanged} files`,
          outcome: "Not covered",
          tone: "open",
          meta: crapData.excludedFiles
            .slice(0, 3)
            .map((f) => `${f.path} (${f.language})`)
            .join(", "),
        }),
      );
    if (check?.state === "not checked")
      items.push(
        EvidenceItem({
          label: "Rules not checked",
          outcome: "Not checked",
          tone: "open",
          meta: check.reason,
        }),
      );
    const unresolved = check?.limits?.unresolved || 0,
      unanalysed = check?.limits?.unanalysed?.length || 0;
    if (unresolved || unanalysed)
      items.push(
        EvidenceItem({
          label: [
            unresolved && `${unresolved} unresolved links`,
            unanalysed && `${plural(unanalysed, "file")} unanalysed`,
          ]
            .filter(Boolean)
            .join(" · "),
          outcome: "Rule limits",
          tone: "open",
        }),
      );
    return items;
  }
  /** The review of a finished task in four separate, scannable parts: Peekumi checks, CI,
   * Agent claims (collapsed), and Blind spots. Starts with a blunt one-line status telling
   * the owner if it is waiting on them and why. */
  function reviewEvidence(r, ready) {
    const known = ruleCheckOf(r),
      check = known && !known.loading ? known.check : null,
      m = mergeInfo || {},
      start = m.start || r.start || r.base,
      head = m.head || resultCommit(r),
      short = (sha) => (sha || "").slice(0, 7),
      verify = verificationItems(r),
      crapState = verifyActions.crap(start, head),
      crapData = crapState && !crapState.loading ? crapState.crap : null,
      spots = blindSpots(check, verify.run, crapData, start, head),
      claims = data.comments.filter(
        (c) => c.runId === r.id && c.report?.checks,
      ),
      flagged = (m.tamper?.tests?.length || 0) + (m.tamper?.ci?.length || 0),
      approval = m.approval || r.approvalRecord,
      weakCount = verify.run?.counts?.weak || 0;
    const question =
      approval && m.approvalCurrent === false
        ? `Waiting on you: task or acceptance changed (${short(m.head)}). Approve again?`
        : approval && !ready.length
          ? `Approved (${short(approval.head)}). Ready to merge.`
          : weakCount
            ? `Waiting on you: ${plural(weakCount, "weak test")} passed on start commit.`
            : verify.run?.state === "failed"
              ? "Waiting on you: checks failed in sandbox. Send back?"
              : verify.run?.state === "skipped"
                ? "Waiting on you: all checks skipped (0 passing evidence)."
                : crapData?.riskyCount
                  ? `Waiting on you: ${plural(crapData.riskyCount, "function")} over CRAP ${crapData.threshold}.`
                  : flagged
                    ? `Waiting on you: ${plural(flagged, "test or CI file")} edited.`
                    : check?.addedCount
                      ? `Waiting on you: ${plural(check.addedCount, "rule break")} added.`
                      : !verify.run
                        ? "Waiting on you: no tests ran. Approve anyway?"
                        : spots.length
                          ? `Waiting on you: ${plural(spots.length, "blind spot")}.`
                          : `Waiting on you: approve ${short(head)}?`;
    const provChips = [
      start && head && { text: `${short(start)} → ${short(head)}` },
      verify.run?.configCommit &&
        verify.run.configCommit !== start && {
          text: `checks from ${verify.run.configRef || "config"}@${short(verify.run.configCommit)}`,
          tone: "open",
        },
    ].filter(Boolean);
    const hasSkippedOrInconc =
      (verify.run?.counts?.skipped || 0) > 0 ||
      (verify.run?.counts?.inconclusive || 0) > 0;
    const ruleTone =
      verify.run?.state === "failed" ||
      check?.addedCount ||
      crapData?.riskyCount
        ? "bad"
        : !check || verify.run?.state === "running"
          ? "wait"
          : check.state === "checked" &&
              (!verify.run ||
                (verify.run.state === "passed" && !hasSkippedOrInconc))
            ? "good"
            : "open";
    const peekumiSummary =
      verify.run?.state === "running"
        ? "Running"
        : verify.run?.state === "failed"
          ? verify.run.summary || "Failed"
          : verify.run?.state === "blocked"
            ? "Blocked"
            : verify.run?.state === "skipped" ||
                verify.run?.state === "inconclusive"
              ? verify.run.summary
              : !check
                ? "Checking"
                : check.addedCount
                  ? plural(check.addedCount, "rule break")
                  : verify.run?.state === "passed"
                    ? verify.run.summary
                    : check.state === "not checked"
                      ? "Not checked"
                      : "0 breaks · no tests";
    const ruleWarnings = check?.limits?.warnings?.length || 0;
    const ruleLine = !check
      ? Note("Checking rules…")
      : check.addedCount > 0
        ? ruleCheckView(r)
        : EvidenceItem({
            label: "Dependency rules",
            outcome: check.state === "not checked" ? "Not checked" : "0 breaks",
            tone: check.state === "checked" ? "good" : "open",
            meta:
              check.state === "not checked"
                ? check.reason
                : [
                    check.head && String(check.head).slice(0, 7),
                    ruleWarnings && plural(ruleWarnings, "warning"),
                  ]
                    .filter(Boolean)
                    .join(" · "),
          });
    return Stack(
      EvidenceQuestion(question),
      ProvenanceChips(provChips),
      EvidenceSection(
        {
          title: "Peekumi checks",
          tone: ruleTone,
          summary: peekumiSummary,
        },
        ruleLine,
        ...verify.items,
        ...crapItems(crapState, start, head),
      ),
      EvidenceSection(
        { title: "CI", tone: "quiet", summary: "None" },
        Note("Local branch · no CI"),
      ),
      EvidenceSection(
        {
          title: "Agent claims",
          tone: "quiet",
          summary: claims.length ? "Not proof" : "None",
        },
        claims.length
          ? Disclosure(
              { summary: "Show agent check claims (not proof)" },
              ...claims.map((c) => Command(c.report.checks)),
            )
          : Note("None reported"),
      ),
      EvidenceSection(
        {
          title: "Blind spots",
          tone: spots.length ? "open" : "quiet",
          summary: spots.length ? String(spots.length) : "None",
        },
        ...(spots.length ? spots : [Note("None found")]),
      ),
    );
  }
  function mergeStep(r) {
    const m = mergeInfo;
    if (!m || ["waiting", "applied"].includes(m.state)) return null;
    const step = el("section", "apply-step merge-step");
    step.dataset.state = m.state;
    const heading = (mood, text) => {
      const h = el("h3", "workflow-group");
      h.append(document.createTextNode(text));
      return h;
    };
    const size = () => {
      const added = (m.files || []).reduce((n, f) => n + (f.added || 0), 0),
        removed = (m.files || []).reduce((n, f) => n + (f.removed || 0), 0),
        line = el(
          "p",
          "merge-size",
          `${plural(m.commits, "commit")} · ${plural(m.files.length, "file")} `,
        );
      line.append(el("span", "merge-add", `+${added}`));
      if (removed) line.append(" ", el("span", "merge-del", `−${removed}`));
      return line;
    };
    const check = () => action("Check again", () => refresh());
    if (m.state === "ready") {
      step.append(
        heading("success", `Ready to merge into ${m.target}`),
        size(),
        Object.assign(
          action(`Merge into ${m.target}`, () => confirmMerge(r, m), true),
          { id: "mergeTask" },
        ),
        el(
          "p",
          "read-note",
          "Fast-forward only. Peekumi does not push to GitHub.",
        ),
      );
    } else if (m.state === "merged") {
      const when = new Date(m.merge.at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      step.append(
        heading("merged", `Merged into ${m.target}`),
        el(
          "p",
          "merge-size",
          `${when} · ${m.target} is at ${m.merge.to.slice(0, 7)}`,
        ),
      );
      if (m.undoable)
        step.append(
          Object.assign(
            action("Undo merge", async () => {
              await write(`/api/runs/${r.id}/unmerge`, {});
              notice(`${m.target} is back at ${m.merge.from.slice(0, 7)}`);
              setTimeout(() => notice(""), 3000);
              await refresh();
              moved();
            }),
            { id: "undoMerge" },
          ),
          el("p", "read-note", `Undo works until ${m.target} changes.`),
        );
      else
        step.append(
          el(
            "p",
            "read-note",
            `Undo is not possible: ${m.target} or the merged files changed after the merge.`,
          ),
        );
      step.append(
        el(
          "p",
          "read-note",
          "Peekumi does not push. Push from your terminal when you are ready.",
        ),
      );
    } else if (m.state === "blocked") {
      const n = m.blocking.length,
        files = el("ul", "merge-files");
      for (const path of m.blocking) files.append(el("li", "", path));
      const row = el("div", "merge-buttons");
      row.append(check());
      step.append(
        heading(
          "",
          `${n === 1 ? "1 of your files is" : `${n} of your files are`} in the way`,
        ),
        el(
          "p",
          "merge-note",
          "You have uncommitted changes in these files, and the merge changes them too:",
        ),
        files,
        Object.assign(
          action("Commit my changes, then merge", () => commitMine(r, m), true),
          { id: "commitFirst" },
        ),
        el(
          "p",
          "read-note",
          "An agent writes the commit message. You check it before Peekumi commits. Then the task is brought up to date with your commit; if they conflict, the agent resolves it and you review again.",
        ),
        row,
      );
    } else if (m.state === "behind") {
      step.append(
        heading("", `${m.target} has ${plural(m.behind, "new commit")}`),
        el(
          "p",
          "merge-note",
          `${m.target} changed after this task ran, so a fast-forward merge is not possible yet.`,
        ),
        Object.assign(
          action(`Update with ${m.target}`, () => updateTask(r), true),
          { id: "updateTask" },
        ),
        el(
          "p",
          "read-note",
          `Peekumi merges ${m.target} into the task branch. The head changes, so you approve the result again before you merge. If they conflict, the agent resolves it as a new round first.`,
        ),
      );
    } else if (m.state === "elsewhere") {
      step.append(
        heading("", `${m.target} is checked out in another folder`),
        el("p", "merge-note", m.folder),
        el(
          "p",
          "read-note",
          `Merge there, or check out another branch in that folder. Then check again.`,
        ),
        check(),
      );
    }
    return step;
  }
  /** Every instruction in a task round: its work and any finished ones carried along. */
  /** A round's instructions: its work, the finished work it carries, and (in an update round)
   * the instructions that stay open for the owner's decision. */
  const instructionsOf = (r) => [
    ...(r.comments || []),
    ...(r.done || []),
    ...(r.open || []),
  ];
  /** A task in words: its first instruction (one line, shortened), how many more, and the
   * round after the first. A session is its title. */
  function taskTitle(r) {
    if (r.kind === "session") return r.title || "Session";
    const list = instructionsOf(r);
    const first =
      (list[0]?.text || "")
        .split("\n")[0]
        .replace(/[`*#>]/g, "")
        .trim() || "Task";
    const words =
      first.length > 64 ? first.slice(0, 61).trimEnd() + "…" : first;
    const more = list.length > 1 ? ` + ${list.length - 1} more` : "";
    const round = r.round > 1 ? ` · round ${r.round}` : "";
    return `${words}${more}${round}`;
  }
  /** True once a finished task has the owner's approval record (see backend/review.rs) and no
   * instruction left to review. */
  function reviewed(r) {
    if (r.status !== "completed" || !r.approvalRecord) return false;
    const comments = data.comments.filter((c) =>
      instructionsOf(r).some((x) => x.id === c.id),
    );
    return (
      comments.some((c) => c.status === "verified") &&
      !comments.some((c) => c.status === "addressed")
    );
  }
  /** Instructions of a finished round that can still be approved or sent back. */
  function open(r) {
    return data.comments.filter(
      (c) =>
        c.runId === r.id &&
        ["addressed", "flagged", "unreported"].includes(c.status),
    );
  }
  /** Instructions of a round that still need the owner's decision: flagged by the agent, or
   * not done. Approve and Merge do not close them. */
  function undecided(r) {
    return data.comments.filter(
      (c) => c.runId === r.id && ["flagged", "unreported"].includes(c.status),
    );
  }
  /** Where a task belongs in the Tasks list: "working" while an agent runs, "needs" while
   * it has instructions or changes waiting for you, "done" once approved but not yet merged,
   * and "history" once applied or closed. */
  function stageOf(r) {
    // An open session leads its own group; one ended without review is history.
    if (live(r)) return "session";
    if (r.kind === "session" && r.status === "cancelled") return "history";
    if (active(r)) return "working";
    // A flagged or unfinished instruction keeps the task in front of the owner, also after
    // approval, until they decide it. A merge makes such instructions drafts again.
    if (!r.revisedBy && !r.merge && undecided(r).length) return "needs";
    if (r.applied) return "history";
    // Changes being collected for a next round are current work, even on an approved task.
    if (collected(r.id).length) return "needs";
    // Approving is the owner's decision; anything left over stays visible inside the task.
    if (reviewed(r)) return "done";
    return open(r).length ? "needs" : "history";
  }
  /** One task in the Review Inbox: plain-English status and next step with zero git jargon. */
  function taskCard(r, quiet = false) {
    const info = (inboxData?.needsYou || []).find(
      (i) => i.kind === "task" && i.id === r.id,
    );
    const v = info?.verification;
    const ran = (v?.checks || []).filter((c) => c.observed !== "skipped");
    const passed = ran.filter((c) => c.matched).length;
    const chips = [];
    let urgent = false;
    if (active(r)) {
      chips.push({ text: runStatus(r), tone: "wait" });
    } else if (quiet) {
      chips.push({ text: runStatus(r), tone: "good" });
    } else if (v?.state === "failed") {
      urgent = true;
      chips.push({
        text: ran.length
          ? `Checks failed · ${passed}/${ran.length} passed`
          : "Checks failed",
        tone: "bad",
      });
    } else if (v?.state === "passed") {
      chips.push({
        text: ran.length
          ? `Ready to approve · ${passed}/${ran.length} checks passed`
          : "Ready to approve · Checks passed",
        tone: "good",
      });
    } else if (v?.state === "skipped") {
      chips.push({ text: "No checks matched", tone: "open" });
    } else if (v?.state === "blocked") {
      chips.push({ text: "Checks blocked · Tap to fix", tone: "open" });
    } else if (v?.state === "running") {
      chips.push({ text: "Running checks…", tone: "wait" });
    } else {
      chips.push({ text: "Not checked yet · Tap to review", tone: "open" });
    }
    if (!quiet && info?.tamperCount)
      chips.push({ text: "Edited tests/CI", tone: "open" });
    return InboxRow({
      title: taskTitle(r),
      chips,
      urgent,
      className: quiet ? "task-link quiet" : "task-link",
      onClick: () => openTask(r.id),
    });
  }
  /** Applied and closed tasks, newest first: the record, out of the way of current work. */
  function history(body) {
    head("History");
    const past = data.runs
      .filter(
        (r) =>
          r.status !== "preview" && !r.revisedBy && stageOf(r) === "history",
      )
      .slice()
      .reverse();
    if (!past.length)
      body.append(el("p", "empty", "No applied or closed tasks yet."));
    body.append(...past.map((r) => taskCard(r, true)));
  }
  function runStatus(r) {
    const target = r.targetBranch || "main";
    if (live(r))
      return r.approval
        ? "Needs you"
        : r.status === "running"
          ? "Working"
          : "Your turn";
    if (r.kind === "session" && r.status === "cancelled")
      return "Ended without review";
    if (r.applied)
      return r.merge ? `Merged into ${target}` : `Applied to ${target}`;
    if (r.revisedBy) return "Changes requested";
    if (r.status === "completed" && !reviewed(r) && !open(r).length)
      return "Nothing left to review";
    if (r.status === "completed")
      return reviewed(r) ? `Approved · ready to merge` : "Ready for review";
    return (
      {
        running: "Working",
        starting: "Starting",
        failed: "Needs attention",
        cancelled: "Stopped",
        interrupted: "Interrupted",
      }[r.status] || r.status
    );
  }
  /** Opens run `id` (a task or a session) over the current view. */
  async function openTask(id) {
    if (id !== runId()) reply = null;
    // The view change reads the run (see viewChanged); wait for that read.
    nav.go({ name: "run", id });
    await refreshQueue;
  }
  /** The commit holding everything the agent did, or nothing when it reported no commit. */
  function resultCommit(r) {
    return (
      r.results?.at(-1) ||
      data.comments.find((c) => c.runId === r.id && c.report?.commit)?.report
        .commit
    );
  }
  /** A small back arrow beside the view's heading, in place of a full-width button. */
  /** A task's header row: its state as the title, a quiet line, and Peek's mood. */
  function header(body, title, status = "", mood = "") {
    head(title, { meta: status, mood });
  }
  /** Peek's state for a task: working while it runs, ready to review, merged once applied,
   * stopped when it ended early; none otherwise. */
  function moodOf(r) {
    if (active(r) && r.status !== "interrupted") return "working";
    // Ended on purpose: no droop.
    if (endedSession(r)) return "";
    if (r.applied) return "merged";
    if (r.revisedBy) return "";
    if (reviewed(r)) return "success";
    if (["failed", "interrupted", "cancelled"].includes(r.status))
      return "stopped";
    return runStatus(r) === "Ready for review" ? "ready" : "";
  }
  function activityView(r) {
    const live = el("section", "task-live");
    const progress = agentActivity(r.output);
    if (active(r)) live.append(el("p", "workflow-text", progress.activity));
    if (["failed", "interrupted", "cancelled"].includes(r.status)) {
      // Say what happened and what to do next, in the owner's words, not the agent's log.
      const again =
        "Instructions that the agent did not answer show “Not done”. To try again, use Request changes: the next round includes them.";
      const ended = r.kind === "session" && r.status === "cancelled";
      const why = ended
        ? "You ended this session without review. Its branch stays, and nothing was merged."
        : r.status === "cancelled"
          ? "This task stopped: you stopped it, or it reached the one-hour limit."
          : progress.errors.join("\n") ||
            r.message ||
            "This task stopped before it finished.";
      live.append(el("p", "workflow-text", why));
      if (!ended) live.append(el("p", "read-note", again));
    }
    const latest = progress.messages.at(-1);
    if (latest && active(r))
      live.append(richText(latest, "workflow-text agent-message"));
    return live;
  }
  function updateLive() {
    const live = document.querySelector(".task-live");
    if (live && runDetail) live.replaceWith(activityView(runDetail));
  }
  /** The run view: a task, or an open session. */
  function runs(body) {
    if (!runDetail || runDetail.id !== runId()) {
      header(body, "Task");
      body.append(el("p", "read-note", "Loading task…"));
      return;
    }
    const r = runDetail;
    // An open session is a conversation; once sent to review it is a task like any other.
    if (live(r)) return session.render(body, r);
    // What state the task is in leads; how many instructions and where is the quiet line.
    header(body, runStatus(r), taskTitle(r), moodOf(r));
    body.append(activityView(r));
    // A finished session keeps its conversation as the record of the work.
    if (r.kind === "session") {
      const record = el("details", "workflow-evidence session-record");
      record.dataset.key = "session-record";
      record.append(
        el("summary", "", "Session conversation"),
        session.conversation(r),
      );
      body.append(record);
    }
    if (runStatus(r) === "Nothing left to review")
      body.append(
        el(
          "p",
          "read-note",
          `This task's instructions were deleted, so there is nothing to approve or send back. The agent's work is still on ${r.branch}: Explore changes shows it.`,
        ),
      );
    if (r.kind === "update") {
      // This round only merges the target in and resolves the conflict.
      const asked = el("article", "workflow-card requested");
      asked.append(
        el("p", "report-label", `Update with ${r.targetBranch || "main"}`),
        el(
          "p",
          "workflow-text",
          `${r.targetBranch || "main"} moved on, and it conflicts with this task in ${(r.conflicts || []).join(", ")}. The agent merges it and resolves the conflict. Then you review the result again.`,
        ),
      );
      body.append(asked);
    } else if (r.feedback) {
      const asked = el("article", "workflow-card requested");
      asked.append(
        el("p", "report-label", "You asked for changes"),
        richText(r.feedback, "workflow-text"),
      );
      body.append(asked);
    }
    const stale =
      !!r.approvalRecord && !!mergeInfo && mergeInfo.approvalCurrent === false;
    const ready = data.comments.filter(
      (c) =>
        c.runId === r.id &&
        (c.status === "addressed" ||
          (c.status === "verified" && (!r.approvalRecord || stale))),
    );
    // An applied task is a settled record: later changes start a new task.
    const decide = !active(r) && !r.revisedBy && !r.applied && !endedSession(r),
      batch = decide ? collected(r.id) : [],
      signalFirst =
        decide && r.status === "completed" && Boolean(resultCommit(r)),
      notes = Stack();
    comments(notes, r);
    if (!signalFirst) body.append(notes);
    const step = mergeStep(r);
    if (step) body.append(step);
    const loose = looseStep(r);
    if (loose) body.append(loose);
    const actions = el("div", "sel-acts task-actions");
    if (active(r) && r.status !== "interrupted")
      actions.append(
        action("Stop task", async () => {
          await write(`/api/runs/${r.id}/cancel`, {});
          await refresh();
        }),
      );
    if (resultCommit(r) && !active(r))
      actions.append(
        action(
          "Explore changes",
          // An update round shows the task on top of the new target, not the target's own changes.
          () => explore(r.mergeTarget || r.base, r.branch, r.id),
        ),
      );
    // A later round carries this one's work forward; decisions happen there.
    if (r.revisedBy)
      actions.append(
        action(`Open round ${(r.round || 1) + 1}`, () => openTask(r.revisedBy)),
      );
    const agentName = agents.label(r.agent);
    if (batch.length) {
      // The list and the button that sends it to the agent, as the next round, sit together.
      body.append(
        el("h3", "workflow-group", "Requested changes"),
        Object.assign(
          action(
            `Send ${batch.length} change${batch.length === 1 ? "" : "s"} to ${agentName}`,
            async () => {
              const next = await write(`/api/runs/${r.id}/revise`, {});
              reply = null;
              await openTask(next.id);
            },
            true,
          ),
          { id: "sendChanges" },
        ),
        el(
          "p",
          "read-note",
          `${agentName} continues from its last commit on a new round. Nothing reaches ${r.targetBranch || "main"} until you apply it.`,
        ),
      );
      for (const c of batch) {
        const card = el("article", "workflow-card");
        card.dataset.commentId = c.id;
        const foot = el("div", "cm-top");
        const place = action(label(c.anchor), () =>
          inspect(c.sha, c.sha, c.anchor),
        );
        place.classList.add("link-button");
        foot.append(place);
        const controls = el("div", "sel-acts");
        controls.append(
          action("Edit", () => {
            editing = c;
            composer = { anchor: c.anchor, sha: c.sha };
            draft = c.text;
            redraw();
          }),
          action("Delete", () => transition(c, "delete")),
        );
        card.append(richText(c.text, "workflow-text"), foot, controls);
        body.append(card);
      }
    }
    // Signal first: open question + 4 compact sections + Approve/Request actions sit above the
    // agent's prose write-up so the owner sees what is waiting on them immediately.
    if (signalFirst) body.append(reviewEvidence(r, ready));
    // Approve covers the finished instructions only; say which ones stay open.
    const left = undecided(r).length;
    if (decide && ready.length && left)
      actions.append(
        el(
          "p",
          "read-note",
          `${left} instruction${left === 1 ? " needs" : "s need"} your decision (flagged, or not done). Approve covers only the finished ones. After a merge, ${left === 1 ? "it becomes a draft" : "they become drafts"} again.`,
        ),
      );
    // When the merge would go through, one step approves and merges, after one confirmation
    // (docs/design/19-flows.md, flow 1). Approve only stays in that dialog.
    if (decide && ready.length && mergeInfo?.next === "ready")
      actions.append(
        Object.assign(
          action(
            "Approve and merge",
            () => confirmMerge(r, mergeInfo, ready),
            true,
          ),
          { id: "approveMerge" },
        ),
      );
    else if (decide && ready.length)
      actions.append(
        action(
          "Approve",
          async () => {
            try {
              await approve(r);
            } finally {
              await refresh();
            }
            // The next step appears below the instructions; bring it into view.
            requestAnimationFrame(() =>
              document
                .querySelector(".apply-step")
                ?.scrollIntoView({ block: "start", behavior: "smooth" }),
            );
          },
          true,
        ),
      );
    // What should change is written in the box at the bottom, which adds it to this task's
    // list; the list's own button sends it to the agent as the next round.
    if (decide && !batch.length && open(r).length)
      actions.append(
        action("Request changes", () => {
          const box = document.querySelector("#composerHost textarea");
          box?.focus();
          notice("Write what should change below, then tap ✓");
          setTimeout(() => notice(""), 4000);
        }),
      );
    if (decide && ready.length && !reply) {
      const add = action("Add note", () => {
        reply = "note";
        redraw();
        document.querySelector(".reply-box textarea")?.focus();
      });
      add.classList.add("link-button");
      actions.append(add);
    }
    // A mistaken approval can be undone while the work is not yet on main.
    if (decide && reviewed(r))
      actions.append(
        action("Reopen review", async () => {
          await write(`/api/runs/${r.id}/unapprove`, {});
          await refresh();
        }),
      );
    // Once applied, more changes are a new instruction at the same place, as a new task.
    if (r.applied && !r.revisedBy)
      actions.append(
        action(
          "Follow up",
          () => {
            const first = instructionsOf(r)[0];
            composer = {
              anchor: first?.anchor || { kind: "repo", path: "" },
              sha: data.watched || "HEAD",
              pinned: true,
            };
            editing = null;
            draft = "";
            writeInstruction();
          },
          true,
        ),
      );
    if (actions.childElementCount) body.append(actions);
    if (decide && reply === "note" && ready.length) {
      const note = field(
        "Review note (optional)",
        verificationNote,
        (value) => (verificationNote = value),
        2,
      );
      note.classList.add("review-note", "reply-box");
      body.append(note);
    }
    if (signalFirst) body.append(notes);
    // One quiet log for everything about how the agent got there.
    const progress = agentActivity(r.output);
    const log = el("details", "workflow-evidence diagnostics");
    log.dataset.key = "diagnostics";
    log.append(el("summary", "", "Agent log"));
    for (const message of progress.messages)
      log.append(richText(message, "workflow-text"));
    const output = el("details", "workflow-evidence");
    output.dataset.key = "raw-output";
    output.append(
      el("summary", "", "Raw agent events"),
      el("pre", "taskpre", r.output || "No output yet."),
    );
    const prompt = el("details", "workflow-evidence");
    prompt.dataset.key = "raw-task";
    prompt.append(
      el("summary", "", "Generated task"),
      el("pre", "taskpre", r.task),
    );
    log.append(el("p", "rd", "Branch " + r.branch), output, prompt);
    body.append(log);
  }
  // Poll results even while diagnostics or the composer are open. Refresh restores
  // disclosure state, draft text, focus, cursor position and the reading position.
  // Every 3 s while an agent works; every 10 s otherwise, so a run started elsewhere (another
  // device, or a task from the API) shows up here too.
  let idle = 0;
  setInterval(() => {
    if (document.hidden || !loaded) return;
    // While an agent works or a session is open, every 3 s, so its state on the sheet (and a
    // command request) shows at once; otherwise every 12 s.
    if (
      !data.runs.some((r) => active(r) || live(r)) &&
      mergeInfo?.verification?.state !== "running" &&
      ++idle % 4
    )
      return;
    refresh("poll").catch((e) => notice(e.message, true));
  }, 3000);
  // A session on screen that is working updates faster, so its steps appear as they happen.
  setInterval(() => {
    if (
      document.hidden ||
      !loaded ||
      !runId() ||
      runDetail?.id !== runId() ||
      !live(runDetail) ||
      runDetail.status !== "running"
    )
      return;
    refresh("poll").catch((e) => notice(e.message, true));
  }, 1200);
  /** A run by `id`: the full copy on screen, else the list's summary. */
  const runOf = (id) =>
    runDetail?.id === id ? runDetail : data.runs.find((r) => r.id === id);
  return {
    refresh,
    openTask,
    focusRun,
    cueLive,
    /** True when a finished task, not yet continued, can collect changes for a next round. */
    revisable(id) {
      const r = data.runs.find((x) => x.id === id);
      return Boolean(
        r &&
        !active(r) &&
        !live(r) &&
        !endedSession(r) &&
        r.status !== "preview" &&
        !r.revisedBy &&
        !r.applied,
      );
    },
    /** How many instructions are waiting to go back with task `id`. */
    collected: (id) => collected(id).length,
    /** Adds an instruction at `anchor` on commit `sha` to task `id`'s next round. */
    async collect(id, anchor, sha, text) {
      await write("/api/comments", { anchor, sha, text, forRun: id });
      await refresh(false);
    },
    /** The task whose branch is explored, when it can still take requested changes. */
    exploringTask: () => exploring(),
    renderComposer,
    /** Opens the task form with the draft instructions `ids` selected (and no others): a batch
     * of proposed fixes in one task. */
    async prepareWith(ids) {
      await refresh();
      openSend({ ids, live: false });
    },
    /** Opens the send sheet with every change that waits; `live` starts it on With me. */
    openSend,
    /** How many changes wait to be sent (the tray in the sheet's title row). */
    draftCount: () => data.comments.filter(sendable).length,
    /** The next send starts a session (the menu's "Start a session here"). */
    preferLive() {
      sendMode = "live";
    },
    renderIntent,
    /** Starts a new instruction at the current selection with `text`, for the owner to edit. */
    prefill(text) {
      editing = null;
      composer = context();
      draft = text;
    },
    /** The dock's Session box: a reply to run `id` (or the open session), or a new session. */
    renderSessionComposer: (host, id = null) =>
      session.renderComposer(host, id ? runOf(id) : liveSession(), {
        named: data.runs.filter(live).length > 1,
      }),
    /** "session" or "task": what run `id` is. */
    runKind: (id) => (runOf(id)?.kind === "session" ? "session" : "task"),
    /** True when run `id` is an open session (a conversation, not a task). */
    isLive: (id) => Boolean(runOf(id) && live(runOf(id))),
    /** How run `id` shows, for the sheet's scroll rule: "loading", "session" or "task". */
    runShape: (id) =>
      runDetail?.id === id ? (live(runDetail) ? "session" : "task") : "loading",
    /** True when an open session exists (the dock then offers a reply to it). */
    hasLiveSession: () => Boolean(liveSession()),
    /** The open sessions, newest first, for Conversations: `{id, title, line, mood}`. */
    liveSessions: () =>
      data.runs
        .filter(live)
        .reverse()
        .map((r) => ({
          id: r.id,
          title: r.title || "Session",
          line: runStatus(r),
          mood: r.approval
            ? "thinking"
            : r.status === "running"
              ? "working"
              : "ready",
        })),
    /** How many instructions are on the map's selection (or inside it). */
    instructionsHere: () => data.comments.filter(visible).length,
    /** The owner moved the map: Follow pauses until they tap it. Follow's own moves do not
     * count. */
    ownerMoved() {
      if (focus.moving()) return;
      // What the owner selects goes with their next message; Follow's moves do not.
      ownerPointed = true;
      focus.ownerMoved();
    },
    /** The view changed (nav.js): a page that shows this data reads it again. */
    viewChanged(view) {
      if (
        [
          "tasks",
          "history",
          "instructions",
          "conversations",
          "run",
          "prepare",
        ].includes(view.name)
      )
        refresh().catch((e) => notice(e.message, true));
    },
    /** The ID of the open session, or null. */
    liveSessionId: () => liveSession()?.id || null,
    /** Draws page `view`: a list of instructions or tasks, the task form, or a run. */
    render(body, view) {
      bar();
      if (view.name === "prepare") {
        const n = data.comments.filter(
          (c) => sendable(c) && picks.has(c.id),
        ).length;
        header(body, n ? `Send ${plural(n, "change")}` : "Send changes");
        prepare(body);
      } else if (view.name === "run") runs(body);
      else comments(body);
    },
  };
}
