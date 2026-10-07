import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";
import { fixture, waitFor } from "./workflow-support.mjs";
test("anchored drafts, immutable previews, scoped MCP reports, verification and persistence", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const req = f.req;
  const create = (text) =>
    req("/api/comments", {
      text,
      sha: f.sha,
      anchor: { kind: "symbol", path: "module.py", symbol: "run", line: 2 },
    });
  assert.equal(
    (
      await req("/api/comments", {
        text: "bad",
        sha: f.sha,
        anchor: { kind: "file", path: "../escape" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req(
        "/api/comments",
        { text: "bad", sha: f.sha, anchor: { kind: "repo", path: "" } },
        "POST",
        { Origin: "https://other.invalid" },
      )
    ).status,
    403,
  );
  const a = await create("Split the function"),
    b = await create("Clarify semantics"),
    c = await create("Add coverage");
  assert.equal(a.status, "draft");
  let preview = await req("/api/runs/preview", {
    agent: "codex",
    commentIds: [a.id],
    brief: "Keep public behavior",
  });
  assert.ok(preview.task.includes("Split the function"));
  assert.equal(
    (
      await req("/api/runs/preview", {
        agent: "codex",
        commentIds: [a.id, a.id],
      })
    ).status,
    400,
  );
  const edited = await req(
    "/api/comments/" + a.id,
    { action: "edit", version: a.version, text: "Extract steps" },
    "PATCH",
  );
  assert.equal(
    (
      await req(
        "/api/comments/" + a.id,
        { action: "delete", version: a.version },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal((await req("/api/runs", { previewId: preview.id })).status, 400);
  preview = await req("/api/runs/preview", {
    agent: "codex",
    commentIds: [a.id, b.id, c.id],
  });
  await writeFile(path.join(f.dir, "advance.txt"), "advance");
  await f.git("add", ".");
  await f.git("commit", "-m", "Branch advanced");
  assert.equal((await req("/api/runs", { previewId: preview.id })).status, 400);
  preview = await req("/api/runs/preview", {
    agent: "codex",
    commentIds: [a.id, b.id, c.id],
  });
  assert.equal(preview.comments[0].text, edited.text);
  const original = (await f.git("rev-parse", "HEAD")).toString().trim();
  await writeFile(path.join(f.state, "hold"), "hold");
  const [start, duplicate] = await Promise.all([
    req("/api/runs", { previewId: preview.id }),
    req("/api/runs", { previewId: preview.id }),
  ]);
  assert.equal(start.id, duplicate.id);
  const active = await waitFor(async () => {
    const v = await req("/api/workflow");
    return (
      v.comments.find((c) => c.id === a.id && c.status === "addressed") && v
    );
  });
  let addressed = active.comments.find((c) => c.id === a.id);
  assert.equal(
    (
      await req(
        "/api/comments/" + a.id,
        { action: "verify", version: addressed.version, note: "Too early" },
        "PATCH",
      )
    ).status,
    400,
  );
  const another = await create("Later task");
  const next = await req("/api/runs/preview", {
    agent: "claude",
    commentIds: [another.id],
  });
  assert.equal((await req("/api/runs", { previewId: next.id })).status, 400);
  await rm(path.join(f.state, "hold"));
  const finished = await waitFor(async () => {
    const r = await req("/api/runs/" + preview.id);
    return ["completed", "failed"].includes(r.status) && r;
  });
  assert.equal(
    finished.status,
    "completed",
    finished.output || finished.message,
  );
  assert.ok(finished.output.includes("Fixture reporting checks passed"));
  assert.equal(finished.results.length, 1);
  let state = await req("/api/workflow");
  assert.equal(state.comments.find((x) => x.id === b.id).status, "flagged");
  assert.equal(state.comments.find((x) => x.id === c.id).status, "unreported");
  assert.ok(!JSON.stringify(state).includes("reportHash"));
  assert.equal((await f.git("rev-parse", "HEAD")).toString().trim(), original);
  assert.equal((await f.git("status", "--porcelain")).toString().trim(), "");
  assert.equal(
    (
      await req(
        "/api/comments/" + a.id,
        {
          action: "verify",
          version: addressed.version,
          note: "x".repeat(12001),
        },
        "PATCH",
      )
    ).status,
    400,
    "An oversized review note is rejected",
  );
  const verified = await req(
    "/api/comments/" + a.id,
    {
      action: "verify",
      version: addressed.version,
      note: "Reviewed the new file and reported checks.",
    },
    "PATCH",
  );
  assert.equal(verified.status, "verified");
  assert.equal(verified.verification.commit, addressed.report.commit);
  assert.equal((await req("/api/runs/" + preview.id)).applied, false);
  // Simulate the owner applying the reviewed branch outside Peekumi.
  await f.git("merge", "--ff-only", finished.branch);
  assert.equal((await req("/api/runs/" + preview.id)).applied, true);
  assert.equal(
    (await req("/api/workflow")).runs.find((r) => r.id === preview.id).applied,
    true,
  );

  const flagged = state.comments.find((x) => x.id === b.id);
  assert.equal(
    (
      await req(
        "/api/comments/" + b.id,
        { action: "reopen", version: flagged.version },
        "PATCH",
      )
    ).status,
    "draft",
  );
  await f.restart();
  state = await req("/api/workflow");
  assert.equal(state.comments.find((x) => x.id === a.id).status, "verified");
  assert.ok(
    state.comments
      .find((x) => x.id === b.id)
      .history.some((h) => h.status === "flagged"),
  );
});

test("cancelled runs stop the agent and leave unanswered comments reopenable", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.req("/api/comments", {
    text: "Waiting task",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "claude",
    brief: "WAIT_FOR_CANCEL",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "running";
  });
  await f.req(`/api/runs/${p.id}/cancel`, {});
  const ended = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "cancelled" && r;
  });
  assert.equal(ended.results.length, 0);
  const state = await f.req("/api/workflow");
  const pending = state.comments.find((x) => x.id === c.id);
  assert.equal(pending.status, "unreported");
  assert.equal(
    (
      await f.req(
        "/api/comments/" + c.id,
        { action: "reopen", version: pending.version },
        "PATCH",
      )
    ).status,
    "draft",
  );
});
test("requesting changes starts a next round that builds on the agent's own commits", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  const first = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "completed" && r;
  });
  const empty = await fetch(`${f.server.url}/api/runs/${p.id}/revise`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.server.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ feedback: "  " }),
  });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /Say what needs fixing/);
  // Instructions collected while exploring the agent's commit join the next round.
  const result1 = first.results.at(-1);
  const collected = await f.req("/api/comments", {
    text: "Name the round in the file too.",
    sha: result1,
    anchor: { kind: "file", path: "agent-result.txt" },
    forRun: p.id,
  });
  assert.equal(collected.forRun, p.id);
  const misuse = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [collected.id],
  });
  assert.match(misuse.error, /waiting to go back to its task/);
  const next = await f.req(`/api/runs/${p.id}/revise`, {
    feedback: "Also say which round made the change.",
  });
  assert.deepEqual(
    next.comments.map((x) => x.id),
    [collected.id],
    "The round's work is the collected change",
  );
  assert.deepEqual(
    next.done.map((x) => x.id),
    [c.id],
    "The instruction the agent already addressed travels along as finished work",
  );
  assert.match(
    next.task,
    /## Already done in an earlier round\n[^]*Do not report on them\.[^]*Write the result file\nReport: Implemented the requested fixture change\./,
  );
  assert.match(
    next.task,
    /"path":"agent-result.txt"[^\n]*\(left on [0-9a-f]{40}\)\nName the round in the file too\./,
  );
  assert.equal(next.round, 2);
  assert.equal(next.revises, p.id);
  assert.equal(next.agent, "codex");
  assert.notEqual(next.branch, first.branch);
  assert.equal(
    next.base,
    first.results.at(-1),
    "The next round starts from the agent's last commit",
  );
  assert.equal(
    next.reportHash,
    undefined,
    "The reporting credential never reaches the browser",
  );
  assert.match(
    next.task,
    /## Changes requested by the owner\nAlso say which round made the change\./,
  );
  assert.match(next.task, /build on it rather than starting over/);
  const second = await waitFor(async () => {
    const r = await f.req("/api/runs/" + next.id);
    return r.status === "completed" && r;
  });
  const result = second.results.at(-1);
  await f.git("merge-base", "--is-ancestor", first.results.at(-1), result);
  assert.match(
    (await f.git("show", `${result}:agent-result.txt`)).toString(),
    /completed this change\.\nRound 2 applied the requested changes\./,
  );
  const state = await f.req("/api/workflow");
  const moved = state.comments.find((x) => x.id === c.id);
  assert.equal(
    state.comments.find((x) => x.id === collected.id).forRun,
    undefined,
  );
  assert.equal(moved.runId, next.id);
  assert.equal(moved.status, "addressed");
  assert.ok(
    moved.history.some((h) => h.runId === p.id && h.status === "addressed"),
    "The first round's report stays in the instruction's history",
  );
  assert.equal(state.runs.find((r) => r.id === p.id).revisedBy, next.id);
  const late = await f.req("/api/comments", {
    text: "Too late for round one",
    sha: result1,
    anchor: { kind: "repo", path: "" },
    forRun: p.id,
  });
  assert.match(late.error, /already requested/);
  const again = await f.req(`/api/runs/${p.id}/revise`, {
    feedback: "Once more",
  });
  assert.equal(again.status, 400);
  assert.match(again.error, /already requested/);
  // The finished instruction keeps its report from round 1: it never shows "Needs retry",
  // and approving it verifies the commit that addressed it, which the latest branch contains.
  const verified = await f.req(
    "/api/comments/" + c.id,
    { action: "verify", version: moved.version },
    "PATCH",
  );
  assert.equal(verified.status, "verified");
  assert.equal(verified.verification.commit, result1);
  const addressed = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === collected.id,
  );
  assert.equal(addressed.status, "addressed");
  assert.equal(addressed.report.commit, result);
  await f.req(
    "/api/comments/" + collected.id,
    { action: "verify", version: addressed.version },
    "PATCH",
  );
  const done = await f.req(`/api/runs/${next.id}/revise`, { feedback: "More" });
  assert.match(done.error, /Nothing in this task is left to change/);
  assert.equal(
    (await f.git("rev-parse", "HEAD")).toString().trim(),
    f.sha,
    "The inspected checkout never moves",
  );
  // An approval can be undone while the work is not on main, and given again.
  let approved = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === c.id,
  );
  const reopened = await f.req(
    "/api/comments/" + c.id,
    { action: "unverify", version: approved.version },
    "PATCH",
  );
  assert.equal(reopened.status, "addressed");
  assert.ok(
    reopened.history.some((h) => h.status === "verified"),
    "The approval stays in the history",
  );
  approved = await f.req(
    "/api/comments/" + c.id,
    { action: "verify", version: reopened.version },
    "PATCH",
  );
  assert.equal(approved.status, "verified");
  // Once the owner merges the latest round, the task is a settled record.
  await f.git("merge", "--ff-only", next.branch);
  assert.equal((await f.req("/api/runs/" + next.id)).applied, true);
  const locked = [
    await f.req(
      "/api/comments/" + c.id,
      { action: "unverify", version: approved.version },
      "PATCH",
    ),
    await f.req(`/api/runs/${next.id}/revise`, { feedback: "Again" }),
    await f.req("/api/comments", {
      text: "More",
      sha: result,
      anchor: { kind: "repo", path: "" },
      forRun: next.id,
    }),
  ];
  for (const r of locked)
    assert.match(r.error, /applied to main; start a new task/);
});
test("a merge closes the task; instructions that the agent flagged become drafts again", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const anchor = { kind: "repo", path: "" };
  const a = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor,
  });
  const b = await f.req("/api/comments", {
    text: "Decide this later",
    sha: f.sha,
    anchor,
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [a.id, b.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  let state = await f.req("/api/workflow");
  assert.equal(state.comments.find((x) => x.id === b.id).status, "flagged");
  const done = state.comments.find((x) => x.id === a.id);
  await f.req(
    "/api/comments/" + a.id,
    { action: "verify", version: done.version },
    "PATCH",
  );
  const status = await f.req(`/api/runs/${p.id}/merge`);
  assert.equal(status.state, "ready");
  const merged = await f.req(`/api/runs/${p.id}/merge`, {
    target: status.targetSha,
    head: status.head,
  });
  assert.equal(merged.error, undefined, merged.error);
  state = await f.req("/api/workflow");
  const flagged = state.comments.find((x) => x.id === b.id);
  assert.equal(
    flagged.status,
    "draft",
    "The flagged instruction is open again",
  );
  assert.equal(flagged.runId ?? null, null);
  assert.equal(state.comments.find((x) => x.id === a.id).status, "verified");
  // Undo merge puts it back with the task, flagged, as it was.
  const undone = await f.req(`/api/runs/${p.id}/unmerge`, {});
  assert.equal(undone.error, undefined, undone.error);
  const back = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === b.id,
  );
  assert.equal(back.status, "flagged");
  assert.equal(back.runId, p.id);
  assert.equal(back.reopenedFrom, undefined);
});

