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
  const root = await mkdtemp(join(tmpdir(), "peekumi-setup-"));
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
  const scoped = { "X-Peekumi-Repository": second.id };
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
        headers: { "X-Peekumi-Repository": "../one" },
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
  assert.ok(!sw.includes("__PEEKUMI_BUILD__"));
  assert.match(sw, /!SHELL.includes/);
  assert.equal(
    (await request("/api/repo")).headers.get("cache-control"),
    "no-store",
  );
});
test("PR comparison fetches private refs and uses merge base without touching dirty checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekumi-pr-"));
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
    extraEnv: { PEEKUMI_GH: gh, GIT_CONFIG_GLOBAL: config },
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
  assert.equal(git(dir, "rev-parse", "refs/peekumi/pr/7/head"), head);
  // After a reload, the sheet reads the PR's details again without a new fetch.
  const details = await fetch(server.url + "/api/prs/7", {
    headers: { Authorization: "Bearer " + server.token },
  });
  assert.equal(details.status, 200);
  assert.equal((await details.json()).title, "Change run");
  assert.equal(
    (await fetch(server.url + "/api/prs/x", { headers: { Authorization: "Bearer " + server.token } })).status,
    400,
  );
  // A merged PR keeps the base it had while main moves on; it still opens, compared with
  // that base, and does not report a change during the fetch.
  git(dir, "stash");
  await writeFile(join(dir, "NEWS.md"), "after the merge");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "main moves on");
  git(dir, "push", "-q", remote, "main");
  git(dir, "stash", "pop");
  const merged = join(bin, "github-merged.sh");
  await writeFile(
    merged,
    (await readFile(gh, "utf8")).replace(prData, JSON.stringify({ ...JSON.parse(prData), state: "MERGED" })),
  );
  await chmod(merged, 0o755);
  const later = await startRust(dir, {
    extraEnv: { PEEKUMI_GH: merged, GIT_CONFIG_GLOBAL: config },
  });
  t.after(() => later.close());
  const m = await fetch(later.url + "/api/prs/open", {
    method: "POST",
    headers: { Authorization: "Bearer " + later.token, "Content-Type": "application/json" },
    body: JSON.stringify({ number: 7 }),
  });
  const opened = await m.json();
  assert.equal(m.status, 200, JSON.stringify(opened));
  assert.deepEqual([opened.base, opened.head], [common, head]);
  assert.notEqual(git(dir, "rev-parse", "refs/peekumi/pr/7/base"), base, "main moved on after the merge");
});

test("workflow migration retains comments and refuses newer schemas", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "peekumi-migrate-"));
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
    /newer Peekumi/,
  );
  db = new DatabaseSync(join(state, "workflow.sqlite"));
  assert.equal(db.prepare("SELECT body FROM workflow").get().body, body);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 999);
  db.close();
});

test("settings and sessions from before the rename keep working", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekumi-former-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = await repo(root, "one");
  // Only STRATA_* names are set: the server adopts them for its PEEKUMI_* settings.
  const server = await startRust(dir, { base: "HEAD", prefix: "STRATA_", token: "former-token" });
  t.after(() => server.close());
  const authorized = await fetch(server.url + "/api/repo", {
    headers: { Authorization: "Bearer former-token" },
  });
  assert.equal(authorized.status, 200, "STRATA_TOKEN still authenticates");
  const paired = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "former-token" }),
  });
  const [cookie] = paired.headers.get("set-cookie").split(";");
  assert.match(cookie, /^peekumi_session_[0-9a-f]+=/);
  const former = cookie.replace(/^peekumi_session_/, "strata_session_");
  const signedIn = await fetch(server.url + "/api/repo", { headers: { Cookie: former } });
  assert.equal(signedIn.status, 200, "A cookie saved before the rename still signs in");
  // A stale former cookie sent first must not shadow the fresh one.
  const both = await fetch(server.url + "/api/repo", {
    headers: { Cookie: former.replace(/=.*/, "=stale") + "; " + cookie },
  });
  assert.equal(both.status, 200, "The current cookie wins over a stale former one");
});

test("moving the state folder keeps devices signed in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekumi-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = await repo(root, "one");
  const before = join(root, "state-before"),
    after = join(root, "state-after");
  const first = await startRust(dir, { base: "HEAD", stateDirectory: before, isolatePrimary: true });
  const paired = await fetch(first.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rust-test-token" }),
  });
  const [cookie] = paired.headers.get("set-cookie").split(";");
  await first.close();
  const { rename } = await import("node:fs/promises");
  await rename(before, after);
  const second = await startRust(dir, { base: "HEAD", stateDirectory: after, isolatePrimary: true });
  t.after(() => second.close());
  const response = await fetch(second.url + "/api/repo", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200, "The saved session works from the moved folder");
});

