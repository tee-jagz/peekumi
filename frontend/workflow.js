/** @module Anchored drafts, exact task previews, run reports and human verification. */
import { iconButton } from "./icons.js";
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
  viewBranch,
}) {
  let data = { comments: [], runs: [] },
    loaded = false,
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
    taskComparison = null,
    taskSource = null,
    taskPath = "",
    reviewing = false;
  let filter = "scope",
    verification = null,
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
  function refresh(render = true) {
    const pending = refreshQueue
      .catch(() => {})
      .then(async () => {
        data = await api("/api/workflow");
        loaded = true;
        if (runId) runDetail = await api("/api/runs/" + runId);
        bar();
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
          redraw();
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
    if (tasksButton) {
      // The cue is the icon colour plus the accessible name, never a count badge.
      tasksButton.dataset.ready = String(ready.length > 0);
      tasksButton.setAttribute(
        "aria-label",
        ready.length ? `Tasks, ${ready.length} ready to review` : "Tasks",
      );
      tasksButton.title = ready.length
        ? `${ready.length} task${ready.length === 1 ? "" : "s"} ready to review on its agent branch`
        : "Open tasks";
    }
    if (
      ["comments", "runs"].includes(
        document.querySelector("#panel")?.dataset.tab,
      )
    )
      return;
    const drafts = data.comments.filter((c) => c.status === "draft"),
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
          (editing ? "Edit · " : "Comment · ") +
            label(composer.anchor) +
            " · " +
            composer.sha.slice(0, 7),
        ),
        field("What should change, and why", draft, (v) => (draft = v), 1),
      );
      const buttons = el("div", "sel-acts");
      const save = action(
        "Save draft",
        async () => {
          if (editing)
            await write(
              "/api/comments/" + editing.id,
              { action: "edit", version: editing.version, text: draft },
              "PATCH",
            );
          else await write("/api/comments", { ...composer, text: draft });
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
      iconButton(save, "check", "Save draft");
      for (const b of [cancel, save]) b.classList.add("icon-action");
      buttons.append(cancel, save);
      const input = box.querySelector("textarea");
      input.placeholder = "What should change, and why?";
      input.setAttribute("aria-label", "What should change, and why");
      input.parentElement.firstChild.textContent = "";
      input.parentElement.classList.add("dock-input");
      box.append(buttons);
      buttons.classList.add("draft-buttons");
      composerHost.append(box);
    }
  }
  function comments(body, task = null) {
    if (!task) {
      body.append(el("h2", "task-heading", "Tasks"));
      const drafts = data.comments.filter((c) => c.status === "draft");
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
      for (const r of data.runs
        .filter((r) => r.status !== "preview")
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
      : data.comments.filter((c) => c.status === "draft");
    if (!items.length && !data.runs.some((r) => r.status !== "preview"))
      body.append(
        el(
          "p",
          "empty",
          loaded ? "Add a comment below to start a task." : "Loading tasks…",
        ),
      );
    for (const state of Object.keys(states)) {
      const group = items.filter((c) => c.status === state);
      if (!group.length) continue;
      if (!task) body.append(el("h3", "workflow-group", "Your draft comments"));
      for (const c of group) {
        const card = el("article", "workflow-card");
        card.dataset.commentId = c.id;
        const top = el("div", "cm-top");
        top.append(
          action(label(c.anchor), () => inspect(c.sha, c.sha, c.anchor)),
          el("span", "pill", states[c.status]),
        );
        card.append(
          top,
          el("p", "workflow-text", c.text),
          el(
            "p",
            "rd",
            `Left on ${c.sha.slice(0, 7)} · ${new Date(c.createdAt).toLocaleString()}`,
          ),
        );
        const report = c.report;
        if (report) {
          card.append(
            el("strong", "report-label", "Agent result"),
            el("p", "workflow-text", report.note || report.reason),
          );
          if (report.checks) {
            const d = el("details", "workflow-evidence");
            d.append(
              el("summary", "", "Agent-reported checks"),
              el("p", "workflow-text", report.checks),
            );
            card.append(d);
          }
        }
        if (c.verification)
          card.append(
            el(
              "p",
              "verification-note",
              "Reviewed by you: " + c.verification.note,
            ),
          );
        const controls = el("div", "sel-acts"),
          run = data.runs.find((r) => r.id === c.runId),
          busy = run && active(run);
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
        if (c.runId && !task)
          controls.append(
            action("View run", async () => {
              runId = c.runId;
              preparing = false;
              showTab("runs");
              await refresh();
            }),
          );
        if (["addressed", "flagged", "unreported"].includes(c.status) && !busy)
          controls.append(
            action(
              c.status === "unreported" ? "Retry comment" : "Request changes",
              () => transition(c, "reopen"),
            ),
          );
        if (c.status === "flagged" && !busy)
          controls.append(action("Delete", () => transition(c, "delete")));
        card.append(controls);
        body.append(card);
      }
    }
  }
  function prepare(body) {
    body.append(
      el("h3", "workflow-group", "Review task"),
      el(
        "p",
        "read-note",
        `The task starts from ${(data.watched || "main").replace("refs/heads/", "")}. Choose the comments to send; results return here for review.`,
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
    for (const c of data.comments.filter((c) => c.status === "draft")) {
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
        },
        true,
      ),
      action("Back to tasks", () => {
        preparing = false;
        showTab("comments");
      }),
    );
    if (preview) {
      const summary = el("section", "task-preview");
      summary.append(
        el("h3", "", "Ready to start"),
        el(
          "p",
          "workflow-text",
          `${preview.agent === "codex" ? "Codex" : "Claude Code"} will work on ${preview.comments.length} comment${preview.comments.length === 1 ? "" : "s"}. You will review the results here. Your main branch stays unchanged.`,
        ),
      );
      for (const c of preview.comments)
        summary.append(el("p", "workflow-text", c.text));
      if (preview.brief)
        summary.append(el("p", "workflow-text", preview.brief));
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
  function taskTitle(r) {
    const paths = [
      ...new Set((r.comments || []).map((c) => c.anchor.path || "Repository")),
    ];
    const scope = paths.length === 1 ? paths[0] : `${paths.length} locations`;
    return `${r.comments?.length || 0} comment${r.comments?.length === 1 ? "" : "s"} · ${scope}`;
  }
  function runStatus(r) {
    if (r.applied) return `Applied to ${r.targetBranch || "main"}`;
    if (r.status === "completed") {
      const comments = data.comments.filter((c) =>
        r.comments.some((x) => x.id === c.id),
      );
      return comments.length && comments.every((c) => c.status === "verified")
        ? "Reviewed · not applied to main"
        : "Ready for review";
    }
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
    runId = id;
    preparing = false;
    reviewing = false;
    taskSource = taskComparison = null;
    taskPath = "";
    showTab("runs");
    await refresh();
  }
  async function reviewTask(r, path = "") {
    runId = r.id;
    preparing = false;
    reviewing = true;
    const sha =
      r.results?.at(-1) ||
      data.comments.find((c) => c.runId === r.id && c.report?.commit)?.report
        .commit;
    if (!sha) throw Error("No committed changes were reported for this task.");
    taskComparison = await api(
      "/api/compare?" +
        new URLSearchParams({ base: r.base, head: sha, view: "overview" }),
    );
    const files = taskComparison.files.filter((f) => f.status !== "unchanged");
    taskPath = files.find((f) => f.path === path)?.path || files[0]?.path || "";
    taskSource = null;
    if (taskPath) await loadTaskFile(taskPath);
    showTab("runs");
    await refresh();
    document.querySelector("#reviewScroll").scrollTop = 0;
  }
  async function loadTaskFile(path) {
    const comparison = taskComparison;
    taskPath = path;
    taskSource = null;
    const source = await api(
      "/api/source?" +
        new URLSearchParams({
          base: comparison.base,
          head: comparison.head,
          path,
        }),
    );
    if (taskComparison === comparison && taskPath === path) taskSource = source;
  }
  function activityView(r) {
    const live = el("section", "task-live");
    live.append(el("p", "task-state", runStatus(r)));
    const progress = agentActivity(r.output);
    if (active(r)) live.append(el("p", "workflow-text", progress.activity));
    if (["failed", "interrupted", "cancelled"].includes(r.status)) {
      live.append(
        el(
          "p",
          "workflow-text",
          progress.errors.join("\n") ||
            "This task stopped before finishing. Review the updates, then retry any unanswered comments.",
        ),
      );
    }
    const latest = progress.messages.at(-1);
    if (latest && active(r))
      live.append(el("p", "workflow-text agent-message", latest));
    if (r.status === "completed")
      live.append(
        el(
          "p",
          "read-note",
          r.applied
            ? `Changes are committed on ${r.targetBranch || "main"}. Deployment is separate from applying changes.`
            : "Changes are committed on the task branch. Reviewing them does not apply or deploy them to main.",
        ),
      );
    return live;
  }
  function updateLive() {
    const live = document.querySelector(".task-live");
    if (live && runDetail) live.replaceWith(activityView(runDetail));
  }
  function runs(body) {
    if (!reviewing)
      body.append(
        action("Back to tasks", () => {
          preparing = false;
          showTab("comments");
        }),
      );
    if (preparing) {
      prepare(body);
      return;
    }
    if (!runDetail || runDetail.id !== runId) {
      body.append(el("p", "read-note", "Loading task…"));
      return;
    }
    const r = runDetail;
    if (reviewing && taskComparison) {
      body.append(
        action("Back to result", () => {
          reviewing = false;
          redraw();
          document.querySelector("#reviewScroll").scrollTop = 0;
        }),
      );
      const files = taskComparison.files.filter(
        (f) => f.status !== "unchanged",
      );
      const label = el(
        "label",
        "workflow-field",
        `${files.length} changed file${files.length === 1 ? "" : "s"}`,
      );
      const select = el("select");
      select.setAttribute("aria-label", "Changed file");
      for (const file of files) {
        const option = el("option", "", file.path);
        option.value = file.path;
        select.append(option);
      }
      select.value = taskPath;
      select.onchange = async () => {
        try {
          await loadTaskFile(select.value);
          redraw();
        } catch (e) {
          notice(e.message, true);
        }
      };
      label.append(select);
      body.append(label);
      if (taskSource) renderDiff(body, taskSource.patch);
      else body.append(el("p", "read-note", "No readable file changes."));
      body.append(
        action("Show on map", () =>
          inspect(taskComparison.base, taskComparison.head, {
            kind: "file",
            path: taskPath,
          }),
        ),
      );
      return;
    }
    body.append(el("h2", "task-heading", taskTitle(r)), activityView(r));
    if (active(r) && r.status !== "interrupted")
      body.append(
        action("Stop task", async () => {
          await write(`/api/runs/${r.id}/cancel`, {});
          await refresh();
        }),
      );
    if (r.results?.length) {
      if (r.status === "completed")
        body.append(
          action("Review agent branch", () => viewBranch(r.branch), true),
        );
      body.append(action("Review all changes", () => reviewTask(r)));
    }
    comments(body, r);
    const ready = data.comments.filter(
      (c) => c.runId === r.id && c.status === "addressed",
    );
    if (ready.length && !active(r)) {
      body.append(
        action("Mark task reviewed", () => {
          verification = "task";
          redraw();
        }),
      );
      if (verification === "task") {
        body.append(
          el(
            "p",
            "read-note",
            "Records your review of all ready comments. This does not apply or deploy changes to main.",
          ),
          field(
            "Review note",
            verificationNote,
            (value) => (verificationNote = value),
          ),
          action(
            "Confirm review",
            async () => {
              try {
                for (const c of ready)
                  await write(
                    "/api/comments/" + c.id,
                    {
                      action: "verify",
                      version: c.version,
                      note: verificationNote,
                    },
                    "PATCH",
                  );
                verification = null;
                verificationNote = "";
              } finally {
                await refresh();
              }
            },
            true,
          ),
          action("Cancel review", () => {
            verification = null;
            redraw();
          }),
        );
      }
    }

    const progress = agentActivity(r.output);
    if (progress.messages.length) {
      const updates = el("details", "workflow-evidence");
      updates.dataset.key = "updates";
      updates.append(el("summary", "", "Earlier agent updates"));
      for (const message of progress.messages)
        updates.append(el("p", "workflow-text", message));
      body.append(updates);
    }
    const diagnostics = el("details", "workflow-evidence diagnostics");
    diagnostics.dataset.key = "diagnostics";
    diagnostics.append(
      el("summary", "", "Diagnostics"),
      el("p", "rd", r.branch),
    );
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
    diagnostics.append(output, prompt);
    body.append(diagnostics);
  }
  // Poll results even while diagnostics or the composer are open. Refresh restores
  // disclosure state, draft text, focus, cursor position and the reading position.
  setInterval(() => {
    if (document.hidden || !loaded || !data.runs.some(active)) return;
    refresh().catch((e) => notice(e.message, true));
  }, 3000);
  return {
    refresh,
    compose,
    renderComposer,
    render(body, tab) {
      bar();
      tab === "comments" ? comments(body) : runs(body);
    },
  };
}