test("an update round keeps a flagged instruction open and in view", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const anchor = { kind: "repo", path: "" };
  const a = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor,
  });
  const b = await f.req("/api/comments", {
    text: "Decide this later",
    sha: f.sha,
    anchor,
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [a.id, b.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  const done = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === a.id,
  );
  await f.req(
    "/api/comments/" + a.id,
    { action: "verify", version: done.version },
    "PATCH",
  );
  // main moves on with the same file, so the update is a round that resolves a conflict.
  await writeFile(path.join(f.dir, "agent-result.txt"), "main's own notes\n");
  await f.git("add", "agent-result.txt");
  await f.git("commit", "-m", "Main writes the file too");
  const update = await f.req(`/api/runs/${p.id}/update`, {});
  assert.equal(update.round.kind, "update");
  assert.deepEqual(
    update.round.open.map((c) => c.id),
    [b.id],
    "The flagged instruction goes with the round",
  );
  const flagged = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === b.id,
  );
  assert.equal(flagged.status, "flagged");
  assert.equal(flagged.runId, update.round.id);
});

test("an edit to a tracked file that a merge would overwrite blocks it, by its exact path", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  // The task's file is already tracked on main.
  await writeFile(path.join(f.dir, "agent-result.txt"), "Before the task.\n");
  await f.git("add", "agent-result.txt");
  await f.git("commit", "-m", "Track the result file");
  const sha = (await f.git("rev-parse", "HEAD")).toString().trim();
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  const comment = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === c.id,
  );
  await f.req(
    "/api/comments/" + c.id,
    { action: "verify", version: comment.version },
    "PATCH",
  );
  // The owner edits the tracked file, and does not commit it.
  await writeFile(path.join(f.dir, "agent-result.txt"), "The owner's edit.\n");
  const status = await f.req(`/api/runs/${p.id}/merge`);
  assert.equal(status.state, "blocked");
  assert.deepEqual(status.blocking, ["agent-result.txt"]);
});

