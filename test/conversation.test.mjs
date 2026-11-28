// The server reads each run's conversation into neutral items (backend/conversation.rs). These
// tests compare those items with the parser that the app used before (test/reference/
// timeline.mjs) on the same logs, for Claude Code and for Codex, and check the reads after a
// number, the epoch and the agents' capabilities.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { timeline } from "./reference/timeline.mjs";
import { fixture, waitFor } from "./workflow-support.mjs";

const line = (value) => JSON.stringify(value);
/** The old parser's items as JSON gives them: a field that is undefined there is absent here,
 * which the app reads the same way. */
const parsed = (log) => JSON.parse(JSON.stringify(timeline(log)));
const W = "/tmp/run/worktree/";

/** A Claude Code log with every kind of step, result and Peekumi event. */
const claudeLog = [
  line({
    type: "peekumi.owner",
    turn: 1,
    messages: [
      { text: "Look at it.", anchors: [{ kind: "file", path: "src/a.rs" }] },
      { anchors: [] },
    ],
  }),
  "not json at all",
  line({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "   " },
        {
          type: "tool_use",
          id: "r",
          name: "Read",
          input: { file_path: W + "src/a.rs" },
        },
        {
          type: "tool_use",
          id: "e",
          name: "Edit",
          input: { file_path: W + "src/b.rs" },
        },
        {
          type: "tool_use",
          id: "m",
          name: "MultiEdit",
          input: { file_path: W + "c.md" },
        },
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: W + "new.txt" },
        },
        {
          type: "tool_use",
          id: "w2",
          name: "Write",
          input: { file_path: W + "old.txt" },
        },
        {
          type: "tool_use",
          id: "b",
          name: "Bash",
          input: {
            command:
              "sed -n 1,5p backend/graph.py && ls backend/ ./x/y.js:3 1.2.3 --opt $HOME ~/z",
            description: "Look",
          },
        },
        {
          type: "tool_use",
          id: "b2",
          name: "Bash",
          input: { command: "npm test" },
        },
        {
          type: "tool_use",
          id: "g",
          name: "Glob",
          input: { pattern: "**/*.rs", path: "src/" },
        },
        {
          type: "tool_use",
          id: "s",
          name: "Grep",
          input: { pattern: "fn main", path: "backend" },
        },
        { type: "tool_use", id: "t", name: "TodoWrite", input: {} },
        { type: "tool_use", id: "p", name: "mcp__peekumi__get_run", input: {} },
        {
          type: "tool_use",
          id: "route",
          name: "mcp__peekumi_graph__route",
          input: {
            from: { path: "a.rs", name: "f" },
            to: { path: "b.rs", name: "g" },
          },
        },
        {
          type: "tool_use",
          id: "hl",
          name: "mcp__peekumi_graph__highlight",
          input: { path: "src/a.rs", name: "main" },
        },
        {
          type: "tool_use",
          id: "q",
          name: "mcp__peekumi_graph__find",
          input: { query: "x" },
        },
        {
          type: "tool_use",
          id: "web",
          name: "WebFetch",
          input: { url: "https://x.io" },
        },
      ],
    },
  }),
  line({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "r", content: "fn main() {}" },
        {
          type: "tool_result",
          tool_use_id: "e",
          content: [{ type: "text", text: "Edited" }, "two"],
        },
        { type: "tool_result", tool_use_id: "w1", content: "File created" },
        {
          type: "tool_result",
          tool_use_id: "w2",
          content: "The file was Updated.",
        },
        {
          type: "tool_result",
          tool_use_id: "b",
          content: "out",
          is_error: true,
        },
        { type: "tool_result", tool_use_id: "unknown", content: "lost" },
        { type: "text", text: "not a result" },
      ],
    },
  }),
  line({ type: "result", total_cost_usd: 0.25 }),
  line({ type: "result", is_error: true, result: "It broke." }),
  line({ type: "result", is_error: true }),
  line({ type: "error", message: "boom" }),
  line({ type: "error" }),
  line({ type: "peekumi.error", message: "Turn failed" }),
  line({ type: "peekumi.turn", turn: 1, status: "failed" }),
  line({
    type: "peekumi.rules",
    turn: 1,
    check: { state: "checked", addedCount: 0 },
  }),
  line({ type: "peekumi.rules", turn: 2 }),
].join("\n");

