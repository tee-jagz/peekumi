import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const FILES = [
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "CHANGELOG.md",
];
/** Copies of the files that hold the version, and a run of the release script on them. */
async function copy(t) {
  const dir = await mkdtemp(join(tmpdir(), "peekumi-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of FILES) await copyFile(name, join(dir, name));
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
      encoding: "utf8",
      env: { ...process.env, PEEKUMI_RELEASE_ROOT: dir },
    });
  return { dir, run };
}

test("the release script sets the version everywhere and dates the changelog", async (t) => {
  const { dir, run } = await copy(t);
  const changelog = (await readFile(join(dir, "CHANGELOG.md"), "utf8")).replace(
    "## [Unreleased]",
    "## [Unreleased]\n\n### Fixed\n\n- A change for the test.",
  );
  await writeFile(join(dir, "CHANGELOG.md"), changelog);
  const result = run("99.0.0");
  assert.equal(result.status, 0, result.stderr);
  const read = (name) => readFile(join(dir, name), "utf8");
  assert.equal(JSON.parse(await read("package.json")).version, "99.0.0");
  const lock = JSON.parse(await read("package-lock.json"));
  assert.deepEqual(
    [lock.version, lock.packages[""].version],
    ["99.0.0", "99.0.0"],
  );
  assert.match(
    await read("Cargo.toml"),
    /\[package\]\nname = "peekumi"\nversion = "99\.0\.0"/,
  );
  assert.match(
    await read("Cargo.lock"),
    /name = "peekumi"\nversion = "99\.0\.0"/,
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.match(
    await read("CHANGELOG.md"),
    new RegExp(
      `## \\[Unreleased\\]\\n\\n## \\[99\\.0\\.0\\] - ${today}\\n\\n### Fixed\\n\\n- A change for the test\\.`,
    ),
  );
  // The release notes find the new section.
  const notes = spawnSync(
    process.execPath,
    ["scripts/release-notes.mjs", "99.0.0"],
    { encoding: "utf8" },
  );
  assert.equal(notes.status, 1, "The real changelog has no 99.0.0 section");
});

test("the release script refuses an old version and an empty changelog section", async (t) => {
  const { dir, run } = await copy(t);
  assert.match(run("0.0.1").stderr, /not newer/);
  const empty = (await readFile(join(dir, "CHANGELOG.md"), "utf8")).replace(
    /## \[Unreleased\][\s\S]*?(?=\n## \[)/,
    "## [Unreleased]\n",
  );
  await writeFile(join(dir, "CHANGELOG.md"), empty);
  const result = run("99.0.0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lists no change/);
  assert.equal(
    JSON.parse(await readFile(join(dir, "package.json"), "utf8")).version,
    JSON.parse(await readFile("package.json", "utf8")).version,
    "Nothing changes",
  );
});