test("an approved task merges on the owner's action, never over uncommitted work, and can be undone", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const out = async (...a) => (await f.git(...a)).toString().trim();
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  const merge = (id = p.id) => f.req(`/api/runs/${id}/merge`);
  assert.equal(
    (await merge()).state,
    "waiting",
    "An unapproved task cannot merge",
  );
  let comment = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === c.id,
  );
  await f.req(
    "/api/comments/" + c.id,
    { action: "verify", version: comment.version },
    "PATCH",
  );
  let status = await merge();
  assert.equal(status.state, "ready");
  assert.equal(status.target, "main");
  assert.equal(status.checkedOut, true);
  assert.equal(status.commits, 1);
  assert.deepEqual(
    status.files.map((x) => x.path),
    ["agent-result.txt"],
  );
  // The owner's uncommitted file in the way blocks the merge; an unrelated one does not.
  await writeFile(
    path.join(f.dir, "agent-result.txt"),
    "The owner's own notes.\n",
  );
  await writeFile(
    path.join(f.dir, "module.py"),
    '"""Fixture module."""\ndef run():\n    return 2\n',
  );
  status = await merge();
  assert.equal(status.state, "blocked");
  assert.deepEqual(status.blocking, ["agent-result.txt"]);
  assert.equal(status.uncommitted, 2);
  const refused = await f.req(`/api/runs/${p.id}/merge`, {
    target: status.targetSha,
    head: status.head,
  });
  assert.match(refused.error, /Uncommitted files are in the way/);
  // An agent drafts the commit of exactly those files; Peekumi commits only what the owner saw.
  const draft = await f.req(`/api/runs/${p.id}/commit-draft`, {});
  assert.equal(draft.message, "Record the owner's own result notes");
  assert.equal(draft.agent, true);
  assert.deepEqual(
    draft.files.map((x) => [x.path, x.new]),
    [["agent-result.txt", true]],
  );
  const stale = await f.req(`/api/runs/${p.id}/commit-mine`, {
    ...draft,
    hash: "0".repeat(64),
  });
  assert.match(stale.error, /Your changes changed/);
  const mine = await f.req(`/api/runs/${p.id}/commit-mine`, {
    ...draft,
    message: "Keep my result notes",
  });
  assert.equal(mine.status.state, "behind");
  assert.equal(await out("log", "-1", "--format=%s"), "Keep my result notes");
  assert.equal(
    await out("show", "--name-only", "--format=", "HEAD"),
    "agent-result.txt",
  );
  assert.equal(
    await out("status", "--porcelain"),
    "M module.py",
    "Other uncommitted work stays uncommitted",
  );
  // Both sides added the file, so the update is a new round where the agent resolves it.
  const update = await f.req(`/api/runs/${p.id}/update`, {});
  assert.equal(update.round.kind, "update");
  assert.deepEqual(update.round.conflicts, ["agent-result.txt"]);
  assert.equal(update.round.reportHash, undefined);
  const round = await waitFor(async () => {
    const r = await f.req("/api/runs/" + update.round.id);
    return r.status === "completed" && r;
  });
  comment = (await f.req("/api/workflow")).comments.find((x) => x.id === c.id);
  assert.equal(
    comment.status,
    "addressed",
    "The merged result needs a new approval",
  );
  assert.equal(comment.runId, round.id);
  assert.match(
    await out("show", `${round.branch}:agent-result.txt`),
    /deterministic agent[^]*owner's own notes/,
  );
  assert.equal((await merge(round.id)).state, "waiting");
  await f.req(
    "/api/comments/" + c.id,
    { action: "verify", version: comment.version },
    "PATCH",
  );
  assert.equal(
    (await merge(p.id)).state,
    "waiting",
    "Only the latest round merges",
  );
  status = await merge(round.id);
  assert.equal(status.state, "ready");
  const moved = await f.req(`/api/runs/${round.id}/merge`, {
    target: f.sha,
    head: status.head,
  });
  assert.match(moved.error, /changed; check the merge again/);
  const before = await out("rev-parse", "main");
  const merged = await f.req(`/api/runs/${round.id}/merge`, {
    target: status.targetSha,
    head: status.head,
  });
  assert.equal(merged.state, "merged");
  assert.equal(merged.undoable, true);
  assert.equal(await out("rev-parse", "main"), status.head);
  assert.equal(
    await out("branch", "--show-current"),
    "main",
    "The checkout stays on its branch",
  );
  assert.equal(
    await out("status", "--porcelain"),
    "M module.py",
    "Uncommitted work survives the merge",
  );
  assert.equal((await f.req("/api/runs/" + round.id)).applied, true);
  // Undo moves main back and keeps uncommitted work.
  const undone = await f.req(`/api/runs/${round.id}/unmerge`, {});
  assert.equal(undone.state, "ready");
  assert.equal(await out("rev-parse", "main"), before);
  assert.equal(await out("status", "--porcelain"), "M module.py");
  // A clean update keeps the approval: main moves on in a file the task does not touch.
  await f.git("commit", "-qam", "Main moves on");
  status = await merge(round.id);
  assert.equal(status.state, "behind");
  const clean = await f.req(`/api/runs/${round.id}/update`, {});
  assert.equal(clean.merged.state, "ready");
  assert.match(
    await out(
      "log",
      "-1",
      "--format=%s",
      status.head === clean.merged.head ? "HEAD" : clean.merged.head,
    ),
    /Merge main into peekumi\/run-/,
  );
  // With main not checked out, the merge moves only the branch, never the working files.
  await f.git("checkout", "-q", "--detach");
  const detached = await merge(round.id);
  assert.equal(detached.checkedOut, false);
  const done = await f.req(`/api/runs/${round.id}/merge`, {
    target: detached.targetSha,
    head: detached.head,
  });
  assert.equal(done.state, "merged");
  assert.equal(await out("rev-parse", "main"), detached.head);
  assert.equal(
    await out("rev-parse", "HEAD"),
    detached.targetSha,
    "The detached checkout does not move",
  );
});

test("agents come from the server, and each task runs with the model and effort it started with", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const agents = await f.req("/api/agents");
  assert.deepEqual(
    agents.agents.map((a) => [a.id, a.jobs]),
    [
      ["claude", ["ask", "task"]],
      ["codex", ["task"]],
      ["openrouter", ["ask", "task"]],
    ],
  );
  // Each provider names its own models and their efforts; nothing is listed in Peekumi.
  const claude = agents.agents.find((a) => a.id === "claude"),
    codexInfo = agents.agents.find((a) => a.id === "codex");
  assert.deepEqual(
    claude.models.task.map((m) => [m.id, m.label, m.efforts.join()]),
    [
      ["sonnet", "Sonnet", "low,medium,high,max"],
      ["opus", "Opus", "low,medium,high,max"],
    ],
  );
  assert.deepEqual(
    codexInfo.models.task.map((m) => [
      m.id,
      m.label,
      m.efforts.join(),
      m.defaultEffort,
    ]),
    [
      ["fixture-large", "Fixture Large", "low,high,xhigh", "high"],
      ["fixture-small", "Fixture Small", "low,medium", "low"],
    ],
  );
  assert.deepEqual([claude.source, codexInfo.source], ["agent", "agent"]);
  assert.equal(claude.status.ready && codexInfo.status.ready, true);
  assert.deepEqual(agents.defaults.ask, {
    agent: "claude",
    model: "sonnet",
    effort: "low",
  });
  assert.deepEqual(agents.defaults.task, {
    agent: "codex",
    model: null,
    effort: "auto",
  });
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  // A choice from the device is checked before it is used.
  for (const [using, error] of [
    [{ agent: "claude", model: "--dangerous", effort: "high" }, /model name/],
    [{ agent: "claude", model: "opus", effort: "max --x" }, /Unknown effort/],
    [{ agent: "nobody" }, /Unknown agent/],
  ])
    assert.match(
      (await f.req("/api/runs/preview", { commentIds: [c.id], using })).error,
      error,
    );
  const asked = await f.req("/api/ask", {
    base: f.sha,
    head: f.sha,
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    question: "Hi",
    using: { agent: "codex" },
  });
  assert.match(asked.error, /Codex cannot do this job/);
  const p = await f.req("/api/runs/preview", {
    commentIds: [c.id],
    using: { agent: "claude", model: "opus", effort: "high" },
  });
  assert.deepEqual([p.agent, p.model, p.effort], ["claude", "opus", "high"]);
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  const argv = JSON.parse(
    await readFile(path.join(f.state, "agent-argv.json"), "utf8"),
  );
  assert.deepEqual(
    argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4),
    ["--model", "opus", "--effort", "high"],
  );
  // A later round keeps the task's agent, model and effort.
  const first = await f.req("/api/runs/" + p.id);
  await f.req("/api/comments", {
    text: "Once more",
    sha: first.results.at(-1),
    anchor: { kind: "repo", path: "" },
    forRun: p.id,
  });
  const next = await f.req(`/api/runs/${p.id}/revise`, { feedback: "Again" });
  assert.deepEqual(
    [next.agent, next.model, next.effort],
    ["claude", "opus", "high"],
  );
  await waitFor(
    async () => (await f.req("/api/runs/" + next.id)).status === "completed",
  );
  // Codex gets its model and reasoning effort as its own options; auto passes none.
  const d = await f.req("/api/comments", {
    text: "Another",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const q = await f.req("/api/runs/preview", {
    commentIds: [d.id],
    using: { agent: "codex", model: "a-model", effort: "medium" },
  });
  await f.req("/api/runs", { previewId: q.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + q.id)).status === "completed",
  );
  const codex = JSON.parse(
    await readFile(path.join(f.state, "agent-argv.json"), "utf8"),
  );
  assert.ok(
    codex.includes("a-model") &&
      codex.includes('model_reasoning_effort="medium"'),
    codex.join(" "),
  );
});

