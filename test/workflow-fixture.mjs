/** Deterministic agent fixture: commits in its supplied worktree and reports through real stdio MCP. */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
let task = "";
for await (const chunk of process.stdin) task += chunk;
const values = process.argv.slice(2);
let command, args;
if (values.includes("--mcp-config")) {
  if (
    !values.includes("--strict-mcp-config") ||
    !values.some((v) => v.includes("mcp__strata__resolve_comment"))
  )
    throw Error("Missing scoped reporting tool configuration");
  const config = JSON.parse(values[values.indexOf("--mcp-config") + 1])
    .mcpServers.strata;
  command = config.command;
  args = config.args;
} else {
  if (
    !values.includes("--approve-for-me") ||
    !values.includes("workspace-write")
  )
    throw Error("Missing sandbox and approval review configuration");
  command = JSON.parse(
    values
      .find((v) => v.startsWith("mcp_servers.strata.command="))
      .split("=")
      .slice(1)
      .join("="),
  );
  args = JSON.parse(
    values
      .find((v) => v.startsWith("mcp_servers.strata.args="))
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
const run = call("get_run");
if (run.task !== task) throw Error("Preview and dispatched task differ");
const git = (...a) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...a], {
    encoding: "utf8",
  }).trim();
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
writeFileSync(
  "agent-result.txt",
  "A deterministic agent fixture completed this change.\n",
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
git(
  "commit",
  "--amend",
  "-m",
  `Fixture change\n\nStrata-Run: ${run.id}\nStrata-Comment: ${first.id}\nStrata-Agent: ${run.agent}`,
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
for (let i = 0; existsSync(state + "/hold") && i < 300; i++)
  await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 300));
