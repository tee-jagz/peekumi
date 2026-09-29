import test from "node:test";
import assert from "node:assert/strict";
import {
  children,
  connections,
  rootScope,
  visibleOnSide,
} from "../public/model.js";
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
  const { patchForSymbol } = await import("../public/model.js");
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