test("OpenRouter answers Ask with Peekumi's lookups, and its key stays on the server", async (t) => {
  const { createServer } = await import("node:http");
  const KEY = "sk-or-test-1234567890"; // gitleaks:allow (a fake test key)
  const seen = [];
  // A small stand-in for the OpenRouter API: models, key check, and streamed chat answers.
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    seen.push({ path: req.url, auth: req.headers.authorization, json });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/v1/models")
      return send(200, {
        data: [
          {
            id: "vendor/tool-model",
            name: "Tool Model",
            context_length: 128000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
            supported_parameters: ["tools", "reasoning"],
          },
          {
            id: "vendor/no-tools",
            name: "No Tools",
            supported_parameters: ["temperature"],
          },
        ],
      });
    if (
      req.authorization !== undefined ||
      req.headers.authorization !== `Bearer ${KEY}`
    )
      return send(401, { error: { message: "No auth credentials found" } });
    if (req.url === "/api/v1/key")
      return send(200, { data: { label: "test" } });
    // A task: the model works through Peekumi's tools, one step for each request.
    if (req.url === "/api/v1/chat/completions" && !json.stream && json.tools) {
      const step = json.messages.filter((m) => m.role === "assistant").length;
      const comment = /\[(c[0-9a-f]+)\]/.exec(json.messages[1].content)[1];
      const results = json.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content);
      const call = (name, args) => ({
        id: `call-${step}-${name}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      const steps = [
        [call("list_files", {})],
        [
          call("write_file", { path: "../escape.txt", content: "no" }),
          call("write_file", { path: ".git/hooks/pre-commit", content: "no" }),
          call("write_file", {
            path: "agent-result.txt",
            content: "Written by an OpenRouter model.\n",
          }),
        ],
        [
          call("commit", {
            message: "Write the result file",
            comment_ids: [comment],
          }),
        ],
        [
          call("resolve_comment", {
            comment_id: comment,
            commit_sha: results.at(-1),
            note: "Wrote the file.",
            checks: "Read the file back. No command can run.",
          }),
        ],
      ];
      return send(200, {
        choices: [
          {
            message:
              step < steps.length
                ? {
                    content: step ? null : "I will look at the files first.",
                    tool_calls: steps[step],
                  }
                : { content: "Done: the result file exists." },
          },
        ],
      });
    }
    if (req.url === "/api/v1/chat/completions" && !json.stream)
      return send(200, {
        choices: [{ message: { content: "Record notes from OpenRouter" } }],
      });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (delta) =>
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    if (!json.messages.some((m) => m.role === "tool")) {
      event({
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            function: { name: "find_declarations", arguments: '{"que' },
          },
        ],
      });
      event({
        tool_calls: [{ index: 0, function: { arguments: 'ry":"run"}' } }],
      });
    } else
      for (const piece of ["`run` is defined ", "in `module.py`."])
        event({ content: piece });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((done) => api.listen(0, "127.0.0.1", done));
  t.after(() => api.close());
  const f = await fixture({
    env: {
      PEEKUMI_OPENROUTER_URL: `http://127.0.0.1:${api.address().port}/api/v1`,
    },
  });
  t.after(() => f.close());
  let agents = await f.req("/api/agents");
  let router = agents.agents.find((a) => a.id === "openrouter");
  assert.deepEqual(
    [router.jobs, router.defaultModel, router.status.ready, router.key.set],
    [["ask", "task"], false, false, false],
  );
  assert.match(router.notes.task, /Peekumi runs the model itself/);
  assert.deepEqual(
    router.models.ask.map((m) => [m.id, m.label, m.note, m.efforts.join()]),
    [
      [
        "vendor/tool-model",
        "Tool Model",
        "128K context · $1.00 in / $2.00 out per million tokens",
        "low,medium,high",
      ],
    ],
    "Only models that can use tools",
  );
  // A key is tested before it is saved, and only its end ever leaves the server.
  assert.match(
    (
      await f.req(
        "/api/agents/openrouter-key",
        { key: "wrong-key-0000000" },
        "PUT",
      )
    ).error,
    /did not accept this key/,
  );
  const saved = await f.req("/api/agents/openrouter-key", { key: KEY }, "PUT");
  router = saved.agents.find((a) => a.id === "openrouter");
  assert.deepEqual(
    [router.status.ready, router.key],
    [true, { set: true, end: "7890", fromEnvironment: false }],
  );
  assert.ok(!JSON.stringify(saved).includes(KEY));
  const { stat } = await import("node:fs/promises");
  assert.equal(
    (await stat(path.join(f.state, "openrouter-key"))).mode & 0o777,
    0o600,
  );
  // Ask: the model asks for a lookup, Peekumi runs it, and the model answers with it.
  const question = {
    base: f.sha,
    head: f.sha,
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    question: "Where is run?",
  };
  const answer = await f.req("/api/ask", {
    ...question,
    using: { agent: "openrouter", model: "vendor/tool-model", effort: "high" },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.match(answer.answer.text, /`run` is defined in `module.py`\./);
  assert.deepEqual(answer.lookups, ["Searched for “run”"]);
  assert.equal(answer.provider, "OpenRouter · vendor/tool-model");
  const chats = seen.filter((s) => s.path === "/api/v1/chat/completions");
  assert.equal(chats.length, 2);
  assert.deepEqual(
    [
      chats[0].json.model,
      chats[0].json.reasoning,
      chats[0].json.tools.map((x) => x.function.name).includes("read_file"),
    ],
    ["vendor/tool-model", { effort: "high" }, true],
  );
  assert.match(chats[0].json.messages[0].content, /ASD-STE100/);
  const tool = chats[1].json.messages.find((m) => m.role === "tool");
  assert.match(
    tool.content,
    /module\.py/,
    "The lookup result goes back to the model",
  );
  assert.match(
    (await f.req("/api/ask", { ...question, using: { agent: "openrouter" } }))
      .error,
    /Choose a model for OpenRouter/,
  );
  // A task runs in Peekumi's own agent: no other program, tools only inside the worktree.
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  assert.match(
    (
      await f.req("/api/runs/preview", {
        commentIds: [c.id],
        using: { agent: "openrouter" },
      })
    ).error,
    /Choose a model for OpenRouter/,
  );
  const p = await f.req("/api/runs/preview", {
    commentIds: [c.id],
    using: { agent: "openrouter", model: "vendor/tool-model", effort: "high" },
  });
  assert.deepEqual(
    [p.agent, p.model, p.effort],
    ["openrouter", "vendor/tool-model", "high"],
  );
  await f.req("/api/runs", { previewId: p.id });
  const run = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "completed" && r;
  });
  assert.equal(run.results.length, 1, run.message);
  const result = run.results[0];
  assert.equal(
    (await f.git("show", `${result}:agent-result.txt`)).toString(),
    "Written by an OpenRouter model.\n",
  );
  assert.match(
    (await f.git("show", "-s", "--format=%B", result)).toString(),
    new RegExp(
      `Peekumi-Run: ${p.id}\nPeekumi-Comment: ${c.id}\nPeekumi-Agent: openrouter`,
    ),
  );
  const reported = (await f.req("/api/workflow")).comments.find(
    (x) => x.id === c.id,
  );
  assert.deepEqual(
    [reported.status, reported.report.commit, reported.report.agent],
    ["addressed", result, "openrouter"],
  );
  const taskChats = seen.filter(
    (x) =>
      x.path === "/api/v1/chat/completions" && x.json.tools && !x.json.stream,
  );
  assert.deepEqual(
    [taskChats[0].json.model, taskChats[0].json.reasoning],
    ["vendor/tool-model", { effort: "high" }],
  );
  assert.ok(
    !taskChats[0].json.tools.some((x) =>
      /run|shell|command/.test(x.function.name),
    ),
    "No tool runs commands",
  );
  const refused = taskChats[2].json.messages
    .filter((m) => m.role === "tool")
    .slice(-3)
    .map((m) => m.content);
  assert.match(refused[0], /^Error: Use a path inside the repository/);
  assert.match(refused[1], /^Error: The \.git folder is not allowed/);
  const { access } = await import("node:fs/promises");
  await assert.rejects(
    access(path.join(f.dir, "..", "escape.txt")),
    "Nothing is written outside the worktree",
  );
  assert.match(
    run.output,
    /"agent_message","text":"I will look at the files first\."/,
  );
  assert.match(run.output, /"file_change"/);
  // Each step goes to the log after its result: a refused write shows as failed.
  const changes = run.output
    .split("\n")
    .filter((l) => l.includes('"file_change"'))
    .map((l) => JSON.parse(l).item);
  assert.deepEqual(
    changes.map((c) => [c.path, c.status]),
    [
      ["../escape.txt", "failed"],
      [".git/hooks/pre-commit", "failed"],
      ["agent-result.txt", "completed"],
    ],
  );
  const removed = await f.req("/api/agents/openrouter-key", {}, "DELETE");
  assert.equal(
    removed.agents.find((a) => a.id === "openrouter").key.set,
    false,
  );
});

