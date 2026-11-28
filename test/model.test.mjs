import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOutcome,
  children,
  connections,
  rootScope,
  sensitiveKind,
  summarizeChecks,
  tamperFiles,
  visibleOnSide,
} from "../frontend/model.js";
const file = (path, status = "unchanged", deps = [], beforeDeps = []) => ({
  path,
  status,
  deps,
  beforeDeps,
  symbols: [],
});
test("the card hierarchy preserves nested folders and loose root files", () => {
  const files = [
    file("api/app/main.py", "changed"),
    file("api/app/model.py"),
    file("web/main.ts"),
    file("README.md", "added"),
    file("gone/old.py", "removed"),
  ];
  const root = children(files, rootScope());
  assert.equal(root.find((n) => n.path === "api").status, "changed");
  assert.equal(root.find((n) => n.path === "gone").status, "removed");
  const loose = root.find((n) => n.kind === "rootfiles");
  assert.equal(loose.files.length, 1);
  assert.equal(children(files, loose)[0].path, "README.md");
  assert.equal(
    children(files, { kind: "folder", path: "api" })[0].path,
    "api/app",
  );
  assert.equal(children(files, { kind: "folder", path: "api/app" }).length, 2);
});
test("dependency rollup detects replacement imports even when counts stay equal", () => {
  const files = [
    file("pkg/a.py"),
    file("pkg/b.py"),
    file("other/use.py", "changed", ["pkg/b.py"], ["pkg/a.py"]),
  ];
  const edge = connections(files, rootScope())[0];
  assert.equal(edge.from.path, "other");
  assert.equal(edge.to.path, "pkg");
  assert.equal(edge.status, "changed");
  assert.equal(edge.before.size, 1);
  assert.equal(edge.after.size, 1);
  const scoped = connections(files, { kind: "folder", path: "pkg" });
  assert.ok(scoped.every((e) => e.from.kind === "stub"));
  assert.equal(scoped.length, 2);
  const inside = connections(files, { kind: "file", path: "other/use.py" });
  assert.ok(inside.every((e) => e.from.key === "boundary"));
  assert.ok(inside.every((e) => e.to.kind === "stub"));
});
test("Before excludes additions, Structure excludes removals, Changes keeps removed ghosts", () => {
  assert.equal(visibleOnSide({ status: "added" }, true, "changes"), false);
  assert.equal(visibleOnSide({ status: "removed" }, true, "changes"), true);
  assert.equal(visibleOnSide({ status: "removed" }, false, "structure"), false);
  assert.equal(visibleOnSide({ status: "removed" }, false, "changes"), true);
});

test("symbol patches exclude unrelated changed functions", async () => {
  const { patchForSymbol } = await import("../frontend/model.js");
  const patch =
    "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n-old_a\n+new_a\n@@ -30,2 +30,2 @@\n-old_b\n+new_b\n";
  const selected = {
    status: "changed",
    start: 1,
    end: 5,
    before: { start: 1, end: 5 },
  };
  const result = patchForSymbol(patch, selected);
  assert.match(result, /new_a/);
  assert.doesNotMatch(result, /new_b/);
  assert.equal(patchForSymbol(patch, { ...selected, status: "unchanged" }), "");
  assert.equal(patchForSymbol(patch, null), patch);
});

test("typed symbol edges preserve rule-only changes and never draw unresolved candidates", () => {
  const files = [
    { ...file("app.ts"), symbols: [{ name: "run" }, { name: "helper" }] },
  ];
  const fact = {
    source: { path: "app.ts", symbol: "run" },
    targets: [{ path: "app.ts", symbol: "helper" }],
    kind: "calls",
    resolution: "resolved",
    violations: [],
  };
  const relations = [
    {
      status: "changed",
      before: fact,
      after: { ...fact, violations: [{ id: "boundary", message: "No calls" }] },
    },
    {
      status: "added",
      before: null,
      after: { ...fact, resolution: "ambiguous" },
    },
  ];
  const edges = connections(files, { kind: "file", path: "app.ts" }, relations);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from.key, "symbol:run");
  assert.equal(edges[0].to.key, "symbol:helper");
  assert.equal(edges[0].status, "changed");
  assert.equal(edges[0].violationsAfter[0].id, "boundary");
});

