import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture } from "./workflow-support.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function integrationFixture(t) {
  const f = await fixture({
    files: { ".peekumi.json": '{"version":1,"groups":{},"rules":[]}' },
  });
  t.after(() => f.close());
  const directory = await realpath(f.dir);
  await writeFile(
    path.join(f.state, "config.json"),
    JSON.stringify({ version: 1, repositories: [directory] }),
  );
  const cli = (...args) =>
    spawnSync(process.execPath, ["scripts/manage.mjs", "token", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PEEKUMI_HOME: f.state },
    });
  const created = cli(
    "create",
    "--name",
    "hermes",
    "--repo",
    path.basename(directory),
  );
  assert.equal(created.status, 0, created.stderr);
  const token = created.stdout.trim();
  assert.match(token, /^pki_[a-f0-9]{64}$/);
  const repo = (await f.req("/api/repositories")).repositories[0].id;
  const req = async (
    route,
    body,
    { method = body ? "POST" : "GET", bearer = token, headers = {} } = {},
  ) => {
    const response = await fetch(f.server.url + route, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { code: response.status, value: await response.json() };
  };
  return {
    ...f,
    get server() {
      return f.server;
    },
    cli,
    token,
    repo,
    integration: req,
  };
}

test("integration credentials are hashed, scoped to the five endpoints and revoked without restart", async (t) => {
  const f = await integrationFixture(t);
  const saved = await readFile(
    path.join(f.state, "integration-tokens.json"),
    "utf8",
  );
  assert.equal(saved.includes(f.token), false);
  const listing = f.cli("list");
  assert.deepEqual(JSON.parse(listing.stdout), [
    { name: "hermes", repository: f.repo },
  ]);
  assert.equal(f.cli("create", "--name", "hermes", "--repo", f.repo).status, 1);
  for (const route of ["baseline", "coverage", "impact", "map", "export"]) {
    const post = ["baseline", "coverage"].includes(route);
    const result = await f.integration(
      `/api/integrations/${route}?repo=another`,
      post ? { repo: "another" } : undefined,
    );
    assert.equal(result.code, 403, route);
  }
  for (const route of [
    "/api/repo",
    "/api/compare",
    "/api/source",
    "/api/repositories",
    "/api/workflow",
    "/api/devices",
  ]) {
    assert.equal((await f.integration(route)).code, 403, route);
  }
  const writeRoutes = [
    "/api/ask",
    "/api/repositories",
    "/api/devices/x",
    "/api/rules/propose",
    "/api/rules/check",
    "/api/rules/audit/x",
    "/api/fixes/propose",
    "/api/ask/history",
    "/api/comments",
    "/api/comments/x",
    "/api/runs/preview",
    "/api/runs/dispatch",
    "/api/runs/x",
    "/api/runs/x/merge",
    "/api/runs/x/undo",
    "/api/runs/x/update",
    "/api/runs/x/verify",
    "/api/push/register",
    "/api/agents/sessions",
    "/api/prs",
    "/api/session",
    "/mcp/ask",
  ];
  for (const route of writeRoutes) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await f.integration(route, { token: f.token }, { method });
      assert.ok(result.code >= 400, `${method} ${route}`);
    }
  }
  assert.equal((await f.req("/api/repo")).status, 200);
  const reader = (
    await readFile(path.join(f.state, "read-only/access-token"), "utf8")
  ).trim();
  assert.equal(
    (await f.integration("/api/repo", undefined, { bearer: reader })).code,
    200,
  );
  assert.equal(
    (
      await f.integration(
        "/api/comments",
        { text: "Refused" },
        { bearer: reader },
      )
    ).code,
    403,
  );
  assert.equal(f.cli("revoke", "hermes").status, 0);
  const revoked = await f.integration(
    `/api/integrations/impact?repo=${f.repo}&baseline=x`,
  );
  assert.equal(revoked.code, 401);
  assert.deepEqual(JSON.parse(f.cli("list").stdout), []);
});

test("scoped baseline keeps dirty paths and frozen rules across a commit, restart and retries", async (t) => {
  const f = await integrationFixture(t);
  await writeFile(path.join(f.dir, "module.py"), "def run():\n    return 2\n");
  const body = {
    repo: f.repo,
    profile: "default",
    session: "session-one",
    turn: "turn-one",
  };
  const first = await f.integration("/api/integrations/baseline", body);
  assert.equal(first.code, 200);
  assert.equal(first.value.status, "incomplete");
  assert.deepEqual(first.value.already_changed, ["module.py"]);
  await f.git("add", ".");
  await f.git("commit", "-m", "Mid-turn commit");
  await writeFile(path.join(f.dir, ".peekumi.json"), "{}");
  await f.restart();
  const retry = await f.integration("/api/integrations/baseline", body);
  assert.equal(retry.value.sha, first.value.sha);
  assert.equal(retry.value.rules_sha, first.value.rules_sha);
  assert.deepEqual(retry.value.already_changed, first.value.already_changed);
  const wrong = await f.integration("/api/integrations/baseline", body, {
    headers: { "X-Peekumi-Repository": "other" },
  });
  assert.equal(wrong.code, 403);
  const browser = await f.integration("/api/integrations/baseline", body, {
    headers: { Origin: "https://evil.invalid" },
  });
  assert.equal(browser.code, 403);
  assert.equal(
    (
      await f.integration("/api/integrations/baseline", {
        ...body,
        action: "release",
      })
    ).code,
    200,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(f.state, "integration-baselines.json"), "utf8"),
    ),
    {},
  );
});