test("each task gets the code graph of its start commit, for as long as it runs", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const agent of ["claude", "codex"]) {
    const c = await f.req("/api/comments", {
      text: `Graph for ${agent}`,
      sha: f.sha,
      anchor: { kind: "repo", path: "" },
    });
    const p = await f.req("/api/runs/preview", {
      commentIds: [c.id],
      using: { agent },
    });
    assert.equal(p.graph, true);
    assert.match(
      p.task,
      /## Repository map\n[^]*```\n[^]*module\.py: run\n[^]*```/,
    );
    assert.match(p.task, /## Code graph tools\n[^]*highlight[^]*route/);
    await f.req("/api/runs", { previewId: p.id });
    await waitFor(
      async () => (await f.req("/api/runs/" + p.id)).status === "completed",
    );
    const used = JSON.parse(
      await readFile(path.join(f.state, "agent-graph.json"), "utf8"),
    );
    assert.equal(used.error, false, `${agent}: ${used.text}`);
    assert.match(
      used.text,
      /"name":"run"[^]*module\.py|module\.py[^]*"name":"run"/,
      `${agent} found run() through the graph`,
    );
    // The grant ends with the run.
    const after = await (
      await fetch(used.url, {
        method: "POST",
        headers: {
          Authorization: used.auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "find_declarations", arguments: { query: "run" } },
        }),
      })
    ).status;
    assert.equal(
      after,
      401,
      `${agent}: the graph grant closes when the run ends`,
    );
  }
});

test("a task starts from a names-only map of the repository, and the graph tools open its parts", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.req("/api/comments", {
    text: "Make `run` return 2.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    commentIds: [c.id],
    using: { agent: "codex" },
  });
  const map = p.task.slice(
    p.task.indexOf("## Repository map"),
    p.task.indexOf("## Code graph tools"),
  );
  assert.match(map, /names only, no code/);
  assert.match(map, /\.\/\n  module\.py: run\n/);
  assert.ok(!map.includes("return 1"), "No code in the map");
});

test("a session continues one conversation over turns, asks before commands, and ends in the normal review", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = await f.req("/api/runs/session", {
    text: "Make the change.\nRUN: npm install left-pad",
    sha: f.sha,
    anchor: { kind: "file", path: "module.py" },
    using: { agent: "claude" },
  });
  assert.equal(session.status, "running", session.error);
  assert.equal(session.kind, "session");
  assert.match(session.branch, /^peekumi\/session-/);
  const get = () => f.req("/api/runs/" + session.id);
  const waiting = (turns) =>
    waitFor(async () => {
      const r = await get();
      return r.status === "waiting" && r.turns === turns && r;
    });
  // A command outside the list waits for the owner; "allow in this session" adds a rule.
  const asked = await waitFor(async () => (await get()).approval);
  assert.equal(asked.tool, "Bash");
  assert.equal(asked.input, "npm install left-pad");
  assert.equal(asked.reason, "Fixture command");
  assert.equal(
    (
      await f.req(`/api/runs/${session.id}/approval`, {
        approval: asked.id,
        decision: "session",
      })
    ).ok,
    true,
  );
  let run = await waiting(1);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(f.state, "session-approval-1.json"), "utf8"),
    ).behavior,
    "allow",
  );
  assert.deepEqual(run.allow, ["Bash(npm install:*)"]);
  assert.equal(run.results.length, 1);
  assert.equal(run.summary, "Turn 1 is done.");
  assert.match(run.output, /"type":"peekumi.owner","turn":1/);
  const first = JSON.parse(
    await readFile(path.join(f.state, "session-turn-1.json"), "utf8"),
  );
  assert.match(first.task, /# Session with the owner/);
  assert.match(first.task, /## The owner's first message\nMake the change\./);
  assert.match(first.task, /## Repository map/);
  // The next turn resumes the conversation; the session rule answers without asking.
  const sent = await f.req(`/api/runs/${session.id}/message`, {
    text: "Again.\nRUN: npm install other",
    anchors: [{ kind: "symbol", path: "module.py", symbol: "run" }],
  });
  assert.equal(sent.queued, false);
  run = await waiting(2);
  const second = JSON.parse(
    await readFile(path.join(f.state, "session-turn-2.json"), "utf8"),
  );
  assert.equal(
    second.task,
    "The owner's message:\nAgain.\nRUN: npm install other\n(About: module.py · run)\n",
  );
  // Peekumi alone judges commands: no command rule goes to Claude Code, and the session rule
  // answers through the approve tool without asking.
  assert.ok(
    !second.values.join(" ").includes("Bash("),
    "No command rule goes to Claude Code",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.state, "session-approval-2.json"), "utf8"),
    ).behavior,
    "allow",
  );
  // A denied command reaches the agent with the owner's reason.
  await f.req(`/api/runs/${session.id}/message`, { text: "RUN: rm -rf build" });
  const denied = await waitFor(async () => (await get()).approval);
  assert.equal(
    (
      await f.req(`/api/runs/${session.id}/approval`, {
        approval: denied.id,
        decision: "deny",
        message: "Not now",
      })
    ).ok,
    true,
  );
  run = await waiting(3);
  assert.match(
    JSON.parse(
      await readFile(path.join(f.state, "session-approval-3.json"), "utf8"),
    ).message,
    /The owner denied this: Not now/,
  );
  // A command with several parts cannot get a session rule; "allow all" answers it.
  await f.req(`/api/runs/${session.id}/message`, {
    text: "RUN: ls; (cargo test 2>&1 | tail -15)",
  });
  const chained = await waitFor(async () => (await get()).approval);
  assert.match(
    (
      await f.req(`/api/runs/${session.id}/approval`, {
        approval: chained.id,
        decision: "session",
      })
    ).error,
    /No rule for this command is safe/,
  );
  assert.equal(
    (
      await f.req(`/api/runs/${session.id}/approval`, {
        approval: chained.id,
        decision: "all",
      })
    ).ok,
    true,
  );
  run = await waiting(4);
  assert.equal(run.permissions, "allow");
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.state, "session-approval-4.json"), "utf8"),
    ).behavior,
    "allow",
  );
  // From now on nothing waits: the next turn allows every command.
  await f.req(`/api/runs/${session.id}/message`, { text: "RUN: rm -rf build" });
  run = await waiting(5);
  assert.equal(run.approval, null);
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.state, "session-approval-5.json"), "utf8"),
    ).behavior,
    "allow",
  );
  const fifth = JSON.parse(
    await readFile(path.join(f.state, "session-turn-5.json"), "utf8"),
  ).values;
  assert.equal(fifth[fifth.indexOf("--permission-mode") + 1], "acceptEdits");
  // The owner can ask again; the end of the log is small.
  assert.equal(
    (await f.req(`/api/runs/${session.id}/permissions`, { mode: "ask" }))
      .permissions,
    "ask",
  );
  const tail = await f.req(`/api/runs/${session.id}/tail`);
  assert.match(tail.output, /Turn 5 is done\./);
  assert.ok(tail.output.length <= 16 * 1024 && !tail.reportHash);
  // Ending with review reports the session's instruction with the branch's last commit.
  const ended = await f.req(`/api/runs/${session.id}/end`, { review: true });
  assert.equal(ended.ok, true, ended.error);
  const state = await f.req("/api/workflow");
  const done = state.runs.find((r) => r.id === session.id);
  assert.equal(done.status, "completed");
  assert.equal(done.results.length, 5);
  const comment = state.comments.find((c) => c.runId === session.id);
  assert.equal(comment.status, "addressed");
  assert.equal(comment.report.commit, done.results[4]);
  assert.equal(comment.report.note, "Turn 5 is done.");
  // From here it is a normal task: the owner approves it.
  const approved = await f.req(
    "/api/comments/" + comment.id,
    { action: "verify", version: comment.version },
    "PATCH",
  );
  assert.equal(approved.status, "verified", approved.error);
  assert.equal(
    (await f.req(`/api/runs/${session.id}/message`, { text: "More" })).error,
    "This session has ended",
  );
});