test("the owner adds and removes repositories while the server runs; paired devices cannot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekumi-hot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await repo(root, "one"),
    b = await repo(root, "two"),
    state = join(root, "state");
  const server = await startRust(a, { base: "HEAD", stateDirectory: state, isolatePrimary: true });
  t.after(() => server.close());
  const owner = (path, options = {}) =>
    fetch(server.url + path, {
      ...options,
      headers: { Authorization: "Bearer " + server.token, ...options.headers },
    });
  const add = (headers) =>
    fetch(server.url + "/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ path: b }),
    });
  const paired = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: server.token }),
  });
  const [cookie] = paired.headers.get("set-cookie").split(";");
  assert.equal((await add({ Cookie: cookie })).status, 403, "A paired device cannot add a repository");
  let r = await add({ Authorization: "Bearer " + server.token });
  assert.equal(r.status, 200);
  const added = await r.json();
  assert.deepEqual([added.name, added.added], ["two", true]);
  assert.equal((await (await add({ Authorization: "Bearer " + server.token })).json()).added, false);
  const listed = (await (await owner("/api/repositories")).json()).repositories;
  assert.deepEqual(listed.map((r) => r.name).sort(), ["one", "two"]);
  const scoped = await owner("/api/repo", { headers: { "X-Peekumi-Repository": added.id } });
  assert.equal(scoped.status, 200);
  assert.equal((await scoped.json()).name, "two");
  const primary = listed.find((r) => r.default);
  assert.equal((await owner("/api/repositories/" + primary.id, { method: "DELETE" })).status, 409);
  assert.equal(
    (await fetch(server.url + "/api/repositories/" + added.id, { method: "DELETE", headers: { Cookie: cookie } })).status,
    403,
  );
  assert.equal((await owner("/api/repositories/" + added.id, { method: "DELETE" })).status, 200);
  const gone = await owner("/api/repo", { headers: { "X-Peekumi-Repository": added.id } });
  assert.equal(gone.status, 404);
  // Its state folder lock was released, so it can come straight back.
  r = await add({ Authorization: "Bearer " + server.token });
  assert.equal((await r.json()).added, true);
  const missing = await owner("/api/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: join(root, "missing") }),
  });
  assert.equal(missing.status, 400);
});

test("each repository keeps its Ask conversation for the owner across restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekumi-ask-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await repo(root, "one"),
    b = await repo(root, "two"),
    state = join(root, "state");
  const start = () =>
    startRust(a, { base: "HEAD", repositories: [b], stateDirectory: state, isolatePrimary: true });
  let server = await start();
  t.after(() => server.close());
  const owner = (path, options = {}) =>
    fetch(server.url + path, {
      ...options,
      headers: { Authorization: "Bearer " + server.token, ...options.headers },
    });
  const { repositories } = await (await owner("/api/repositories")).json();
  const two = { "X-Peekumi-Repository": repositories.find((r) => r.name === "two").id };
  assert.deepEqual(await (await owner("/api/ask/history", { headers: two })).json(), {
    messages: [],
  });
  const messages = [
    { role: "user", text: "What does run do?", subject: "run" },
    { role: "assistant", text: "It returns 1.", references: {}, lookups: [] },
  ];
  const put = (body, headers = two) =>
    owner("/api/ask/history", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ messages })).status, 200);
  assert.equal((await put({ messages: [{ role: "system", text: "x" }] })).status, 400);
  await server.close();
  server = await start();
  assert.deepEqual(
    (await (await owner("/api/ask/history", { headers: two })).json()).messages,
    messages,
    "The conversation survives a restart",
  );
  assert.deepEqual(
    (await (await owner("/api/ask/history")).json()).messages,
    [],
    "Another repository has its own conversation",
  );
  // Each branch has its own conversation; the watched branch is the default.
  const other = (method, body) =>
    owner("/api/ask/history?branch=" + encodeURIComponent("refs/heads/peekumi/run-1"), {
      method,
      headers: { ...two, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.deepEqual((await (await other("GET")).json()).messages, []);
  assert.equal((await other("PUT", { messages: [messages[0]] })).status, 200);
  assert.deepEqual((await (await other("GET")).json()).messages, [messages[0]]);
  assert.deepEqual(
    (await (await owner("/api/ask/history?branch=refs%2Fheads%2Fmain", { headers: two })).json()).messages,
    messages,
    "The watched branch keeps its own conversation",
  );
  // A conversation saved before conversations were kept per branch belongs to the watched branch.
  const one = repositories.find((r) => r.name === "one").id;
  await writeFile(
    join(state, "repositories", one, "ask-history.json"),
    JSON.stringify({ messages: [{ role: "user", text: "Saved before branches" }] }),
  );
  assert.deepEqual((await (await owner("/api/ask/history")).json()).messages, [
    { role: "user", text: "Saved before branches" },
  ]);
  const reader = (await readFile(join(state, "read-only/access-token"), "utf8")).trim();
  const r = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: reader, name: "Reader" }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(server.url + "/api/ask/history", { headers: { Cookie: cookie, ...two } })).status,
    403,
    "Read-only devices cannot read the owner's conversation",
  );
});
