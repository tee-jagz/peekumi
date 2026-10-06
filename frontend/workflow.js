/** @module Anchored drafts, exact task previews, run reports and human verification. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";
import { createSession, live, activity, timeline, focusOf } from "./session.js";
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
    .replace(/(?:~|[A-Za-z]:)?(?:\/[^\s'"`/]+){2,}\/?/g, (path) => path.replace(/\/$/, "").split("/").pop())
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
}) {
  let data = { comments: [], runs: [] },
    loaded = false,
    lastSignature = "",
    refreshQueue = Promise.resolve();
  let composer = null,
    draft = "",
    editing = null,
    preview = null;
  // The end of an open session's log while another view is open (see cueLive).
  let sessionTail = null;
  let brief = "",
    picks = new Set(),
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
    // The agent that sessions use (the choice for tasks), once the agent list has loaded.
    sessionAgent: () => agents.load().then(() => agents.current("task")?.agent || null),
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
    const shown = runDetail && runDetail.id === runId() && live(runDetail) ? runDetail : null;
    if (shown) lastSession = shown.id;
    const last = data.runs.find((r) => r.id === lastSession && live(r));
    return shown || last || data.runs.slice().reverse().find(live) || null;
  }
  /** The finished task on screen, when it can still collect changes for a next round. */
  function viewedTask() {
    const r = runDetail;
    if (!r || r.id !== runId()) return null;
    return !active(r) && !live(r) && !endedSession(r) && r.status !== "preview" && !r.revisedBy && !r.applied ? r.id : null;
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
        loaded = true;
        const shown = runId();
        if (shown) runDetail = await api("/api/runs/" + shown);
        // A running run or an open session outside its view: only the end of its log, for
        // the sheet's line and the map's agent focus.
        const open = data.runs.slice().reverse().find((r) => active(r) || live(r));
        sessionTail = open && open.id !== shown ? await api(`/api/runs/${open.id}/tail`).catch(() => null) : null;
        // An approved or merged task shows what a merge would do now.
        const r = shown && runDetail?.id === shown && runDetail;
        mergeInfo =
          r && r.status === "completed" && !r.revisedBy && (reviewed(r) || r.merge)
            ? await api(`/api/runs/${r.id}/merge`).catch(() => null)
            : null;
        bar();
        const signature = JSON.stringify([data, runDetail, mergeInfo]),
          changed = signature !== lastSignature;
        lastSignature = signature;
        // A poll redraws only a page that shows this data (never the map's own views).
        if (render === "poll")
          render = changed && ["tasks", "history", "instructions", "run", "conversations"].includes(nav.view().name);
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
    ["failed", "interrupted"].includes(r.status) && !r.revisedBy && open(r).length > 0;
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
    const next = running ? "working" : stuck ? "attention" : ready.length ? "ready" : "";
    const agent = (r) => ({ claude: "Claude Code", codex: "Codex", openrouter: "OpenRouter" })[r.agent] || r.agent;
    const label = running
      ? `${agent(running)} is working on a task`
      : stuck
        ? "A task stopped and needs your attention"
        : ready.length
          ? `Tasks, ${ready.length} ready to review`
          : "Tasks";
    button.setAttribute("aria-label", label);
    button.title = running || stuck
      ? label
      : ready.length
        ? `${ready.length} task${ready.length === 1 ? "" : "s"} ready to review on its agent branch`
        : "Open tasks";
    if (next === cue) return;
    const finished = cue === "working" && next !== "working";
    cue = next;
    clearTimeout(settle);
    button.dataset.cue = next;
    button.dataset.ready = String(next === "ready");
    if (next === "working") button.replaceChildren(peek("working"));
    else if (next === "attention") button.replaceChildren(peek("stopped"));
    else if (finished && next === "ready") {
      // One short hop as the agent finishes, then the usual accent icon.
      button.replaceChildren(peek("ready"));
      settle = setTimeout(() => cue === "ready" && button.replaceChildren(tasksIcon), 2600);
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
    const row = nav.view().name === "inspect" ? document.querySelector("#reviewScope") : document.querySelector("#viewHead .view-head, #viewHead .session-head");
    if (row && line.parentElement !== row) row.append(line);
    const view = nav.view(),
      runs = data.runs.slice().reverse();
    const r =
      runs.find((x) => live(x) && x.approval) ||
      runs.find((x) => live(x) && x.status === "running") ||
      runs.find((x) => active(x) && x.kind !== "session") ||
      runs.find(live);
    line.hidden = !r || (view.name === "run" && view.id === r.id);
    if (line.hidden) return;
    const session = r.kind === "session";
    // What the agent does now, from the end of its log.
    const full = runDetail?.id === r.id ? runDetail : sessionTail?.id === r.id ? sessionTail : r;
    const now = session ? activity(full) : { state: "running", title: "Working", label: taskTitle(r), code: "" };
    const name = session ? r.title || "Session" : taskTitle(r);
    // Just out of a running session's view: fetch the end of its log now, not at the next poll.
    if (session && r.status === "running" && full === r && !tailLoading) {
      tailLoading = true;
      api(`/api/runs/${r.id}/tail`)
        .then((tail) => (sessionTail = tail))
        .catch(() => {})
        .finally(() => {
          tailLoading = false;
          cueLive();
        });
    }
    const plain = (t) => t.replace(/[`*#>]/g, "").trim();
    const what = `${now.title}${now.label ? ": " + plain(now.label) : ""}${now.code ? " " + now.code : ""}`.replace(/[.\s]+$/, "");
    const label = `${session ? "Session" : "Task"} ${name} · ${what}. Open it`;
    line.setAttribute("aria-label", label);
    line.title = label;
    line.onclick = () => openTask(r.id);
    const key = [r.id, now.state].join("|");
    if (line.dataset.key === key) return;
    line.dataset.key = key;
    line.dataset.state = now.state;
    line.replaceChildren(
      peek(now.state === "running" ? "working" : now.state === "needs" ? "thinking" : "ready", { className: "live-peek" }),
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
    const all = data.runs.slice().reverse().map((r) => (r.id === shown?.id ? shown : r));
    if (shown && active(shown)) return shown;
    return all.find(active) || (shown && live(shown) ? shown : null) || all.find(live) || null;
  }
  /** Gives the map's agent focus where the marked run's agent is, from the fullest copy of
   * its log at hand: the open run, the end of its log, or nothing yet. */
  function runFocus() {
    const r = markedRun();
    if (!r) return focus.set("run", null);
    const full = r.output !== undefined ? r : runDetail?.id === r.id ? runDetail : sessionTail?.id === r.id ? sessionTail : r;
    const where = focusOf(timeline(full.output || ""));
    focus.set("run", { running: r.status === "running", live: live(r), current: where.current, trail: where.trail, changed: full.changed || [] });
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
    // Only the map's Details carry this line; work in progress shows in the live line.
    if (nav.view().name !== "inspect") return;
    const drafts = data.comments.filter(sendable);
    const waiting = data.comments.filter((c) => c.status === "addressed");
    if (!drafts.length && !waiting.length) return;
    const b = action(
      drafts.length
        ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting · Review task ›`
        : `${waiting.length} ready for review ›`,
      () => {
        if (!drafts.length) return nav.go({ name: "tasks" });
        picks = new Set(drafts.map((c) => c.id));
        preview = null;
        nav.go({ name: "prepare" });
      },
    );
    b.className = "runbar";
    host.append(b);
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
  /** Renders the persistent draft input independently of the current inspection view. */
  function renderComposer(composerHost) {
    if (!composer || (!draft && !editing && !composer.pinned)) composer = context();
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
              : composer.sha.slice(0, 7)),
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
            await write("/api/comments", { ...composer, text: draft, forRun: target });
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
      iconButton(save, "check", target ? "Add to requested changes" : "Save draft");
      for (const b of [cancel, save]) b.classList.add("icon-action");
      buttons.append(cancel, save);
      const input = box.querySelector("textarea");
      // Nothing to save until something is written.
      save.disabled = !draft.trim();
      input.addEventListener("input", () => (save.disabled = !input.value.trim()));
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
      body.append(el("p", "read-note", "Drafts wait here until you send them as a task."));
    }
    const overview = !task && name === "tasks";
    if (!task && name === "history") {
      history(body);
      return;
    }
    if (overview) {
      // The Agents sheet opens from here; the line says what a new task uses.
      // Agents is a quiet icon in the header row, as the back arrow is.
      const choose = iconButton(el("button", "view-action"), "agents", "Agents");
      choose.type = "button";
      choose.id = "openAgents";
      choose.onclick = () => agents.open(null, () => redraw());
      head("Tasks", { actions: [choose] });
      const uses = agents.describe("task");
      if (uses) body.append(el("p", "read-note tasks-uses", `New tasks use ${uses}`));
      else agents.load().then((c) => c && redraw()).catch(() => {});
      const shown = data.runs
        .filter((r) => r.status !== "preview" && !r.revisedBy)
        .slice()
        .reverse();
      // Open sessions are conversations (see Conversations); a session sent to review is work.
      const drafts = data.comments.filter(sendable);
      const needs = shown.filter((r) => stageOf(r) === "needs");
      if (drafts.length || needs.length) body.append(el("h3", "workflow-group", "Needs you"));
      if (drafts.length)
        body.append(
          action(
            `Review task · ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`,
            () => {
              preview = null;
              picks = new Set(drafts.map((c) => c.id));
              nav.go({ name: "prepare" });
            },
            true,
          ),
        );
      // The drafts belong with the button that sends them, under Needs you.
      renderCards(body, drafts);
      // A task's earlier rounds open from its latest one. Tasks are grouped by what they
      // need from you; applied and closed tasks leave this list for History.
      body.append(...needs.map(taskCard));
      const working = shown.filter((r) => stageOf(r) === "working");
      if (working.length)
        body.append(el("h3", "workflow-group", "Working"), ...working.map(taskCard));
      const done = shown.filter((r) => stageOf(r) === "done");
      if (done.length)
        body.append(
          el("h3", "workflow-group quiet-group", "Done · waiting to merge"),
          ...done.map((r) => taskCard(r, true)),
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
    }
    else if (
      overview &&
      !data.comments.some(sendable) &&
      !data.runs.some((r) => r.status !== "preview" && !r.revisedBy && stageOf(r) !== "history")
    )
      body.append(
        el(
          "p",
          "empty",
          loaded ? "No tasks yet. Write an instruction on the map to start one." : "Loading tasks…",
        ),
      );
    // On a selection, finished instructions (approved, or in an applied task) collapse into
    // one line, so drafts and open instructions stay in front.
    const settled = (c) =>
      c.status === "verified" || data.runs.find((r) => r.id === c.runId)?.applied;
    const earlier = here ? items.filter(settled) : [];
    renderCards(body, here ? items.filter((c) => !settled(c)) : items, task);
    if (earlier.length) {
      const fold = el("details", "workflow-evidence earlier-instructions");
      fold.dataset.key = "earlier-instructions";
      fold.append(
        el("summary", "", `${earlier.length} earlier instruction${earlier.length === 1 ? "" : "s"}`),
      );
      renderCards(fold, earlier);
      body.append(fold);
    }
    if (overview) {
      const past = data.runs.filter(
        (r) => r.status !== "preview" && !r.revisedBy && stageOf(r) === "history",
      ).length;
      if (past) {
        const link = action(`History · ${past}`, () => nav.go({ name: "history" }));
        link.classList.add("link-button", "history-link");
        body.append(link);
      }
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
        anchor.title = `Open ${label(c.anchor)} · left on ${c.sha.slice(0, 7)}, ${new Date(c.createdAt).toLocaleString()}`;
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
          state.dataset.state = endedSession(task) && c.status === "unreported" ? "ended" : c.status;
          foot.append(state);
        }
        card.append(richText(c.text, "workflow-text"), foot);
        const report = c.report;
        if (report) {
          // What the agent says about it, quietly under the instruction; no heading.
          card.append(richText(report.note || report.reason, "workflow-text report-text"));
          if (report.checks) {
            const d = el("details", "workflow-evidence");
            d.append(
              el("summary", "", "Agent-reported checks"),
              richText(report.checks, "workflow-text"),
            );
            card.append(d);
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
  function prepare(body) {
    body.append(
      el(
        "p",
        "read-note",
        `The task starts from ${(data.watched || "main").replace("refs/heads/", "")}. Choose the instructions to send; results return here for review.`,
      ),
    );
    // The task uses this device's choice for tasks; Change opens that list.
    const uses = el("div", "task-uses");
    uses.append(
      el("span", "", `Uses ${agents.describe("task") || "the default agent"}`),
      Object.assign(
        action("Change", () =>
          agents.open("task", () => {
            preview = null;
            redraw();
          }),
        ),
        { className: "btn link-button" },
      ),
    );
    body.append(uses);
    if (!agents.describe("task")) agents.load().then((c) => c && redraw()).catch(() => {});
    for (const c of data.comments.filter(sendable)) {
      const l = el("label", "workflow-pick"),
        check = el("input");
      check.type = "checkbox";
      check.checked = picks.has(c.id);
      check.onchange = () => {
        if (check.checked) picks.add(c.id);
        else picks.delete(c.id);
        preview = null;
        redraw();
      };
      const txt = el("span");
      txt.append(
        el("strong", "", label(c.anchor)),
        el("span", "workflow-text", c.text),
      );
      l.append(check, txt);
      body.append(l);
    }
    body.append(
      field("Extra instructions (optional)", brief, (v) => {
        brief = v;
        preview = null;
        const dispatch = document.querySelector("#dispatchRun");
        if (dispatch) dispatch.remove();
      }),
    );
    body.append(
      action(
        "Preview task",
        async () => {
          preview = await write("/api/runs/preview", {
            using: agents.using("task"),
            commentIds: [...picks],
            brief,
          });
          redraw();
          // The preview renders below the form; on a phone that is off screen, so show it.
          requestAnimationFrame(() =>
            document
              .querySelector(".task-preview")
              ?.scrollIntoView({ block: "start", behavior: "smooth" }),
          );
        },
        // Once a preview is there, Start task is the next step.
        !preview,
      ),
    );
    if (preview) {
      const summary = el("section", "task-preview");
      // A provider that cannot run now says so before the start, not after it fails.
      const blocked = agents.problem("task");
      summary.append(
        el("h3", "", blocked ? "Not ready" : "Ready to start"),
        ...(blocked ? [el("p", "read-note warn-note", `${blocked}. Change it in Agents, or fix it on your computer.`)] : []),
        el(
          "p",
          "workflow-text",
          `${agents.label(preview.agent)} will work on ${preview.comments.length} instruction${preview.comments.length === 1 ? "" : "s"}. You will review the results here. Your main branch stays unchanged.`,
        ),
      );
      for (const c of preview.comments)
        summary.append(richText(c.text, "workflow-text"));
      if (preview.brief)
        summary.append(richText(preview.brief, "workflow-text"));
      const exact = el("details", "workflow-evidence");
      exact.dataset.key = "preview-diagnostics";
      exact.append(
        el("summary", "", "Technical task details"),
        el("pre", "taskpre", preview.task),
      );
      summary.append(exact);
      body.append(summary);
      const b = action(
        "Start task",
        async () => {
          const result = await write("/api/runs", { previewId: preview.id });
          preview = null;
          // The form is done: the new task takes its place, over the list.
          nav.back();
          await openTask(result.id);
        },
        true,
      );
      b.id = "dispatchRun";
      body.append(b);
    }
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  /** One line per changed file: its path and line counts. */
  function fileList(files) {
    const list = el("ul", "merge-files");
    for (const f of files) {
      const row = el("li");
      row.append(el("code", "", f.path));
      const counts = el("span", "merge-counts");
      if (f.added != null) counts.append(el("span", "merge-add", `+${f.added}`));
      if (f.removed) counts.append(" ", el("span", "merge-del", `−${f.removed}`));
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
  /** Brings the target's new commits into the task. A clean update keeps the approval; a
   * conflict opens the new round in which the agent resolves it. */
  async function updateTask(r) {
    const out = await write(`/api/runs/${r.id}/update`, {});
    if (out.round) {
      notice(`The task and ${mergeInfo?.target || "main"} conflict. The agent resolves it in round ${out.round.round}.`);
      setTimeout(() => notice(""), 5000);
      await openTask(out.round.id);
    } else {
      notice(`Updated with ${mergeInfo?.target || "main"}. No conflicts.`);
      setTimeout(() => notice(""), 3000);
      await refresh();
    }
  }
  /** Asks the owner to confirm the merge, with the files it changes and what happens to
   * their checkout. Sends the exact state shown, so a change in between stops the merge. */
  function confirmMerge(r, m) {
    sheet("Merge into " + m.target, (box, close) => {
      const note = !m.checkedOut
        ? `${m.target} is not checked out, so only the branch moves. No files in your folder change.`
        : m.uncommitted
          ? `${m.target} is checked out in your folder. Your ${plural(m.uncommitted, "uncommitted change")} do not touch these files, and they stay as they are.`
          : `${m.target} is checked out in your folder. Its files change to the merged result.`;
      const buttons = el("div", "merge-buttons");
      buttons.append(
        action("Cancel", close),
        Object.assign(
          action(
            "Merge",
            async () => {
              try {
                await write(`/api/runs/${r.id}/merge`, { target: m.targetSha, head: m.head });
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
        el("h2", "merge-title", `Merge ${plural(m.commits, "commit")} into ${m.target}?`),
        el("p", "read-note", `From ${r.branch} · fast-forward to ${m.head.slice(0, 7)}`),
        fileList(m.files || []),
        el("p", "merge-note", note),
        buttons,
        el("p", "read-note merge-foot", `Nothing is pushed. You can undo until ${m.target} changes.`),
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
        draft = await write(`/api/runs/${r.id}/commit-draft`, { using: agents.using("ask") });
      } catch (e) {
        box.replaceChildren(el("h2", "merge-title", "Cannot commit now"), el("p", "merge-note", e.message), action("Close", close));
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
              await write(`/api/runs/${r.id}/commit-mine`, { message, head: draft.head, hash: draft.hash });
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
            (others > 0 ? ` Your other ${plural(others, "change")} stay uncommitted.` : ""),
        ),
        fileList(draft.files),
        field(
          draft.agent ? "Commit message · written by the agent, you can edit it" : "Commit message · you can edit it",
          message,
          (value) => (message = value),
        ),
        buttons,
        el("p", "read-note merge-foot", `The commit is yours, on ${m.target}. Nothing is pushed.`),
      );
    });
  }
  /** The step after approval: merge into the target branch on the owner's tap, or what is in
   * the way and the way past it. Null while there is nothing to merge. Peekumi never pushes. */
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
        line = el("p", "merge-size", `${plural(m.commits, "commit")} · ${plural(m.files.length, "file")} `);
      line.append(el("span", "merge-add", `+${added}`));
      if (removed) line.append(" ", el("span", "merge-del", `−${removed}`));
      return line;
    };
    const check = () => action("Check again", () => refresh());
    if (m.state === "ready") {
      step.append(
        heading("success", `Ready to merge into ${m.target}`),
        size(),
        Object.assign(action(`Merge into ${m.target}`, () => confirmMerge(r, m), true), { id: "mergeTask" }),
        el("p", "read-note", "Fast-forward only. Peekumi does not push to GitHub."),
      );
    } else if (m.state === "merged") {
      const when = new Date(m.merge.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      step.append(heading("merged", `Merged into ${m.target}`), el("p", "merge-size", `${when} · ${m.target} is at ${m.merge.to.slice(0, 7)}`));
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
      else step.append(el("p", "read-note", `Undo is not possible: ${m.target} or the merged files changed after the merge.`));
      step.append(el("p", "read-note", "Peekumi does not push. Push from your terminal when you are ready."));
    } else if (m.state === "blocked") {
      const n = m.blocking.length,
        files = el("ul", "merge-files");
      for (const path of m.blocking) files.append(el("li", "", path));
      const row = el("div", "merge-buttons");
      row.append(check());
      step.append(
        heading("", `${n === 1 ? "1 of your files is" : `${n} of your files are`} in the way`),
        el("p", "merge-note", "You have uncommitted changes in these files, and the merge changes them too:"),
        files,
        Object.assign(action("Commit my changes, then merge", () => commitMine(r, m), true), { id: "commitFirst" }),
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
        el("p", "merge-note", `${m.target} changed after this task ran, so a fast-forward merge is not possible yet.`),
        Object.assign(action(`Update with ${m.target}`, () => updateTask(r), true), { id: "updateTask" }),
        el(
          "p",
          "read-note",
          `Peekumi merges ${m.target} into the task branch. If they conflict, the agent resolves it as a new round, and you review the result again before you merge.`,
        ),
      );
    } else if (m.state === "elsewhere") {
      step.append(
        heading("", `${m.target} is checked out in another folder`),
        el("p", "merge-note", m.folder),
        el("p", "read-note", `Merge there, or check out another branch in that folder. Then check again.`),
        check(),
      );
    }
    return step;
  }
  /** Every instruction in a task round: its work and any finished ones carried along. */
  /** A round's instructions: its work, the finished work it carries, and (in an update round)
   * the instructions that stay open for the owner's decision. */
  const instructionsOf = (r) => [...(r.comments || []), ...(r.done || []), ...(r.open || [])];
  /** A task in words: its first instruction (one line, shortened), how many more, and the
   * round after the first. A session is its title. */
  function taskTitle(r) {
    if (r.kind === "session") return r.title || "Session";
    const list = instructionsOf(r);
    const first = (list[0]?.text || "").split("\n")[0].replace(/[`*#>]/g, "").trim() || "Task";
    const words = first.length > 64 ? first.slice(0, 61).trimEnd() + "…" : first;
    const more = list.length > 1 ? ` + ${list.length - 1} more` : "";
    const round = r.round > 1 ? ` · round ${r.round}` : "";
    return `${words}${more}${round}`;
  }
  /** True once a finished task has no instruction left to review and at least one approved. */
  function reviewed(r) {
    if (r.status !== "completed") return false;
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
    return data.comments.filter((c) => c.runId === r.id && ["flagged", "unreported"].includes(c.status));
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
  /** One task in a list: its instructions, state and date. Done and past tasks are quiet. */
  function taskCard(r, quiet = false) {
    const card = action(taskTitle(r), () => openTask(r.id));
    card.classList.add("task-link");
    if (quiet) card.classList.add("quiet");
    card.append(
      el("span", "rd", `${runStatus(r)} · ${new Date(r.createdAt).toLocaleDateString()}`),
    );
    return card;
  }
  /** Applied and closed tasks, newest first: the record, out of the way of current work. */
  function history(body) {
    head("History");
    const past = data.runs
      .filter((r) => r.status !== "preview" && !r.revisedBy && stageOf(r) === "history")
      .slice()
      .reverse();
    if (!past.length) body.append(el("p", "empty", "No applied or closed tasks yet."));
    body.append(...past.map((r) => taskCard(r, true)));
  }
  function runStatus(r) {
    const target = r.targetBranch || "main";
    if (live(r)) return r.approval ? "Needs you" : r.status === "running" ? "Working" : "Your turn";
    if (r.kind === "session" && r.status === "cancelled") return "Ended without review";
    if (r.applied) return r.merge ? `Merged into ${target}` : `Applied to ${target}`;
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
    if (["failed", "interrupted", "cancelled"].includes(r.status)) return "stopped";
    return runStatus(r) === "Ready for review" ? "ready" : "";
  }
  function activityView(r) {
    const live = el("section", "task-live");
    const progress = agentActivity(r.output);
    if (active(r)) live.append(el("p", "workflow-text", progress.activity));
    if (["failed", "interrupted", "cancelled"].includes(r.status)) {
      // Say what happened and what to do next, in the owner's words, not the agent's log.
      const again = "Instructions that the agent did not answer show “Not done”. To try again, use Request changes: the next round includes them.";
      const ended = r.kind === "session" && r.status === "cancelled";
      const why = ended
        ? "You ended this session without review. Its branch stays, and nothing was merged."
        : r.status === "cancelled"
          ? "This task stopped: you stopped it, or it reached the one-hour limit."
          : progress.errors.join("\n") || r.message || "This task stopped before it finished.";
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
      record.append(el("summary", "", "Session conversation"), session.conversation(r));
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
    comments(body, r);
    const step = mergeStep(r);
    if (step) body.append(step);
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
    const ready = data.comments.filter(
      (c) => c.runId === r.id && c.status === "addressed",
    );
    // An applied task is a settled record: later changes start a new task.
    const decide = !active(r) && !r.revisedBy && !r.applied && !endedSession(r),
      batch = decide ? collected(r.id) : [];
    const agentName = agents.label(r.agent);
    if (batch.length) {
      // The list and the button that sends it to the agent, as the next round, sit together.
      body.append(
        el("h3", "workflow-group", "Requested changes"),
        Object.assign(action(
          `Send ${batch.length} change${batch.length === 1 ? "" : "s"} to ${agentName}`,
          async () => {
            const next = await write(`/api/runs/${r.id}/revise`, {});
            reply = null;
            await openTask(next.id);
          },
          true,
        ), { id: "sendChanges" }),
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
        const place = action(label(c.anchor), () => inspect(c.sha, c.sha, c.anchor));
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
    if (decide && ready.length)
      actions.append(
        action("Approve", async () => {
          try {
            for (const c of ready)
              await write(
                "/api/comments/" + c.id,
                { action: "verify", version: c.version, note: verificationNote },
                "PATCH",
              );
            verificationNote = "";
            reply = null;
          } finally {
            await refresh();
          }
          // The next step appears below the instructions; bring it into view.
          requestAnimationFrame(() =>
            document
              .querySelector(".apply-step")
              ?.scrollIntoView({ block: "start", behavior: "smooth" }),
          );
        }, true),
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
          for (const c of data.comments.filter(
            (x) => x.runId === r.id && x.status === "verified",
          ))
            await write(
              "/api/comments/" + c.id,
              { action: "unverify", version: c.version },
              "PATCH",
            );
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
    if (!data.runs.some((r) => active(r) || live(r)) && ++idle % 4) return;
    refresh("poll").catch((e) => notice(e.message, true));
  }, 3000);
  // A session on screen that is working updates faster, so its steps appear as they happen.
  setInterval(() => {
    if (document.hidden || !loaded || !runId() || runDetail?.id !== runId() || !live(runDetail) || runDetail.status !== "running") return;
    refresh("poll").catch((e) => notice(e.message, true));
  }, 1200);
  /** A run by `id`: the full copy on screen, else the list's summary. */
  const runOf = (id) => (runDetail?.id === id ? runDetail : data.runs.find((r) => r.id === id));
  return {
    refresh,
    openTask,
    focusRun,
    cueLive,
    /** True when a finished task, not yet continued, can collect changes for a next round. */
    revisable(id) {
      const r = data.runs.find((x) => x.id === id);
      return Boolean(r && !active(r) && !live(r) && !endedSession(r) && r.status !== "preview" && !r.revisedBy && !r.applied);
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
    /** The dock's Session box: a reply to run `id` (or the open session), or a new session. */
    renderSessionComposer: (host, id = null) =>
      session.renderComposer(host, id ? runOf(id) : liveSession(), { named: data.runs.filter(live).length > 1 }),
    /** "session" or "task": what run `id` is. */
    runKind: (id) => (runOf(id)?.kind === "session" ? "session" : "task"),
    /** True when run `id` is an open session (a conversation, not a task). */
    isLive: (id) => Boolean(runOf(id) && live(runOf(id))),
    /** How run `id` shows, for the sheet's scroll rule: "loading", "session" or "task". */
    runShape: (id) => (runDetail?.id === id ? (live(runDetail) ? "session" : "task") : "loading"),
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
          mood: r.approval ? "thinking" : r.status === "running" ? "working" : "ready",
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
      if (["tasks", "history", "instructions", "conversations", "run", "prepare"].includes(view.name))
        refresh().catch((e) => notice(e.message, true));
    },
    /** The ID of the open session, or null. */
    liveSessionId: () => liveSession()?.id || null,
    /** Draws page `view`: a list of instructions or tasks, the task form, or a run. */
    render(body, view) {
      bar();
      if (view.name === "prepare") {
        header(body, "Review task");
        prepare(body);
      } else if (view.name === "run") runs(body);
      else comments(body);
    },
  };
}