test("a Codex session resumes its thread, can stop a turn, and can end without review", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = await f.req("/api/runs/session", {
    text: "Look around.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    using: { agent: "codex" },
    permissions: "allow",
  });
  assert.equal(session.status, "running", session.error);
  assert.equal(session.permissions, "allow");
  const get = () => f.req("/api/runs/" + session.id);
  let run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r;
  });
  assert.equal(run.conversation, "thread-fixture");
  // A task cannot start while a session turn runs, and a session message waits for a task.
  await f.req(`/api/runs/${session.id}/message`, {
    text: "Keep going. WAIT_FOR_STOP",
  });
  await waitFor(async () => (await get()).pid);
  assert.match(
    (
      await f.req("/api/runs/session", {
        text: "Another",
        sha: f.sha,
        anchor: { kind: "repo", path: "" },
        using: { agent: "codex" },
      })
    ).error,
    /An agent is working now/,
  );
  const queued = await f.req(`/api/runs/${session.id}/message`, {
    text: "And this after.",
  });
  assert.equal(queued.queued, true);
  assert.equal(
    (await f.req(`/api/runs/${session.id}/end`, { review: false })).error,
    "Stop the agent first, or wait for its turn to end",
  );
  await f.req(`/api/runs/${session.id}/cancel`, {});
  // Stop stops: the waiting message does not start a turn. It goes with the next message,
  // in a turn that resumes the thread.
  run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r.turns === 2 && !r.pid && r;
  });
  assert.match(
    run.output,
    /"type":"peekumi.turn","turn":2,"status":"cancelled"/,
  );
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await get()).turns, 2, "Stop does not start the next turn");
  await f.req(`/api/runs/${session.id}/message`, { text: "Now go on." });
  run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r.turns === 3 && r;
  });
  const third = JSON.parse(
    await readFile(path.join(f.state, "session-turn-3.json"), "utf8"),
  );
  assert.ok(third.values.includes("resume"));
  assert.match(third.task, /And this after\.[\s\S]*Now go on\./);
  const ended = await f.req(`/api/runs/${session.id}/end`, { review: false });
  assert.equal(ended.ok, true, ended.error);
  const state = await f.req("/api/workflow");
  assert.equal(state.runs.find((r) => r.id === session.id).status, "cancelled");
  assert.equal(
    state.comments.find((c) => c.runId === session.id).status,
    "unreported",
  );
});

test("a session message waits while a task holds the repository, then starts its turn", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = await f.req("/api/runs/session", {
    text: "Look around.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    using: { agent: "codex" },
  });
  const get = () => f.req("/api/runs/" + session.id);
  await waitFor(async () => (await get()).status === "waiting");
  const c = await f.req("/api/comments", {
    text: "Waiting task",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "claude",
    brief: "WAIT_FOR_CANCEL",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "running",
  );
  // The reply is kept, not refused, and waits for the task.
  const sent = await f.req(`/api/runs/${session.id}/message`, {
    text: "After the task.",
  });
  assert.equal(sent.ok, true, sent.error);
  assert.equal(sent.queued, true);
  const waiting = await get();
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.message, /waits until the other agent finishes/);
  // When the task ends, the turn starts by itself.
  await f.req(`/api/runs/${p.id}/cancel`, {});
  const run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r.turns === 2 && r;
  });
  const second = JSON.parse(
    await readFile(path.join(f.state, "session-turn-2.json"), "utf8"),
  );
  assert.match(second.task, /After the task\./);
  assert.equal(run.waitsForRepository ?? null, null);
});

test("an OpenRouter session keeps its conversation between turns and commits with only a message", async (t) => {
  const { createServer } = await import("node:http");
  const KEY = "sk-or-test-session-1234"; // gitleaks:allow (a fake test key)
  const chats = [];
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const send = (value) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/v1/models")
      return send({
        data: [
          {
            id: "vendor/tool-model",
            name: "Tool Model",
            supported_parameters: ["tools"],
          },
        ],
      });
    if (req.url === "/api/v1/key") return send({ data: {} });
    chats.push(json);
    const owner = json.messages.filter((m) => m.role === "user").length;
    const last = json.messages.at(-1);
    const call = (name, args) => ({
      id: `call-${chats.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    // Turn 1 writes and commits; turn 2 only answers.
    if (owner === 1 && last.role === "user")
      return send({
        choices: [
          {
            message: {
              content: "I will write it.",
              tool_calls: [
                call("write_file", {
                  path: "notes.txt",
                  content: "From the session.\n",
                }),
              ],
            },
          },
        ],
      });
    if (owner === 1 && last.content === "Written.")
      return send({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [call("commit", { message: "Add notes" })],
            },
          },
        ],
      });
    return send({
      choices: [
        {
          message: {
            content:
              owner === 1
                ? "Committed the notes."
                : "The notes file has one line.",
          },
        },
      ],
    });
  });
  await new Promise((done) => api.listen(0, "127.0.0.1", done));
  t.after(() => api.close());
  const f = await fixture({
    env: {
      PEEKUMI_OPENROUTER_URL: `http://127.0.0.1:${api.address().port}/api/v1`,
    },
  });
  t.after(() => f.close());
  await f.req("/api/agents/openrouter-key", { key: KEY }, "PUT");
  const session = await f.req("/api/runs/session", {
    text: "Write notes.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    using: { agent: "openrouter", model: "vendor/tool-model" },
  });
  assert.equal(session.status, "running", session.error);
  const get = () => f.req("/api/runs/" + session.id);
  let run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r;
  });
  assert.equal(run.results.length, 1, run.message);
  assert.equal(
    (await f.git("show", "-s", "--format=%B", run.results[0]))
      .toString()
      .trimEnd(),
    `Add notes\n\nPeekumi-Run: ${session.id}\nPeekumi-Agent: openrouter`,
  );
  assert.equal(run.summary, "Committed the notes.");
  const offered = chats[0].tools.map((x) => x.function.name);
  assert.ok(
    !offered.some(
      (n) =>
        ["resolve_comment", "flag_comment", "finish"].includes(n) ||
        /run|shell|command/.test(n),
    ),
    offered.join(),
  );
  await f.req(`/api/runs/${session.id}/message`, { text: "How long is it?" });
  run = await waitFor(async () => {
    const r = await get();
    return r.status === "waiting" && r.turns === 2 && r;
  });
  // The second turn sends the whole conversation: the first turn's steps, then the new message.
  const second = chats.at(-1).messages;
  assert.deepEqual(
    second.map((m) => m.role),
    [
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "user",
    ],
  );
  assert.equal(
    second.at(-1).content,
    "The owner's message:\nHow long is it?\n",
  );
  assert.equal(run.summary, "The notes file has one line.");
});

test("failed executable launches produce a failed run, never leave comments with an agent", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await rm(path.join(f.state, "agent"));
  const c = await f.req("/api/comments", {
    text: "Task",
    sha: f.sha,
    anchor: { kind: "file", path: "module.py" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  const ended = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "failed" && r;
  });
  assert.match(ended.message, /Cannot launch agent/);
  assert.equal((await f.req("/api/workflow")).comments[0].status, "unreported");
});

test("restart retains reports and blocks dispatch until the interrupted agent exits", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(path.join(f.state, "hold"), "hold");
  const c = await f.req("/api/comments", {
    text: "Recover this run",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(async () => {
    const run = await f.req("/api/runs/" + p.id);
    assert.notEqual(run.status, "failed", run.output || run.message);
    return (await f.req("/api/workflow")).comments[0].status === "addressed";
  });
  await f.restart();
  assert.equal((await f.req("/api/runs/" + p.id)).status, "interrupted");
  const other = await f.req("/api/comments", {
    text: "Wait for recovery",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const next = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [other.id],
  });
  assert.equal((await f.req("/api/runs", { previewId: next.id })).status, 400);
  await rm(path.join(f.state, "hold"));
  const ended = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "failed" && r;
  });
  assert.equal(ended.results.length, 1);
  assert.equal((await f.req("/api/workflow")).comments[0].status, "addressed");
});

