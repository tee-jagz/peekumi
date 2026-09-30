import assert from "node:assert/strict";
import test from "node:test";
import { agentActivity, diffRows } from "../frontend/workflow.js";
test("agent activity shows messages without command payloads or malformed JSON", () => {
  const lines =
    [
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Checking the change." },
      },
      {
        type: "item.started",
        item: {
          type: "command_execution",
          command: "npm test",
          aggregated_output: "PRIVATE RAW TOOL OUTPUT",
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Fixed the alignment." },
            { type: "tool_use", input: { secret: "no" } },
          ],
        },
      },
      { type: "turn.failed", error: { message: "Connection interrupted" } },
    ]
      .map(JSON.stringify)
      .join("\n") + '\n{"type":"partial';
  const result = agentActivity(lines);
  assert.deepEqual(result.messages, [
    "Checking the change.",
    "Fixed the alignment.",
  ]);
  assert.deepEqual(result.errors, ["Connection interrupted"]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(
    agentActivity('{"item":{"type":"command_execution","command":"npm test"}}')
      .activity,
    "Checking the changes…",
  );
});
test("diff rows hide transport headers and retain distinct before/after line numbers", () => {
  const rows = diffRows(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,2 +8,3 @@ f()\n same\n-old\n+new\n+extra\n\\ No newline at end of file",
  );
  assert.equal(rows[0].text, "Around line 8 · f()");
  assert.deepEqual(
    rows.slice(1).map((r) => [r.kind, r.old, r.new, r.text]),
    [
      ["context", 8, 8, "same"],
      ["deletion", 9, "", "old"],
      ["addition", "", 9, "new"],
      ["addition", "", 10, "extra"],
    ],
  );
  assert.equal(diffRows("Binary files differ").length, 0);
  assert.deepEqual(diffRows(null), []);
  assert.deepEqual(agentActivity("null\n42").messages, []);
});
