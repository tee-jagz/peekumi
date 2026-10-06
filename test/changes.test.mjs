import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { startRust } from "./rust-support.mjs";
import { changesRepo } from "./changes-fixture.mjs";

test("changed declarations name the parts that differ: signature, documentation or implementation", async (t) => {
  const dir = await changesRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await startRust(dir);
  t.after(() => server.close());
  const get = async (route) =>
    (
      await fetch(server.url + route, {
        headers: { Authorization: "Bearer " + server.token },
      })
    ).json();
  const full = await get("/api/compare?base=HEAD~1&head=HEAD");
  const parts = (path, name) => {
    const symbol = full.files
      .find((file) => file.path === path)
      .symbols.find((s) => s.name === name);
    return [symbol.status, symbol.changes];
  };
  for (const [path, impl] of [
    ["mod.py", "impl"],
    ["lib.ts", "impl"],
    ["lib.rs", "imp"],
  ]) {
    assert.deepEqual(parts(path, "sig"), ["changed", ["signature"]], path);
    assert.deepEqual(parts(path, "doc"), ["changed", ["documentation"]], path);
    assert.deepEqual(parts(path, impl), ["changed", ["implementation"]], path);
  }
  assert.deepEqual(
    parts("lib.rs", "Shape"),
    ["changed", ["signature"]],
    "A struct's fields are its signature, not an implementation change",
  );
  assert.deepEqual(
    parts("mod.py", "same"),
    ["unchanged", undefined],
    "Whitespace-only edits leave a declaration unchanged",
  );
  const overview = await get(
    "/api/compare?base=HEAD~1&head=HEAD&view=overview",
  );
  const preview = overview.files.find(
    (file) => file.path === "lib.rs",
  ).symbolPreview;
  assert.ok(
    preview.some((s) => s.changes?.includes("implementation")),
    "The compact map preview carries the classification",
  );
});