test("Ask receives committed context without tools and never automatically creates a draft or run", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const result = await f.req("/api/ask", {
    base: f.sha,
    head: f.sha,
    sha: f.sha,
    anchor: { kind: "symbol", path: "module.py", symbol: "run" },
    question: "What does this do?",
    history: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.match(result.answer.text, /not run tests/);
  assert.equal(
    result.answer.suggestion,
    "Add a focused regression test for this behavior.",
  );
  assert.equal(result.context.head, f.sha);
  const state = await f.req("/api/workflow");
  assert.equal(state.comments.length, 0);
  assert.equal(state.runs.length, 0);
  assert.equal(
    (
      await f.req("/api/ask", {
        base: f.sha,
        head: f.sha,
        sha: f.sha,
        question: "test",
        anchor: { kind: "file", path: "../escape" },
      })
    ).status,
    400,
  );
});

test("Ask sees the committed dependency rules at the compared head", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const rules = '{"version":1,"groups":{"all":["**"]},"rules":[]}';
  await writeFile(path.join(f.dir, ".peekumi.json"), rules);
  await f.git("add", ".peekumi.json");
  await f.git("commit", "-m", "Add rules");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const result = await f.req("/api/ask", {
    base: f.sha,
    head,
    sha: head,
    anchor: { kind: "repo", path: "" },
    question: "Echo the rules.",
    history: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(JSON.parse(result.answer.text), rules);
});

test("Ask checks what a draft left unchecked before it replies", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const ask = (question, stream = false) =>
    fetch(f.server.url + "/api/ask", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.server.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base: f.sha,
        head: f.sha,
        sha: f.sha,
        anchor: { kind: "file", path: "module.py" },
        question,
        history: [],
        stream,
      }),
    });
  const whole = await (await ask("Leave something unchecked.")).json();
  assert.equal(
    whole.answer.text,
    "Checked after: The function moved. I did not check the tests.",
    "A draft that leaves a check open goes back for a second pass with the draft",
  );
  const lines = (await (await ask("Leave something unchecked.", true)).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, "done");
  assert.match(
    lines.at(-1).answer.text,
    /^Checked after: /,
    "Streamed answers get the same check",
  );
  const turns = lines.filter((e) => e.type === "turn").length;
  assert.ok(
    turns >= 3,
    "The checked pass starts a new turn, which replaces the draft on screen",
  );
  assert.equal(
    (await (await ask("Answer fully.")).json()).answer.text,
    "The function moved to `module.py`.",
    "A complete draft is the answer",
  );
});

