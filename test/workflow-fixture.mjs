/** Deterministic agent fixture: commits in its supplied worktree and reports through real stdio MCP. */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
let task = "";
for await (const chunk of process.stdin) task += chunk;
const values = process.argv.slice(2);
// The agents module checks that an agent is installed and signed in, and asks it for its
// models: Claude Code names them in --help, Codex lists them with debug models.
if (values[0] === "--version" || (values[0] === "login" && values[1] === "status")) {
  console.log("fixture agent 1.0");
  process.exit(0);
}
if (values[0] === "auth" && values[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "fixture" }));
  process.exit(0);
}
if (values[0] === "--help") {
  console.log(
    "Options:\n  --effort <level>   Effort level for the current session\n                     (low, medium, high, max)\n" +
      "  --model <model>    Model for the current session. Provide\n                     an alias for the latest model (e.g.\n                     'sonnet' or 'opus') or a\n                     model's full name.\n  -n, --name <name>  Set a name",
  );
  process.exit(0);
}
if (values[0] === "debug" && values[1] === "models") {
  const level = (effort) => ({ effort, description: effort });
  console.log(JSON.stringify({ models: [
    { slug: "fixture-hidden", display_name: "Hidden", visibility: "hide", priority: 0, supported_reasoning_levels: [level("low")] },
    { slug: "fixture-small", display_name: "Fixture Small", description: "Fast", visibility: "list", priority: 2, default_reasoning_level: "low", supported_reasoning_levels: [level("low"), level("medium")] },
    { slug: "fixture-large", display_name: "Fixture Large", description: "Careful", visibility: "list", priority: 1, default_reasoning_level: "high", supported_reasoning_levels: [level("low"), level("high"), level("xhigh")] },
  ] }));
  process.exit(0);
}
if (values.includes("--tools")) {
  // A commit message for the owner's own changes: no tools, the diff as input.
  if (values[values.indexOf("--system-prompt") + 1]?.startsWith("You write one Git commit message")) {
    if (values[values.indexOf("--tools") + 1] !== "") throw Error("The commit message agent must have no tools");
    if (process.env.PEEKUMI_TOKEN || process.env.PEEKUMI_REPORT_TOKEN)
      throw Error("The commit message agent inherited a Peekumi credential");
    if (!task.includes("agent-result.txt")) throw Error("Missing the owner's diff");
    console.log(JSON.stringify({ is_error: false, result: "Record the owner's own result notes" }));
    process.exit(0);
  }
  if (
    values[values.indexOf("--tools") + 1] !== "" ||
    !values.includes("--strict-mcp-config") ||
    !values.includes("--disable-slash-commands")
  )
    throw Error("Ask must have no tools");
  if (process.env.PEEKUMI_TOKEN || process.env.PEEKUMI_REPORT_TOKEN)
    throw Error("Ask inherited a Peekumi credential");
  if (!values[values.indexOf("--system-prompt") + 1]?.includes("ASD-STE100"))
    throw Error("Ask must answer in ASD-STE100 Simplified Technical English");
  if (!values[values.indexOf("--system-prompt") + 1]?.includes("Check before you answer"))
    throw Error("Ask must verify the facts its answer depends on before it answers");
  if (values[values.indexOf("--effort") + 1] !== "low")
    throw Error("Ask must run at low effort for fast answers");
  if (values[values.indexOf("--model") + 1] !== "sonnet")
    throw Error("Ask must default to the fast model");
  const input = JSON.parse(task);
  if (!input.repositoryContext || !input.question)
    throw Error("Missing grounded context");
  // Exercises the read-only lookup endpoint the way Claude Code does (Streamable HTTP MCP).
  async function lookups() {
    const config = JSON.parse(values[values.indexOf("--mcp-config") + 1])
      .mcpServers.peekumi;
    if (config.alwaysLoad !== true) throw Error("Ask must load its lookups in the first prompt");
    const headers = {
      ...config.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    let id = 0;
    const post = (message) =>
      fetch(config.url, { method: "POST", headers, body: JSON.stringify(message) });
    const rpc = async (method, params) =>
      (await (await post({ jsonrpc: "2.0", id: ++id, method, params })).json()).result;
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    const notified = (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status;
    const tools = (await rpc("tools/list")).tools.map((t) => t.name);
    const call = async (name, args) =>
      (await rpc("tools/call", { name, arguments: args })) ;
    const text = (r) => r.content[0].text;
    const found = text(await call("find_declarations", { query: "targ" }));
    const read = text(await call("read_declaration", { path: "late.py", name: "target" }));
    const file = text(await call("read_file", { path: "late.py", start_line: 1, end_line: 2 }));
    const related = text(await call("relationships", { path: "late.py", name: "target" }));
    const searched = text(await call("search_code", { text: "target(" }));
    let calls = 5;
    while (!(await call("find_declarations", { query: "x" })).isError) calls++;
    return JSON.stringify({
      allowed: values[values.indexOf("--allowedTools") + 1],
      tools, notified, found, read, file, related, searched, calls,
      url: config.url, key: config.headers.Authorization,
    });
  }
  // Echoing lets tests inspect exactly what context the server supplied.
  const result =
    input.question === "Use the lookup tools."
      ? await lookups()
      : input.question === "Name references."
      ? "`run` is defined in `module.py` at `module.py:2`. `nowhere_at_all` does not exist, and `helper` is defined twice."
      : input.question === "Echo the context."
      ? JSON.stringify(input.repositoryContext.source)
      : input.question === "Echo the rules."
      ? JSON.stringify(input.repositoryContext.rules)
      : input.question === "Leave something unchecked."
      ? "The function moved. I did not check the tests."
      : input.question.startsWith("Your draft answer")
      ? "Checked after: " + input.conversation.at(-1).text
      : input.question === "Answer fully."
      ? "The function moved to `module.py`."
      : "The supplied comparison shows the selected module. I have not run tests.\nSuggested instruction: Add a focused regression test for this behavior.";
  if (values.includes("stream-json")) {
    // Claude Code's streaming shape: a working turn, then the answer in small pieces.
    const say = (event) => console.log(JSON.stringify(event));
    const delta = (text) =>
      say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    say({ type: "system", subtype: "init" });
    say({ type: "stream_event", event: { type: "message_start" } });
    delta("Let me check the callers. ");
    say({ type: "stream_event", event: { type: "message_start" } });
    for (const piece of result.match(/[\s\S]{1,16}/g)) delta(piece);
    say({ type: "result", is_error: false, result });
  } else console.log(JSON.stringify({ is_error: false, result }));
  process.exit(0);
}
let command, args;
if (values.includes("--mcp-config")) {
  if (
    !values.includes("--strict-mcp-config") ||
    !values.some((v) => v.includes("mcp__peekumi__resolve_comment"))
  )
    throw Error("Missing scoped reporting tool configuration");
  const config = JSON.parse(values[values.indexOf("--mcp-config") + 1])
    .mcpServers.peekumi;
  if (config.alwaysLoad !== true) throw Error("Tasks must load the reporting tools in the first prompt");
  command = config.command;
  args = config.args;
} else {
  if (
    !values.includes("--approve-for-me") ||
    values.includes("--sandbox") ||
    values.includes("--dangerously-bypass-approvals-and-sandbox")
  )
    throw Error("Use the approval-review preset without conflicting sandbox flags");
  command = JSON.parse(
    values
      .find((v) => v.startsWith("mcp_servers.peekumi.command="))
      .split("=")
      .slice(1)
      .join("="),
  );
  args = JSON.parse(
    values
      .find((v) => v.startsWith("mcp_servers.peekumi.args="))
      .split("=")
      .slice(1)
      .join("="),
  );
}
function call(name, arguments_ = {}) {
  const response = spawnSync(command, args, {
    encoding: "utf8",
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }) + "\n",
  });
  if (response.status !== 0) throw Error(response.stderr);
  const result = JSON.parse(response.stdout).result;
  return result.isError
    ? { error: result.content[0].text }
    : JSON.parse(result.content[0].text);
}
// Tests read the exact arguments an agent was started with.
writeFileSync(args[args.indexOf("--state-dir") + 1] + "/agent-argv.json", JSON.stringify(values));
// The code graph: Claude gets it as an HTTP MCP server in --mcp-config, Codex as -c options
// with its key in the environment. Record one lookup so tests can check the grant.
{
  let graph = null;
  if (values.includes("--mcp-config")) {
    const server = JSON.parse(values[values.indexOf("--mcp-config") + 1]).mcpServers.peekumi_graph;
    if (server && server.alwaysLoad !== true) throw Error("Tasks must load the graph tools in the first prompt");
    if (server) graph = { url: server.url, auth: server.headers.Authorization };
  } else {
    const url = values.find((v) => v.startsWith("mcp_servers.peekumi_graph.url="));
    if (url) graph = { url: JSON.parse(url.split("=").slice(1).join("=")), auth: `Bearer ${process.env.PEEKUMI_GRAPH_TOKEN}` };
  }
  const state = args[args.indexOf("--state-dir") + 1];
  if (graph) {
    const reply = await (await fetch(graph.url, {
      method: "POST",
      headers: { Authorization: graph.auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_declarations", arguments: { query: "run" } } }),
    })).json();
    writeFileSync(state + "/agent-graph.json", JSON.stringify({ ...graph, text: reply.result?.content?.[0]?.text ?? null, error: !reply.result || reply.result.isError === true }));
  }
}
const run = call("get_run");
if (run.task !== task) throw Error("Preview and dispatched task differ");
const git = (...a) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...a], {
    encoding: "utf8",
  }).trim();