/** A Codex log with each item type, exit codes and errors. */
const codexLog = [
  line({ type: "thread.started", thread_id: "t" }),
  line({
    type: "peekumi.owner",
    turn: 1,
    messages: [{ text: "Go", anchors: [] }],
  }),
  line({ type: "turn.started" }),
  line({
    type: "item.started",
    item: { type: "command_execution", command: "ls" },
  }),
  line({
    type: "item.completed",
    item: { type: "agent_message", text: "On it." },
  }),
  line({ type: "item.completed", item: { type: "agent_message", text: "  " } }),
  line({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/zsh -lc 'cat src/a.rs | head'",
      aggregated_output: "x",
      exit_code: 0,
    },
  }),
  line({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "/bin/bash -lc 'npm test'",
      exit_code: 2,
    },
  }),
  line({
    type: "item.completed",
    item: { type: "command_execution", command: "git status" },
  }),
  line({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [{ path: W + "n.rs", kind: "add" }],
      status: "completed",
    },
  }),
  line({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [
        { path: W + "a.rs", kind: "update" },
        { path: W + "b/c.rs", kind: "add" },
      ],
      status: "failed",
    },
  }),
  line({
    type: "item.completed",
    item: { type: "file_change", path: W + "solo.md" },
  }),
  line({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "peekumi_graph",
      tool: "route",
      arguments: { path: "src/a.rs", name: "f" },
    },
  }),
  line({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "peekumi_graph",
      tool: "find",
      arguments: {},
    },
  }),
  line({
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "other", tool: "x" },
  }),
  line({ type: "item.completed", item: { type: "web_search", query: "x" } }),
  line({ type: "error", message: "Rate limited" }),
  line({ type: "turn.completed", usage: { input_tokens: 5 } }),
  line({ type: "peekumi.turn", turn: 1, status: "completed" }),
  line({ type: "peekumi.rules", turn: 1, check: { state: "no commits" } }),
].join("\n");

/** Replaces run `id`'s log with `log`, then compares the server's items with the old parser. */
async function compare(f, id, log) {
  const file = path.join(f.state, "runs", id, "output.log");
  await writeFile(file, log + "\n");
  const read = await f.req(`/api/runs/${id}/items`);
  assert.ok(Array.isArray(read.items), JSON.stringify(read).slice(0, 300));
  assert.deepEqual(read.items, parsed(log));
  assert.equal(read.total, read.items.length);
  return { file, read };
}

test("the server reads a Claude Code conversation exactly as the app did, and gives only the changes after a number", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.req("/api/comments", {
    text: "Write the result file.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    commentIds: [c.id],
    using: { agent: "claude" },
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(
    async () => (await f.req("/api/runs/" + p.id)).status === "completed",
  );
  const { file, read } = await compare(f, p.id, claudeLog);

  // The same epoch and the last number: nothing changed.
  const none = await f.req(
    `/api/runs/${p.id}/items?after=${read.seq}&epoch=${read.epoch}`,
  );
  assert.deepEqual(none.patches, []);
  assert.equal(none.seq, read.seq);

  // A new step, then its result: only those two changes, with their places in the list.
  const more = [
    line({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "late",
            name: "Read",
            input: { file_path: W + "z.rs" },
          },
        ],
      },
    }),
    line({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "late", content: "ok" }],
      },
    }),
  ];
  await appendFile(file, more[0] + "\n");
  const step = await f.req(
    `/api/runs/${p.id}/items?after=${read.seq}&epoch=${read.epoch}`,
  );
  assert.equal(step.patches.length, 1);
  assert.equal(step.patches[0].index, read.total);
  assert.equal(step.patches[0].item.label, "Read z.rs");
  await appendFile(file, more[1] + "\n");
  const result = await f.req(
    `/api/runs/${p.id}/items?after=${step.seq}&epoch=${step.epoch}`,
  );
  assert.deepEqual(
    result.patches.map((x) => [x.index, x.item.output, x.item.done]),
    [[read.total, "ok", true]],
  );
  // The whole list still equals the old parser on the whole log.
  const all = await f.req(`/api/runs/${p.id}/items`);
  assert.deepEqual(all.items, parsed(claudeLog + "\n" + more.join("\n")));

  // Another epoch (a reader from before a restart) reads everything again.
  const stale = await f.req(`/api/runs/${p.id}/items?after=3&epoch=old`);
  assert.equal(stale.items.length, all.items.length);
});

test("the server reads a Codex conversation exactly as the app did", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = await f.req("/api/runs/session", {
    text: "Look around.",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
    using: { agent: "codex" },
    permissions: "allow",
  });
  await waitFor(
    async () => (await f.req("/api/runs/" + session.id)).status === "waiting",
  );
  await compare(f, session.id, codexLog);
});

test("each agent says what its conversation can do", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { agents } = await f.req("/api/agents");
  const of = (id) => agents.find((a) => a.id === id).capabilities;
  assert.deepEqual(of("claude"), {
    streamText: false,
    queueWhileBusy: true,
    steer: false,
    interrupt: true,
    approvals: true,
    images: false,
    resume: true,
    cost: true,
  });
  assert.equal(of("codex").approvals, false);
  assert.equal(of("codex").cost, false);
  assert.equal(of("openrouter").queueWhileBusy, true);
});
