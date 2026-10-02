import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
test("setup registry is idempotent and refuses unknown configuration versions", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "peekumi-config-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const command = (...args) =>
    spawnSync(process.execPath, ["scripts/manage.mjs", ...args], {
      encoding: "utf8",
      env: { ...process.env, PEEKUMI_HOME: state },
    });
  for (let i = 0; i < 2; i++)
    assert.equal(command("repo", "add", process.cwd()).status, 0);
  const saved = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(saved.repositories.length, 1);
  assert.equal(saved.version, 1);
  assert.equal(command("port", "1023").status, 1);
  assert.equal(command("port", "44419").status, 0);
  assert.equal(JSON.parse(command("status").stdout).running, false);
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({ ...saved, version: 999 }),
  );
  const result = command("repo", "add", process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported config version/);
  assert.equal(
    JSON.parse(await readFile(join(state, "config.json"), "utf8")).version,
    999,
  );
});