test("checkOutcome classifies every GitHub CheckRun and StatusContext state honestly", () => {
  // CheckRuns
  assert.equal(
    checkOutcome({ status: "COMPLETED", conclusion: "SUCCESS" }),
    "passed",
  );
  for (const conclusion of [
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]) {
    assert.equal(
      checkOutcome({ status: "COMPLETED", conclusion }),
      "failed",
      conclusion,
    );
  }
  assert.equal(
    checkOutcome({ status: "IN_PROGRESS", conclusion: null }),
    "pending",
  );
  assert.equal(checkOutcome({ status: "QUEUED" }), "pending");
  assert.equal(
    checkOutcome({ status: "COMPLETED", conclusion: "SKIPPED" }),
    "skipped",
  );
  assert.equal(
    checkOutcome({ status: "COMPLETED", conclusion: "NEUTRAL" }),
    "neutral",
  );
  assert.equal(
    checkOutcome({ status: "COMPLETED", conclusion: "STALE" }),
    "unknown",
  );
  assert.equal(checkOutcome({ status: "COMPLETED" }), "unknown");

  // StatusContexts
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "SUCCESS" }),
    "passed",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "FAILURE" }),
    "failed",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "ERROR" }),
    "failed",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "PENDING" }),
    "pending",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "EXPECTED" }),
    "pending",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", state: "MYSTERY" }),
    "unknown",
  );
});

test("summarizeChecks says All N reported checks passed only when every check explicitly passed", () => {
  const empty = summarizeChecks([]);
  assert.equal(empty.headline, "No checks reported");
  assert.equal(empty.tone, "quiet");

  const onePassed = summarizeChecks([
    {
      name: "Unit tests",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/example/repo/actions/runs/1",
    },
  ]);
  assert.equal(onePassed.headline, "All 1 reported check passed");
  assert.equal(onePassed.tone, "good");
  assert.equal(
    onePassed.entries[0].url,
    "https://github.com/example/repo/actions/runs/1",
  );

  const twoPassed = summarizeChecks([
    { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "lint", state: "SUCCESS" },
  ]);
  assert.equal(twoPassed.headline, "All 2 reported checks passed");
  assert.equal(twoPassed.tone, "good");

  // Skipped, neutral or unknown checks must NEVER roll up as "All passed".
  const withSkipped = summarizeChecks([
    { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "E2E", status: "COMPLETED", conclusion: "SKIPPED" },
  ]);
  assert.equal(withSkipped.headline, "1 passed · 1 skipped");
  assert.equal(withSkipped.tone, "open");

  const withNeutral = summarizeChecks([
    { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Note", status: "COMPLETED", conclusion: "NEUTRAL" },
  ]);
  assert.equal(withNeutral.headline, "1 passed · 1 neutral");
  assert.equal(withNeutral.tone, "open");

  const withPending = summarizeChecks([
    { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Deploy", status: "IN_PROGRESS" },
  ]);
  assert.equal(withPending.headline, "1 pending · 1 passed");
  assert.equal(withPending.tone, "wait");

  const withFailed = summarizeChecks([
    { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Tests", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "Lint", status: "IN_PROGRESS" },
  ]);
  assert.equal(withFailed.headline, "1 failed · 1 pending · 1 passed");
  assert.equal(withFailed.tone, "bad");
});

test("tamperFiles identifies changed tests, CI files and .peekumi.json", () => {
  assert.equal(sensitiveKind("test/app.test.mjs"), "tests");
  assert.equal(sensitiveKind(".github/workflows/ci.yml"), "ci");
  assert.equal(sensitiveKind(".peekumi.json"), "config");
  assert.equal(sensitiveKind("src/main.rs"), null);
  const flagged = tamperFiles([
    { path: "src/main.rs", status: "changed" },
    { path: "test/api.test.mjs", status: "changed" },
    { path: ".github/workflows/ci.yml", status: "changed" },
    { path: ".peekumi.json", status: "changed" },
    { path: "test/unchanged.test.mjs", status: "unchanged" },
  ]);
  assert.deepEqual(
    flagged.tests.map((f) => f.path),
    ["test/api.test.mjs"],
  );
  assert.deepEqual(
    flagged.ci.map((f) => f.path),
    [".github/workflows/ci.yml"],
  );
  assert.deepEqual(
    flagged.config.map((f) => f.path),
    [".peekumi.json"],
  );
});
