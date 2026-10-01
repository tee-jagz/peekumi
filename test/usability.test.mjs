import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { startRust } from "./rust-support.mjs";
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
async function repo(root, name) {
  const dir = join(root, name);
  await mkdir(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "module.py"), "def run():\n    return 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}
test("multiple checkouts isolate comments; reader sessions persist and can be revoked; PWA never opts into API caching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "strata-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await repo(root, "one"),
    b = await repo(root, "two"),
    state = join(root, "state");
  let server = await startRust(a, {
    repositories: [b],
    stateDirectory: state,
    isolatePrimary: true,
  });
  t.after(() => server.close());
  const request = (path, options = {}) =>
    fetch(server.url + path, {
      ...options,
      headers: { Authorization: "Bearer " + server.token, ...options.headers },
    });
  const registry = await (await request("/api/repositories")).json();
  assert.equal(registry.repositories.length, 2);
  const second = registry.repositories.find((r) => r.name === "two");
  const scoped = { "X-Strata-Repository": second.id };
  const sha = git(b, "rev-parse", "HEAD");
  let r = await request("/api/comments", {
    method: "POST",
    headers: { ...scoped, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Only in two",
      sha,
      anchor: { kind: "repo", path: "" },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await (await request("/api/workflow")).json()).comments.length,
    0,
  );
  assert.equal(
    (await (await request("/api/workflow", { headers: scoped })).json())
      .comments.length,
    1,
  );
  assert.equal(
    (
      await request("/api/repo", {
        headers: { "X-Strata-Repository": "../one" },
      })
    ).status,
    404,
  );
  const reader = (
    await readFile(join(state, "read-only/access-token"), "utf8")
  ).trim();
  r = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: reader, name: "Test phone" }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  for (const path of [
    "/api/comments",
    "/api/runs",
    "/api/ask",
    "/api/prs/open",
  ])
    assert.equal(
      (
        await fetch(server.url + path, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await fetch(server.url + "/api/repo", {
        headers: { Cookie: cookie, ...scoped },
      })
    ).status,
    200,
  );
  const devices = await (await request("/api/devices")).json();
  assert.equal(devices[0].role, "reader");
  assert.equal(devices[0].name, "Test phone");
  await server.close();
  server = await startRust(b, {
    repositories: [a],
    stateDirectory: state,
    isolatePrimary: true,
  });
  // Reordering registered checkouts preserves both device pairing and durable repo state.
  assert.equal(
    (await fetch(server.url + "/api/repo", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  const repos2 = await (await request("/api/repositories")).json();
  assert.equal(repos2.repositories.length, 2);
  assert.equal(
    (await (await request("/api/workflow")).json()).comments.length,
    1,
  );
  // Pair again in the new primary namespace and test explicit revocation.
  r = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: reader, name: "Revoke me" }),
  });
  const cookie2 = r.headers.get("set-cookie").split(";")[0];
  const device = (await (await request("/api/devices")).json()).find(
    (d) => d.name === "Revoke me",
  );
  assert.equal(
    (
      await request("/api/devices/" + device.id, {
        method: "DELETE",
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/devices/" + device.id, { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (await fetch(server.url + "/api/repo", { headers: { Cookie: cookie2 } }))
      .status,
    401,
  );
  const sw = await (await request("/sw.js")).text();
  assert.ok(!sw.includes("__STRATA_BUILD__"));
  assert.match(sw, /!SHELL.includes/);
  assert.equal(
    (await request("/api/repo")).headers.get("cache-control"),
    "no-store",
  );
});
test("PR comparison fetches private refs and uses merge base without touching dirty checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "strata-pr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = await repo(root, "repo");
  const common = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-b", "feature");
  await writeFile(join(dir, "module.py"), "def run():\n    return 2\n");
  git(dir, "commit", "-am", "feature");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "main");
  await writeFile(join(dir, "README.md"), "base advanced");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "--bare", dir, remote]);
  git(remote, "update-ref", "refs/pull/7/head", head);
  const bin = join(root, "bin");
  await mkdir(bin);
  const gh = join(bin, "github-fixture.sh");
  const prData = JSON.stringify({
    number: 7,
    title: "Change run",
    url: "https://github.com/example/project/pull/7",
    baseRefName: "main",
    baseRefOid: base,
    headRefOid: head,
    comments: [],
    reviews: [],
    statusCheckRollup: [],
  });
  await writeFile(
    gh,
    `#!/bin/sh
if [ "$1" = repo ]; then
  printf '%s\\n' '{"url":"https://github.com/example/project"}'
elif [ "$2" = list ]; then
  printf '%s\\n' '[{"number":7,"title":"Change run"}]'
else
  printf '%s\\n' '${prData}'
fi
`,
  );
  await chmod(gh, 0o755);
  assert.match(
    execFileSync(gh, ["pr", "view", "7"], { encoding: "utf8", timeout: 5000 }),
    /Change run/,
  );
  const config = join(root, "gitconfig");
  await writeFile(
    config,
    `[url "${remote}"]\n insteadOf = https://github.com/example/project\n`,
  );
  await writeFile(join(dir, "module.py"), "uncommitted work");
  const before = git(dir, "status", "--porcelain");
  const server = await startRust(dir, {
    extraEnv: { STRATA_GH: gh, GIT_CONFIG_GLOBAL: config },
  });
  t.after(() => server.close());
  const r = await fetch(server.url + "/api/prs/open", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + server.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: 7 }),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.base, common);
  assert.equal(data.head, head);
  assert.equal(git(dir, "status", "--porcelain"), before);
  assert.equal(git(dir, "branch", "--show-current"), "main");
  assert.equal(git(dir, "rev-parse", "refs/strata/pr/7/head"), head);
});

test("workflow migration retains comments and refuses newer schemas", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "strata-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await repo(root, "repo"),
    state = join(root, "state");
  let server = await startRust(directory, { stateDirectory: state });
  const r = await fetch(server.url + "/api/comments", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + server.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "Keep this note",
      sha: git(directory, "rev-parse", "HEAD"),
      anchor: { kind: "repo", path: "" },
    }),
  });
  assert.equal(r.status, 200);
  await server.close();
  let db = new DatabaseSync(join(state, "workflow.sqlite"));
  db.exec("PRAGMA user_version=0");
  db.close();
  server = await startRust(directory, { stateDirectory: state });
  assert.equal(
    (
      await (
        await fetch(server.url + "/api/workflow", {
          headers: { Authorization: "Bearer " + server.token },
        })
      ).json()
    ).comments[0].text,
    "Keep this note",
  );
  await server.close();
  db = new DatabaseSync(join(state, "workflow.sqlite"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  db.exec("PRAGMA user_version=999");
  const body = db.prepare("SELECT body FROM workflow").get().body;
  db.close();
  await assert.rejects(
    startRust(directory, { stateDirectory: state }),
    /newer Strata/,
  );
  db = new DatabaseSync(join(state, "workflow.sqlite"));
  assert.equal(db.prepare("SELECT body FROM workflow").get().body, body);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 999);
  db.close();
});
