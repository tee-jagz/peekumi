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
  const p = await f.req("/api/runs/preview", { agent: "codex", commentIds: [c.id] });
  await f.req("/api/runs", { previewId: p.id });
  const first = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "completed" && r;
  });
  const empty = await fetch(`${f.server.url}/api/runs/${p.id}/revise`, {
    method: "POST",
    headers: { Authorization: "Bearer " + f.server.token, "Content-Type": "application/json" },
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
  const misuse = await f.req("/api/runs/preview", { agent: "codex", commentIds: [collected.id] });
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
  assert.match(next.task, /## Already done in an earlier round\n[^]*Do not report on them\.[^]*Write the result file\nReport: Implemented the requested fixture change\./);
  assert.match(next.task, /"path":"agent-result.txt"[^\n]*\(left on [0-9a-f]{40}\)\nName the round in the file too\./);
  assert.equal(next.round, 2);
  assert.equal(next.revises, p.id);
  assert.equal(next.agent, "codex");
  assert.notEqual(next.branch, first.branch);
  assert.equal(next.base, first.results.at(-1), "The next round starts from the agent's last commit");
  assert.equal(next.reportHash, undefined, "The reporting credential never reaches the browser");
  assert.match(next.task, /## Changes requested by the owner\nAlso say which round made the change\./);
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
  assert.equal(state.comments.find((x) => x.id === collected.id).forRun, undefined);
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
  const again = await f.req(`/api/runs/${p.id}/revise`, { feedback: "Once more" });
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
  const addressed = (await f.req("/api/workflow")).comments.find((x) => x.id === collected.id);
  assert.equal(addressed.status, "addressed");
  assert.equal(addressed.report.commit, result);
  await f.req("/api/comments/" + collected.id, { action: "verify", version: addressed.version }, "PATCH");
  const done = await f.req(`/api/runs/${next.id}/revise`, { feedback: "More" });
  assert.match(done.error, /Nothing in this task is left to change/);
  assert.equal(
    (await f.git("rev-parse", "HEAD")).toString().trim(),
    f.sha,
    "The inspected checkout never moves",
  );
  // An approval can be undone while the work is not on main, and given again.
  let approved = (await f.req("/api/workflow")).comments.find((x) => x.id === c.id);
  const reopened = await f.req("/api/comments/" + c.id, { action: "unverify", version: approved.version }, "PATCH");
  assert.equal(reopened.status, "addressed");
  assert.ok(reopened.history.some((h) => h.status === "verified"), "The approval stays in the history");
  approved = await f.req("/api/comments/" + c.id, { action: "verify", version: reopened.version }, "PATCH");
  assert.equal(approved.status, "verified");
  // Once the owner merges the latest round, the task is a settled record.
  await f.git("merge", "--ff-only", next.branch);
  assert.equal((await f.req("/api/runs/" + next.id)).applied, true);
  const locked = [
    await f.req("/api/comments/" + c.id, { action: "unverify", version: approved.version }, "PATCH"),
    await f.req(`/api/runs/${next.id}/revise`, { feedback: "Again" }),
    await f.req("/api/comments", { text: "More", sha: result, anchor: { kind: "repo", path: "" }, forRun: next.id }),
  ];
  for (const r of locked) assert.match(r.error, /applied to main; start a new task/);
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
      headers: { Authorization: "Bearer " + f.server.token, "Content-Type": "application/json" },
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
  const lines = (await (await ask("Leave something unchecked.", true)).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, "done");
  assert.match(lines.at(-1).answer.text, /^Checked after: /, "Streamed answers get the same check");
  const turns = lines.filter((e) => e.type === "turn").length;
  assert.ok(turns >= 3, "The checked pass starts a new turn, which replaces the draft on screen");
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

test("Ask about a declaration late in a file receives that declaration's source", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const filler = Array.from({ length: 300 }, (_, i) => `X${i} = ${i}`).join("\n");
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
  assert.doesNotMatch(context.after, /import os/, "Only the declaration's lines, not the file head");
  assert.equal(context.before, "", "A new declaration has no earlier source");
});

test("Ask sees callers and may use bounded read-only lookups that end with the answer", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(path.join(f.dir, "late.py"), "import os\n\ndef target(value):\n    return value * 42\n");
  await writeFile(path.join(f.dir, "caller.py"), "from late import target\n\ndef use():\n    return target(1)\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Add caller");
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const ask = (question, anchor) =>
    f.req("/api/ask", { base: f.sha, head, sha: head, anchor, question, history: [] });

  const echoed = await ask("Echo the context.", { kind: "symbol", path: "late.py", symbol: "target" });
  assert.equal(echoed.status, 200, JSON.stringify(echoed));
  const related = JSON.parse(JSON.parse(echoed.answer.text).relationships);
  assert.ok(
    related.incoming.some((line) => line.startsWith("caller.py · use calls target")),
    "The question carries who calls the selection: " + JSON.stringify(related),
  );
  assert.deepEqual(echoed.lookups, [], "No lookups unless the model asks");
  assert.deepEqual(
    JSON.parse(echoed.answer.text).callers.map(({ path, symbol }) => [path, symbol]),
    [["caller.py", "use"]],
    "The calling declaration's code comes with the question",
  );
  assert.match(JSON.parse(echoed.answer.text).callers[0].code, /return target\(1\)/);

  const result = await ask("Use the lookup tools.", { kind: "symbol", path: "late.py", symbol: "target" });
  assert.equal(result.status, 200, JSON.stringify(result));
  const used = JSON.parse(result.answer.text);
  assert.deepEqual(used.tools, ["find_declarations", "search_code", "read_declaration", "read_file", "relationships"]);
  for (const name of used.tools) assert.ok(used.allowed.includes("mcp__peekumi__" + name));
  assert.equal(used.notified, 202);
  assert.match(used.found, /"path":"late.py","name":"target"/);
  assert.match(used.read, /3  def target\(value\):/);
  assert.match(used.file, /1  import os/);
  assert.match(used.related, /caller\.py · use calls target/);
  const searched = JSON.parse(used.searched);
  assert.ok(
    searched.matches.some((m) => m.path === "caller.py" && m.within === "use" && /return target\(1\)/.test(m.text)),
    "Code search finds the call site and the declaration it sits in: " + used.searched,
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
    headers: { Authorization: "Bearer " + f.server.token, "Content-Type": "application/json" },
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
  assert.deepEqual(result.references.run, { kind: "symbol", path: "module.py", symbol: "run", line: 2, side: "after" });
  assert.deepEqual(result.references["module.py"], { kind: "file", path: "module.py", line: null, side: "after" });
  assert.equal(result.references["module.py:2"].line, 2);
  assert.equal(result.references.nowhere_at_all, undefined, "Unknown names stay plain text");
  assert.equal(result.references.helper, undefined, "Ambiguous names stay plain text");
});

test("Ask streams its answer: working turns are replaced, lookups and the final answer arrive as events", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await fetch(f.server.url + "/api/ask", {
    method: "POST",
    headers: { Authorization: "Bearer " + f.server.token, "Content-Type": "application/json" },
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
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.type, "done", JSON.stringify(last));
  let shown = "";
  for (const event of events) {
    if (event.type === "turn") shown = "";
    if (event.type === "text") shown += event.text;
  }
  assert.ok(events.filter((e) => e.type === "text").length > 2, "The answer arrives in pieces");
  assert.doesNotMatch(shown, /Let me check/, "A new turn replaces the working text");
  assert.match(shown, /I have not run tests/);
  assert.match(last.answer.text, /I have not run tests/);
  assert.equal(last.answer.suggestion, "Add a focused regression test for this behavior.");
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