// An update round merges the target branch and resolves conflicts by keeping both sides.
if (run.kind === "update") {
  if (!run.task.includes(`git merge ${run.mergeTarget}`)) throw Error("Missing the merge instruction");
  const merged = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "merge", "--no-edit", run.mergeTarget], { encoding: "utf8" });
  if (merged.status !== 0) {
    for (const file of git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)) {
      writeFileSync(file, git("show", `:2:${file}`) + "\n" + git("show", `:3:${file}`) + "\n");
      git("add", file);
    }
    git("commit", "--no-edit");
  }
  process.exit(0);
}
if (run.brief === "WAIT_FOR_CANCEL")
  await new Promise((r) => setTimeout(r, 30000));
const first = run.comments[0];
if (
  !call("resolve_comment", {
    comment_id: first.id,
    commit_sha: run.base,
    note: "bad",
    checks: "bad",
  }).error
)
  throw Error("Accepted base commit");
if (!call("flag_comment", { comment_id: "c-other-run", reason: "bad" }).error)
  throw Error("Accepted unrelated comment");
// A later round builds on the earlier one, so it adds to the file rather than rewriting it.
writeFileSync(
  "agent-result.txt",
  existsSync("agent-result.txt")
    ? readFileSync("agent-result.txt", "utf8") + `Round ${run.round} applied the requested changes.\n`
    : "A deterministic agent fixture completed this change.\n",
);
git("add", "agent-result.txt");
git("commit", "-m", "Fixture change without attribution");
let sha = git("rev-parse", "HEAD");
if (
  !call("resolve_comment", {
    comment_id: first.id,
    commit_sha: sha,
    note: "bad",
    checks: "bad",
  }).error
)
  throw Error("Accepted missing trailers");