test("Ask about a folder reads its README, declarations and changed code, not only file names", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await mkdir(path.join(f.dir, "lib"));
  await writeFile(
    path.join(f.dir, "lib/README.md"),
    "# Lib\n\nShared helpers for parsing.\n",
  );
  await writeFile(
    path.join(f.dir, "lib/util.py"),
    "def helper(x):\n    return x\n",
  );
  await writeFile(
    path.join(f.dir, "outside.py"),
    "def elsewhere():\n    return 0\n",
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Add lib");
  const base = (await f.git("rev-parse", "HEAD")).toString().trim();
  await writeFile(
    path.join(f.dir, "lib/util.py"),
    "def helper(x, strict=False):\n    return x\n",
  );
  await f.git("commit", "-am", "Tighten helper");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const result = await f.req("/api/ask", {
    base,
    head,
    sha: head,
    anchor: { kind: "folder", path: "lib" },
    question: "Echo the context.",
    history: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  const context = JSON.parse(result.answer.text);
  assert.equal(context.readme.path, "lib/README.md");
  assert.match(context.readme.text, /Shared helpers for parsing/);
  assert.match(context.declarations, /function helper \(changed: signature\)/);
  assert.match(context.patches, /--- lib\/util\.py[\s\S]*strict=False/);
  assert.doesNotMatch(
    context.declarations,
    /elsewhere/,
    "Context stays within the folder",
  );
});

test("Ask about a declaration late in a file receives that declaration's source", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const filler = Array.from({ length: 300 }, (_, i) => `X${i} = ${i}`).join(
    "\n",
  );
  await writeFile(
    path.join(f.dir, "late.py"),
    `import os\n${filler}\n\ndef target(value):\n    return value * 42\n`,
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Add late declaration");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const result = await f.req("/api/ask", {
    base: f.sha,
    head,
    sha: head,
    anchor: { kind: "symbol", path: "late.py", symbol: "target" },
    question: "Echo the context.",
    history: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  const context = JSON.parse(result.answer.text);
  assert.match(context.after, /def target\(value\):\n    return value \* 42/);
  assert.doesNotMatch(
    context.after,
    /import os/,
    "Only the declaration's lines, not the file head",
  );
  assert.equal(context.before, "", "A new declaration has no earlier source");
});

test("Ask sees callers and may use bounded read-only lookups that end with the answer", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(
    path.join(f.dir, "late.py"),
    "import os\n\ndef target(value):\n    return value * 42\n",
  );
  await writeFile(
    path.join(f.dir, "caller.py"),
    "from late import target\n\ndef use():\n    return target(1)\n",
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Add caller");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const ask = (question, anchor) =>
    f.req("/api/ask", {
      base: f.sha,
      head,
      sha: head,
      anchor,
      question,
      history: [],
    });

  const echoed = await ask("Echo the context.", {
    kind: "symbol",
    path: "late.py",
    symbol: "target",
  });
  assert.equal(echoed.status, 200, JSON.stringify(echoed));
  const related = JSON.parse(JSON.parse(echoed.answer.text).relationships);
  assert.ok(
    related.incoming.some((line) =>
      line.startsWith("caller.py · use calls target"),
    ),
    "The question carries who calls the selection: " + JSON.stringify(related),
  );
  assert.deepEqual(echoed.lookups, [], "No lookups unless the model asks");
  assert.deepEqual(
    JSON.parse(echoed.answer.text).callers.map(({ path, symbol }) => [
      path,
      symbol,
    ]),
    [["caller.py", "use"]],
    "The calling declaration's code comes with the question",
  );
  assert.match(
    JSON.parse(echoed.answer.text).callers[0].code,
    /return target\(1\)/,
  );

  const result = await ask("Use the lookup tools.", {
    kind: "symbol",
    path: "late.py",
    symbol: "target",
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  const used = JSON.parse(result.answer.text);
  assert.deepEqual(used.tools, [
    "find_declarations",
    "search_code",
    "read_declaration",
    "read_file",
    "relationships",
    "highlight",
    "route",
  ]);
  for (const name of used.tools)
    assert.ok(used.allowed.includes("mcp__peekumi__" + name));
  assert.equal(used.notified, 202);
  assert.match(used.found, /"path":"late.py","name":"target"/);
  assert.match(used.read, /3  def target\(value\):/);
  assert.match(used.file, /1  import os/);
  assert.match(used.related, /caller\.py · use calls target/);
  const searched = JSON.parse(used.searched);
  assert.ok(
    searched.matches.some(
      (m) =>
        m.path === "caller.py" &&
        m.within === "use" &&
        /return target\(1\)/.test(m.text),
    ),
    "Code search finds the call site and the declaration it sits in: " +
      used.searched,
  );
  assert.equal(used.calls, 30, "Lookups stop at the per-answer limit");
  assert.equal(result.lookups.length, 30);
  assert.ok(result.lookups.includes("Read target in late.py"));

  const after = await fetch(used.url, {
    method: "POST",
    headers: { Authorization: used.key, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(after.status, 401, "The lookup key ends with the answer");
  const owner = await fetch(used.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.server.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(owner.status, 401, "The owner token is not a lookup key");
});

test("Answer code spans link to the map only when they name exactly one file or declaration", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(path.join(f.dir, "a.py"), "def helper():\n    return 1\n");
  await writeFile(path.join(f.dir, "b.py"), "def helper():\n    return 2\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Two helpers");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const result = await f.req("/api/ask", {
    base: f.sha,
    head,
    sha: head,
    anchor: { kind: "repo", path: "" },
    question: "Name references.",
    history: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(result.references.run, {
    kind: "symbol",
    path: "module.py",
    symbol: "run",
    line: 2,
    side: "after",
  });
  assert.deepEqual(result.references["module.py"], {
    kind: "file",
    path: "module.py",
    line: null,
    side: "after",
  });
  assert.equal(result.references["module.py:2"].line, 2);
  assert.equal(
    result.references.nowhere_at_all,
    undefined,
    "Unknown names stay plain text",
  );
  assert.equal(
    result.references.helper,
    undefined,
    "Ambiguous names stay plain text",
  );
});

test("Ask streams its answer: working turns are replaced, lookups and the final answer arrive as events", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await fetch(f.server.url + "/api/ask", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.server.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base: f.sha,
      head: f.sha,
      sha: f.sha,
      anchor: { kind: "symbol", path: "module.py", symbol: "run" },
      question: "What does this do?",
      history: [],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.type, "done", JSON.stringify(last));
  let shown = "";
  for (const event of events) {
    if (event.type === "turn") shown = "";
    if (event.type === "text") shown += event.text;
  }
  assert.ok(
    events.filter((e) => e.type === "text").length > 2,
    "The answer arrives in pieces",
  );
  assert.doesNotMatch(
    shown,
    /Let me check/,
    "A new turn replaces the working text",
  );
  assert.match(shown, /I have not run tests/);
  assert.match(last.answer.text, /I have not run tests/);
  assert.equal(
    last.answer.suggestion,
    "Add a focused regression test for this behavior.",
  );
  const state = await f.req("/api/workflow");
  assert.equal(state.comments.length, 0, "Streaming never creates drafts");
});

test("branch inspection reads selected history without switching or changing the checkout", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.git("checkout", "-b", "feature/inspect");
  await writeFile(path.join(f.dir, "feature.txt"), "feature content");
  await f.git("add", ".");
  await f.git("commit", "-m", "Feature implementation");
  const tip = (await f.git("rev-parse", "HEAD")).toString().trim();
  await f.git("update-ref", "refs/remotes/origin/feature", tip);
  await f.git("checkout", "main");
  await writeFile(path.join(f.dir, "local-draft.txt"), "keep this untouched");
  const before = (await f.git("status", "--porcelain")).toString();
  const meta = await f.req("/api/repo?head=refs%2Fheads%2Ffeature%2Finspect");
  assert.equal(meta.status, 200);
  assert.equal(meta.initialHead, tip);
  assert.equal(meta.commits[0].sha, tip);
  assert.equal(meta.commits[0].parent, f.sha);
  assert.equal(meta.selectedBranch.name, "feature/inspect");
  assert.equal(meta.branch, "main");
  assert.ok(
    meta.branches.some(
      (b) => b.ref === "refs/remotes/origin/feature" && b.remote,
    ),
  );
  assert.equal(
    (await f.req("/api/repo?head=refs%2Fremotes%2Forigin%2Ffeature"))
      .initialHead,
    tip,
  );
  assert.equal((await f.req("/api/repo?head=--all")).status, 400);
  assert.equal((await f.git("rev-parse", "HEAD")).toString().trim(), f.sha);
  assert.equal((await f.git("status", "--porcelain")).toString(), before);
});

test("a task agent checks its committed work against the rules, and the comparison names the breaks it adds", async (t) => {
  const rules = {
    version: 1,
    groups: { ui: ["ui/**"], db: ["db/**"], typo: ["uii/**"] },
    rules: [
      {
        id: "ui-no-db",
        from: "ui",
        to: ["db"],
        kinds: ["imports", "calls"],
        message: "The UI goes through services.",
      },
    ],
  };
  const f = await fixture({
    files: {
      ".peekumi.json": JSON.stringify(rules),
      "ui/__init__.py": "",
      "ui/view.py": "def show():\n    return 1\n",
      "db/__init__.py": "",
      "db/store.py": "def save():\n    return 2\n",
    },
  });
  t.after(() => f.close());
  const c = await f.req("/api/comments", {
    text: "Write the result file. CHECK_RULES",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    commentIds: [c.id],
    using: { agent: "claude" },
  });
  assert.match(p.task, /call it before you report: fix each rule break/);
  await f.req("/api/runs", { previewId: p.id });
  const run = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "completed" && r;
  });
  // The agent saw check_rules among its map tools, and it named the break its commit adds.
  const used = JSON.parse(
    await readFile(path.join(f.state, "agent-rules.json"), "utf8"),
  );
  assert.ok(used.tools.includes("check_rules"), used.tools.join(","));
  assert.equal(used.error, false);
  assert.match(used.result.result, /add 1 rule break/);
  assert.deepEqual(
    used.result.added.map((b) => [b.rule, b.source.path, b.target.path]),
    [["ui-no-db", "ui/view.py", "db/store.py"]],
  );
  assert.match(used.result.warnings.join(" "), /"typo" matches no file/);
  // The comparison of the task gives coverage for each rule, and the breaks it adds.
  const head = run.results.at(-1);
  const data = await f.req(
    `/api/relationships?base=${f.sha}&head=${head}&view=overview`,
  );
  assert.equal(data.checks.added.length, 1);
  const coverage = data.checks.after.coverage[0];
  assert.equal(coverage.id, "ui-no-db");
  assert.equal(coverage.broke, 1);
  assert.ok(coverage.checked >= 1);
  assert.equal(data.checks.before.coverage[0].broke, 0);
  // The same comparison the other way adds nothing.
  const back = await f.req(
    `/api/relationships?base=${head}&head=${f.sha}&view=overview`,
  );
  assert.deepEqual(back.checks.added, []);
});

test("Peekumi proposes one fix for each rule and declaration that its breaks reach", async (t) => {
  const f = await fixture({
    files: {
      ".peekumi.json": JSON.stringify({
        version: 1,
        groups: { ui: ["ui/**"], db: ["db/**"] },
        rules: [
          {
            id: "ui-no-db",
            from: "ui",
            to: ["db"],
            kinds: ["calls"],
            message: "The UI goes through services.",
          },
        ],
      }),
      "ui/__init__.py": "",
      "ui/view.py":
        "from db.store import save\n\ndef show():\n    return save()\n",
      "ui/panel.py":
        "from db.store import save\n\ndef draw():\n    return save()\n",
      "db/__init__.py": "",
      "db/store.py": "def save():\n    return 2\n",
    },
  });
  t.after(() => f.close());
  const data = await f.req(`/api/fixes?head=${f.sha}`);
  assert.equal(data.checks.state, "evaluated");
  assert.equal(data.fixes.length, 1, JSON.stringify(data.fixes));
  const [fix] = data.fixes;
  assert.equal(fix.rule, "ui-no-db");
  assert.deepEqual(fix.target, { path: "db/store.py", symbol: "save" });
  assert.equal(fix.count, 2);
  assert.deepEqual(fix.sources, ["ui/panel.py", "ui/view.py"]);
  assert.deepEqual(fix.anchor, {
    kind: "symbol",
    path: "db/store.py",
    symbol: "save",
  });
  assert.match(
    fix.text,
    /^Fix the ui-no-db rule break at save in store\.py: 2 calls from ui\/panel\.py and ui\/view\.py reach it\. The rule says: "The UI goes through services\." Move save to a place/,
  );
  // The fix is a valid instruction anchor, as the page saves it.
  const draft = await f.req("/api/comments", {
    anchor: fix.anchor,
    sha: f.sha,
    text: fix.text,
  });
  assert.equal(draft.status, "draft");
  // The agent proposes the fixes, with Peekumi's groups as context and as the fallback.
  const proposed = await f.req("/api/fixes/propose", {
    head: f.sha,
    using: { agent: "claude" },
  });
  assert.equal(proposed.provider, "Claude Code");
  assert.equal(proposed.groups.length, 1);
  assert.equal(proposed.fixes.length, 1);
  assert.equal(proposed.fixes[0].title, "Reach the store through a service");
  assert.deepEqual(proposed.fixes[0].covers, [fix.id]);
  assert.equal(proposed.fixes[0].count, 2);
  assert.deepEqual(proposed.fixes[0].anchor, fix.anchor);
  assert.match(proposed.fixes[0].text, /^Create services\/store\.py/);
  // A repository with no rules has nothing to fix.
  const g = await fixture();
  t.after(() => g.close());
  const none = await g.req(`/api/fixes?head=${g.sha}`);
  assert.equal(none.checks.state, "not configured");
  assert.deepEqual(none.fixes, []);
  const nothing = await g.req("/api/fixes/propose", {
    head: g.sha,
    using: { agent: "claude" },
  });
  assert.deepEqual([nothing.fixes, nothing.provider], [[], null]);
});
