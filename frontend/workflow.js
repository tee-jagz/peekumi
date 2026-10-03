/** @module Anchored drafts, exact task previews, run reports and human verification. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";
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
  verified: "Reviewed",
  unreported: "Needs retry",
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
      if (/^(error:|Error:)/.test(line)) errors.push(line.slice(0, 500));
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
      if (typeof reason === "string") errors.push(reason);
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
  context,
  showTab,
  redraw,
  notice,
  inspect,
  explore,
  exploring,
}) {
  let data = { comments: [], runs: [] },
    loaded = false,
    lastSignature = "",
    refreshQueue = Promise.resolve();
  let composer = null,
    draft = "",
    editing = null,
    preview = null,
    preparing = false;
  let agent = "codex",
    brief = "",
    picks = new Set(),
    runId = null,
    runDetail = null,
    // Below a finished task's actions: null, "note" (for Approve) or "changes" (Request changes).
    reply = null,
    feedback = "";
  // "here" lists comments on the current selection; "all" is the Tasks overview.
  let filter = "all",
    verificationNote = "";
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
        if (runId) runDetail = await api("/api/runs/" + runId);
        bar();
        const signature = JSON.stringify([data, runDetail]),
          changed = signature !== lastSignature;
        lastSignature = signature;
        if (render === "poll")
          render =
            changed &&
            ["comments", "runs", "discussion"].includes(
              document.querySelector("#panel")?.dataset.view,
            );
        if (render) {
          const focused = document.activeElement;
          const focusLabel = focused?.matches("textarea,input,select")
            ? focused.getAttribute("aria-label")
            : null;
          const selection =
            focused?.tagName === "TEXTAREA"
              ? [focused.selectionStart, focused.selectionEnd]
              : null;
          const scroll = document.querySelector("#reviewScroll");
          const top = scroll?.scrollTop || 0;
          const opened = [
            ...document.querySelectorAll("#tabBody details[open]"),
          ]
            .map((d) => d.dataset.key)
            .filter(Boolean);
          const kept = document.querySelector("#tabBody .task-peek");
          redraw();
          // The same Peek carries on across a redraw rather than restarting its loop.
          const fresh = document.querySelector("#tabBody .task-peek");
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
          if (scroll) scroll.scrollTop = top;
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
    const running = data.runs.find(active),
      stuck = !running && data.runs.find(stalled);
    const next = running ? "working" : stuck ? "attention" : ready.length ? "ready" : "";
    const agent = (r) => (r.agent === "claude" ? "Claude Code" : "Codex");
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
  function bar() {
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
    if (
      ["comments", "runs"].includes(
        document.querySelector("#panel")?.dataset.view,
      )
    )
      return;
    const drafts = data.comments.filter(sendable),
      running = data.runs.find(active);
    const waiting = data.comments.filter((c) => c.status === "addressed");
    if (!drafts.length && !running && !waiting.length) return;
    const b = action(
      running
        ? `${running.agent} running · View progress ›`
        : drafts.length
          ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting · Prepare run ›`
          : `${waiting.length} ready for review ›`,
      () => {
        if (running) {
          return openTask(running.id);
        }
        if (drafts.length) {
          preparing = true;
          picks = new Set(drafts.map((c) => c.id));
          preview = null;
          showTab("runs");
        } else {
          filter = "all";
          showTab("comments");
        }
      },
    );
    b.className = "runbar";
    host.append(b);
  }
  function compose() {
    if (!composer) {
      composer = context();
      editing = null;
      draft = "";
    }
    filter = "here";
    showTab("comments");
    document
      .querySelector("#composerHost textarea")
      ?.focus({ preventScroll: true });
  }
  function visible(c) {
    if (c.status === "deleted") return false;
    if (filter === "all") return true;
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
    if (!composer || (!draft && !editing)) composer = context();
    if (composer) {
      const box = el("section", "composer");
      box.append(
        el(
          "p",
          "composer-anchor",
          (editing ? "Edit · " : "") +
            dockLabel(composer.anchor) +
            " · " +
            composer.sha.slice(0, 7),
        ),
        field("What should change, and why", draft, (v) => (draft = v), 1),
      );
      const buttons = el("div", "sel-acts");
      const target = editing ? null : exploring();
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
            return;
          }
          if (editing)
            await write(
              "/api/comments/" + editing.id,
              { action: "edit", version: editing.version, text: draft },
              "PATCH",
            );
          else await write("/api/comments", { ...composer, text: draft });
          // A new comment stays with its selection; an edit stays in the list it came from.
          if (!editing) filter = "here";
          composer = null;
          draft = "";
          editing = null;
          showTab("comments");
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
  function comments(body, task = null) {
    const here = !task && filter === "here";
    if (here) {
      const top = el("div", "ask-head");
      top.append(
        el("p", "read-note", "Instructions here · drafts wait until you send them as a task"),
        action("All tasks", () => {
          filter = "all";
          showTab("comments");
        }),
      );
      body.append(top);
    }
    if (!task && !here) {
      body.append(el("h2", "task-heading", "Tasks"));
      const drafts = data.comments.filter(sendable);
      if (drafts.length)
        body.append(
          action(
            `Review task · ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`,
            () => {
              preparing = true;
              preview = null;
              picks = new Set(drafts.map((c) => c.id));
              showTab("runs");
            },
            true,
          ),
        );
      // A task's earlier rounds open from its latest one.
      for (const r of data.runs
        .filter((r) => r.status !== "preview" && !r.revisedBy)
        .slice()
        .reverse()) {
        const card = action(taskTitle(r), () => openTask(r.id));
        card.classList.add("task-link");
        card.append(
          el(
            "span",
            "rd",
            `${runStatus(r)} · ${new Date(r.createdAt).toLocaleDateString()}`,
          ),
        );
        body.append(card);
      }
    }
    const items = task
      ? data.comments.filter(
          (c) =>
            task.comments.some((snapshot) => snapshot.id === c.id) &&
            c.status !== "deleted",
        )
      : here
        ? data.comments.filter(visible)
        : data.comments.filter(sendable);
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
    else if (!here && !items.length && !data.runs.some((r) => r.status !== "preview"))
      body.append(
        el(
          "p",
          "empty",
          loaded ? "Add an instruction below to start a task." : "Loading tasks…",
        ),
      );
    for (const state of Object.keys(states)) {
      const group = items.filter((c) => c.status === state);
      if (!group.length) continue;
      if (!task && !here)
        body.append(el("h3", "workflow-group", "Your draft instructions"));
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
            c.forRun ? "To send with its task" : states[c.status],
          );
          state.dataset.state = c.status;
          foot.append(state);
        }
        card.append(richText(c.text, "workflow-text"), foot);
        const report = c.report;
        if (report) {
          card.append(
            el("strong", "report-label", "Agent result"),
            richText(report.note || report.reason, "workflow-text"),
          );
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
                ? "Reviewed by you: " + c.verification.note
                : "Reviewed by you",
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
        body.append(card);
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
    const l = el("label", "workflow-field", "Agent"),
      select = el("select");
    for (const a of ["codex", "claude"]) {
      const o = el("option", "", a === "codex" ? "Codex" : "Claude Code");
      o.value = a;
      select.append(o);
    }
    select.value = agent;
    select.onchange = () => {
      agent = select.value;
      preview = null;
      redraw();
    };
    l.append(select);
    body.append(l);
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
            agent,
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
        true,
      ),
    );
    if (preview) {
      const summary = el("section", "task-preview");
      summary.append(
        el("h3", "", "Ready to start"),
        el(
          "p",
          "workflow-text",
          `${preview.agent === "codex" ? "Codex" : "Claude Code"} will work on ${preview.comments.length} instruction${preview.comments.length === 1 ? "" : "s"}. You will review the results here. Your main branch stays unchanged.`,
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
          preparing = false;
          preview = null;
          await openTask(result.id);
        },
        true,
      );
      b.id = "dispatchRun";
      body.append(b);
    }
  }
  /** The step after approval. Peekumi never merges, so it names the branch and the exact command. */
  function applyStep(r) {
    const target = r.targetBranch || "main",
      command = `git merge --ff-only ${r.branch}`;
    const step = el("section", "apply-step");
    // Approval is the happy moment: Peek celebrates beside the next step.
    const heading = el("h3", "workflow-group");
    heading.append(peek("success"), document.createTextNode(`Next: apply to ${target}`));
    const line = el("div", "command-line"),
      code = el("code", "", command),
      copy = iconButton(el("button", "btn icon-action"), "copy", "Copy command");
    copy.type = "button";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(command);
        notice("Command copied");
        setTimeout(() => notice(""), 1500);
      } catch {
        // Plain HTTP has no clipboard access; select the command for a manual copy.
        getSelection().selectAllChildren(code);
        notice("Clipboard unavailable here; the command is selected for copying");
      }
    };
    line.append(code, copy);
    step.append(
      heading,
      el(
        "p",
        "read-note",
        `Peekumi never merges. In the repository, with ${target} checked out, run:`,
      ),
      line,
      el(
        "p",
        "read-note",
        `If ${target} has moved on, run it without --ff-only or open a pull request from ${r.branch}. This task changes to “Applied to ${target}” once its commits are on ${target}.`,
      ),
    );
    return step;
  }
  function taskTitle(r) {
    const paths = [
      ...new Set((r.comments || []).map((c) => c.anchor.path || "Repository")),
    ];
    const scope = paths.length === 1 ? paths[0] : `${paths.length} locations`;
    const round = r.round > 1 ? ` · round ${r.round}` : "";
    return `${r.comments?.length || 0} instruction${r.comments?.length === 1 ? "" : "s"} · ${scope}${round}`;
  }
  /** True once a finished task has no instruction left to review and at least one approved. */
  function reviewed(r) {
    if (r.status !== "completed") return false;
    const comments = data.comments.filter((c) =>
      r.comments.some((x) => x.id === c.id),
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
  function runStatus(r) {
    const target = r.targetBranch || "main";
    if (r.applied) return `Applied to ${target}`;
    if (r.revisedBy) return "Changes requested";
    if (r.status === "completed" && !reviewed(r) && !open(r).length)
      return "Nothing left to review";
    if (r.status === "completed")
      return reviewed(r) ? `Reviewed · not applied to ${target}` : "Ready for review";
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
  async function openTask(id) {
    if (id !== runId) reply = null;
    runId = id;
    preparing = false;
    showTab("runs");
    await refresh();
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
  function header(body, title, status = "", mood = "") {
    const row = el("div", "task-head"),
      back = iconButton(el("button", "btn icon-action"), "back", "Back to tasks"),
      text = el("div");
    back.type = "button";
    back.onclick = () => {
      preparing = false;
      showTab("comments");
    };
    text.append(el("h2", "task-heading", title));
    if (status) text.append(el("p", "task-meta", status));
    row.append(back, text);
    if (mood) row.append(peek(mood, { className: "task-peek" }));
    body.append(row);
  }
  /** Peek's state for a task: working while it runs, ready to review, merged once applied,
   * stopped when it ended early; none otherwise. */
  function moodOf(r) {
    if (active(r) && r.status !== "interrupted") return "working";
    if (r.applied) return "merged";
    if (r.revisedBy) return "";
    if (["failed", "interrupted", "cancelled"].includes(r.status)) return "stopped";
    return runStatus(r) === "Ready for review" ? "ready" : "";
  }
  function activityView(r) {
    const live = el("section", "task-live");
    const progress = agentActivity(r.output);
    if (active(r)) live.append(el("p", "workflow-text", progress.activity));
    if (["failed", "interrupted", "cancelled"].includes(r.status)) {
      live.append(
        el(
          "p",
          "workflow-text",
          progress.errors.join("\n") ||
            "This task stopped before finishing. Review the updates, then retry any unanswered instructions.",
        ),
      );
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
  function runs(body) {
    if (preparing) {
      header(body, "Review task");
      prepare(body);
      return;
    }
    if (!runDetail || runDetail.id !== runId) {
      header(body, "Task");
      body.append(el("p", "read-note", "Loading task…"));
      return;
    }
    const r = runDetail;
    // What state the task is in leads; how many instructions and where is the quiet line.
    header(body, runStatus(r), taskTitle(r), moodOf(r));
    body.append(activityView(r));
    if (runStatus(r) === "Nothing left to review")
      body.append(
        el(
          "p",
          "read-note",
          `This task's instructions were deleted, so there is nothing to approve or send back. The agent's work is still on ${r.branch}: Explore changes shows it.`,
        ),
      );
    if (r.feedback) {
      const asked = el("article", "workflow-card requested");
      asked.append(
        el("p", "report-label", "You asked for changes"),
        richText(r.feedback, "workflow-text"),
      );
      body.append(asked);
    }
    comments(body, r);
    if (reviewed(r) && !r.applied && r.results?.length) body.append(applyStep(r));
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
        action("Explore changes", () => explore(r.base, r.branch, r.id), true),
      );
    // A later round carries this one's work forward; decisions happen there.
    if (r.revisedBy)
      actions.append(
        action(`Open round ${(r.round || 1) + 1}`, () => openTask(r.revisedBy)),
      );
    const ready = data.comments.filter(
      (c) => c.runId === r.id && c.status === "addressed",
    );
    const decide = !active(r) && !r.revisedBy,
      batch = decide ? collected(r.id) : [];
    if (batch.length) {
      body.append(el("h3", "workflow-group", `Requested changes · ${batch.length}`));
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
        }),
      );
    if (decide && (open(r).length || batch.length) && reply !== "changes")
      actions.append(
        action("Request changes", () => {
          reply = "changes";
          redraw();
          document.querySelector(".reply-box textarea")?.focus();
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
    if (decide && reply === "changes" && (open(r).length || batch.length)) {
      // The agent continues from its own commits with this feedback, as the next round.
      const box = el("section", "reply-box");
      const ask = field(
        batch.length ? "Anything else? (optional)" : "What needs fixing?",
        feedback,
        (value) => {
          feedback = value;
          send.disabled = !value.trim() && !batch.length;
        },
        3,
      );
      const send = action(
        "Send to agent",
        async () => {
          const next = await write(`/api/runs/${r.id}/revise`, { feedback });
          feedback = "";
          reply = null;
          await openTask(next.id);
        },
        true,
      );
      send.disabled = !feedback.trim() && !batch.length;
      const row = el("div", "sel-acts task-actions");
      row.append(
        send,
        action("Cancel", () => {
          reply = null;
          redraw();
        }),
      );
      box.append(
        ask,
        el(
          "p",
          "read-note",
          `${r.agent === "claude" ? "Claude Code" : "Codex"} continues from its last commit on a new round. Nothing reaches ${r.targetBranch || "main"} until you apply it.`,
        ),
        row,
      );
      body.append(box);
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
  setInterval(() => {
    if (document.hidden || !loaded || !data.runs.some(active)) return;
    refresh("poll").catch((e) => notice(e.message, true));
  }, 3000);
  return {
    refresh,
    compose,
    openTask,
    focusRun,
    /** True when a finished task, not yet continued, can collect changes for a next round. */
    revisable(id) {
      const r = data.runs.find((x) => x.id === id);
      return Boolean(r && !active(r) && r.status !== "preview" && !r.revisedBy);
    },
    /** How many instructions are waiting to go back with task `id`. */
    collected: (id) => collected(id).length,
    /** Adds an instruction at `anchor` on commit `sha` to task `id`'s next round. */
    async collect(id, anchor, sha, text) {
      await write("/api/comments", { anchor, sha, text, forRun: id });
      await refresh(false);
    },
    renderComposer,
    /** Chooses between instructions on the selection ("here") and the Tasks overview ("all"). */
    scope(value) {
      filter = value;
    },
    scoped: () => filter === "here",
    render(body, tab) {
      bar();
      tab === "comments" ? comments(body) : runs(body);
    },
  };
}