// A blank line before a last trailer splits the block, and git sees only that trailer. The
// error names the missing lines and what git found.
git(
  "commit",
  "--amend",
  "-m",
  `Fixture change\n\nPeekumi-Run: ${run.id}\nPeekumi-Comment: ${first.id}\nPeekumi-Agent: ${run.agent}\n\nCo-Authored-By: Fixture <fixture@example.invalid>`,
);
const split = call("resolve_comment", { comment_id: first.id, commit_sha: git("rev-parse", "HEAD"), note: "bad", checks: "bad" });
if (!split.error || !split.error.includes(`Peekumi-Run: ${run.id}`) || !split.error.includes("Git found these trailers: Co-Authored-By: Fixture") || !split.error.includes("last paragraph"))
  throw Error("Unclear trailer error: " + JSON.stringify(split));
git(
  "commit",
  "--amend",
  "-m",
  `Fixture change\n\nPeekumi-Run: ${run.id}\nPeekumi-Comment: ${first.id}\nPeekumi-Agent: ${run.agent}`,
);
sha = git("rev-parse", "HEAD");
const report = call("resolve_comment", {
  comment_id: first.id,
  commit_sha: sha,
  note: "Implemented the requested fixture change.",
  checks:
    "Checked agent-result.txt content; no application tests apply to this fixture.",
});
if (report.error) throw Error(report.error);
if (run.comments[1]) {
  const r = call("flag_comment", {
    comment_id: run.comments[1].id,
    reason: "Needs an owner decision.",
  });
  if (r.error) throw Error(r.error);
}
console.log("Fixture reporting checks passed");
// Keep the run active long enough to test dispatch serialization and owner verification ordering.
const state = args[args.indexOf("--state-dir") + 1];
for (let i = 0; existsSync(state + "/hold") && i < 1200; i++)
  await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 300));
