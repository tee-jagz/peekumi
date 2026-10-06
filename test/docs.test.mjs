import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const lint = (...args) =>
  spawnSync(process.execPath, ["scripts/lint-docs.mjs", ...args], {
    encoding: "utf8",
  });

test("the documents of the repository keep the writing rules", () => {
  const run = lint();
  assert.equal(run.status, 0, run.stdout);
});

test("the document check finds em dashes and contractions, but not in code", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "peekumi-docs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "sample.md");
  await writeFile(
    file,
    "# Title\n\nYou don't need it — it's fine. Peekumi's map works.\n\nUse `don't` in code.\n\n```\nwe're in code\n```\n",
  );
  const run = lint(file);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /an em dash/);
  assert.match(run.stdout, /"don't"/);
  assert.match(run.stdout, /"it's"/);
  assert.doesNotMatch(
    run.stdout,
    /Peekumi's|we're/,
    "Possessives and code pass",
  );
  assert.match(run.stdout, /3 errors/);
});
