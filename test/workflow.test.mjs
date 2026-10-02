import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
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
        { action: "verify", version: addressed.version, note: "x".repeat(12001) },
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
  // Simulate the owner applying the reviewed branch outside Strata.
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

test("Ask about a folder reads its README, declarations and changed code, not only file names", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await mkdir(path.join(f.dir, "lib"));
  await writeFile(path.join(f.dir, "lib/README.md"), "# Lib\n\nShared helpers for parsing.\n");
  await writeFile(path.join(f.dir, "lib/util.py"), "def helper(x):\n    return x\n");
  await writeFile(path.join(f.dir, "outside.py"), "def elsewhere():\n    return 0\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Add lib");
  const base = (await f.git("rev-parse", "HEAD")).toString().trim();
  await writeFile(path.join(f.dir, "lib/util.py"), "def helper(x, strict=False):\n    return x\n");
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
  assert.doesNotMatch(context.declarations, /elsewhere/, "Context stays within the folder");
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
