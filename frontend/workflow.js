/** @module Anchored drafts, exact task previews, run reports and human verification. */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  n.className = cls || "";
  if (text !== undefined) n.textContent = text;
  return n;
};
const states = {
  draft: "Draft",
  with_agent: "With agent",
  addressed: "To verify",
  flagged: "Flagged",
  verified: "Verified",
  unreported: "Unreported",
};
const active = (r) => ["starting", "running", "interrupted"].includes(r.status);
const label = (a) =>
  a.symbol
    ? `${a.path} · ${a.symbol}`
    : a.kind === "edge"
      ? `${a.path} → ${a.target} · ${a.relationship}`
      : a.path || "Repository";

/** Creates a panel controller; writes are explicit owner actions and poll updates preserve input. */
export function createWorkflow({
  api,
  context,
  showTab,
  redraw,
  notice,
  inspect,
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
    runDetail = null;
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
        if (render) redraw();
      });
    refreshQueue = pending;
    return pending;
  }
  function bar() {
    const host = document.querySelector("#runBar");
    host.replaceChildren();
    const drafts = data.comments.filter((c) => c.status === "draft"),
      running = data.runs.find(active);
    const waiting = data.comments.filter((c) => c.status === "addressed");
    if (!drafts.length && !running && !waiting.length) return;
    const b = action(
      running
        ? `${running.agent} running · View progress ›`
        : drafts.length
          ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting · Prepare run ›`
          : `${waiting.length} ready to verify ›`,
      () => {
        if (running) {
          runId = running.id;
          showTab("runs");
          return refresh();
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
    composer = context();
    editing = null;
    draft = "";
    showTab("comments");
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
  function comments(body) {
    const tools = el("div", "sel-acts");
    tools.append(
      action("Comment on selection", compose, true),
      action("View runs", () => {
        preparing = false;
        showTab("runs");
      }),
      action(filter === "all" ? "Show this scope" : "Show all comments", () => {
        filter = filter === "all" ? "scope" : "all";
        redraw();
      }),
    );
    body.append(tools);
    body.append(
      el(
        "p",
        "read-note",
        "Current review status · anchors retain the revision where you left them. Drafts stay private until you dispatch a run.",
      ),
    );
    if (composer) {
      const box = el("section", "workflow-card composer");
      box.append(
        el("h3", "", editing ? "Edit draft" : "New draft"),
        el(
          "p",
          "rd",
          label(composer.anchor) + " · " + composer.sha.slice(0, 8),
        ),
        field("What should change, and why", draft, (v) => (draft = v)),
      );
      const buttons = el("div", "sel-acts");
      buttons.append(
        action(
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
            await refresh();
          },
          true,
        ),
        action("Cancel", () => {
          composer = null;
          redraw();
        }),
      );
      box.append(buttons);
      body.append(box);
    }
    const items = data.comments.filter(visible);
    if (!items.length)
      body.append(
        el(
          "p",
          "empty",
          loaded ? "No comments in this scope yet." : "Loading comments…",
        ),
      );
    for (const state of Object.keys(states)) {
      const group = items.filter((c) => c.status === state);
      if (!group.length) continue;
      body.append(
        el("h3", "workflow-group", `${states[state]} · ${group.length}`),
      );
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
            `Left on ${c.sha.slice(0, 8)} · ${new Date(c.createdAt).toLocaleString()}`,
          ),
        );
        const report = c.report;
        if (report) {
          card.append(el("p", "workflow-text", report.note || report.reason));
          if (report.checks) {
            const d = el("details", "workflow-evidence");
            d.append(
              el("summary", "", "Agent-reported checks"),
              el("pre", "taskpre", report.checks),
            );
            card.append(d);
          }
        }
        if (c.verification)
          card.append(
            el(
              "p",
              "verification-note",
              "Verified by you: " + c.verification.note,
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
        if (c.runId)
          controls.append(
            action("View run", async () => {
              runId = c.runId;
              preparing = false;
              showTab("runs");
              await refresh();
            }),
          );
        if (report?.commit)
          controls.append(
            action(
              "Review fix",
              () => inspect(run.base, report.commit, c.anchor),
              true,
            ),
          );
        if (c.status === "addressed" && !busy)
          controls.append(
            action("Verify", () => {
              verification = c.id;
              verificationNote = "";
              redraw();
            }),
          );
        if (["addressed", "flagged", "unreported"].includes(c.status) && !busy)
          controls.append(action("Reopen", () => transition(c, "reopen")));
        if (c.status === "flagged" && !busy)
          controls.append(action("Delete", () => transition(c, "delete")));
        card.append(controls);
        if (verification === c.id) {
          card.append(
            field(
              "What did you check?",
              verificationNote,
              (v) => (verificationNote = v),
            ),
            action(
              "Confirm verification",
              async () => {
                await transition(c, "verify", { note: verificationNote });
                verification = null;
                redraw();
              },
              true,
            ),
            action("Cancel verification", () => {
              verification = null;
              redraw();
            }),
          );
        }
        const history = el("details", "workflow-evidence");
        history.append(el("summary", "", "Review history"));
        for (const h of c.history)
          history.append(
            el(
              "p",
              "rd",
              `${new Date(h.updatedAt).toLocaleString()} · ${h.actor} · ${states[h.status] || h.status}${h.report?.commit ? " · " + h.report.commit.slice(0, 8) : ""}`,
            ),
            el("p", "workflow-text", h.text),
            ...(h.report
              ? [el("p", "workflow-text", h.report.note || h.report.reason)]
              : []),
          );
        card.append(history);
        body.append(card);
      }
    }
  }
  function prepare(body) {
    body.append(
      el("h3", "workflow-group", "Prepare run"),
      el(
        "p",
        "read-note",
        `Starts from the latest commit on ${data.watched || "the watched branch"}, in a separate worktree. Changes stay on the run branch for your review.`,
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
      field("Brief · decisions and constraints", brief, (v) => {
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
      action("Back to runs", () => {
        preparing = false;
        redraw();
      }),
    );
    if (preview) {
      body.append(
        el(
          "p",
          "read-note",
          `Exact task · ${preview.base.slice(0, 8)} → ${preview.branch}`,
        ),
        el("pre", "taskpre", preview.task),
      );
      const b = action(
        "Dispatch run",
        async () => {
          const result = await write("/api/runs", { previewId: preview.id });
          runId = result.id;
          preparing = false;
          preview = null;
          await refresh();
        },
        true,
      );
      b.id = "dispatchRun";
      body.append(b);
    }
  }
  function runs(body) {
    body.append(action("Back to comments", () => showTab("comments")));
    if (preparing) {
      prepare(body);
      return;
    }
    body.append(
      action(
        "Prepare run",
        () => {
          preparing = true;
          preview = null;
          picks = new Set(
            data.comments.filter((c) => c.status === "draft").map((c) => c.id),
          );
          redraw();
        },
        true,
      ),
      action("Refresh runs", () => refresh()),
    );
    if (runId && runDetail) {
      const r = runDetail,
        box = el("section", "workflow-card");
      box.append(
        el("h3", "", `${r.agent} · ${r.status}`),
        el("p", "rd", r.branch),
        el(
          "p",
          "workflow-text",
          r.message || "Agent is working. Progress refreshes automatically.",
        ),
      );
      if (active(r) && r.status !== "interrupted")
        box.append(
          action("Stop run", async () => {
            await write(`/api/runs/${r.id}/cancel`, {});
            await refresh();
          }),
        );
      for (const sha of r.results || [])
        box.append(
          action("Inspect " + sha.slice(0, 8), () =>
            inspect(r.base, sha, { kind: "repo", path: "" }),
          ),
        );
      const progress = el("details", "workflow-evidence");
      progress.append(
        el("summary", "", "Agent output"),
        el("pre", "taskpre", r.output || "No output yet."),
      );
      const task = el("details", "workflow-evidence");
      task.append(
        el("summary", "", "Dispatched task"),
        el("pre", "taskpre", r.task),
      );
      box.append(progress, task);
      body.append(box);
    }
    const saved = data.runs.filter((r) => r.status !== "preview").reverse();
    if (!saved.length)
      body.append(
        el(
          "p",
          "empty",
          "No runs yet. Collect draft comments, preview the task, then dispatch when ready.",
        ),
      );
    for (const r of saved) {
      const b = action(
        `${r.agent} · ${r.status} · ${r.comments.length} comments · ${r.id.slice(0, 8)}`,
        async () => {
          runId = r.id;
          await refresh();
        },
      );
      b.classList.add("workflow-run");
      body.append(b);
    }
  }
  // Avoid replacing fields/details while the owner is reading or typing. The bar remains current.
  setInterval(() => {
    if (document.hidden || !loaded || !data.runs.some(active)) return;
    const focus = document.activeElement;
    const editing =
      focus?.matches("textarea,input,select") ||
      document.querySelector("#tabBody details[open]");
    refresh(!editing).catch((e) => notice(e.message, true));
  }, 3000);
  return {
    refresh,
    compose,
    render(body, tab) {
      bar();
      tab === "comments" ? comments(body) : runs(body);
    },
  };
}
