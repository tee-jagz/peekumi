import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
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

test("share rejects malformed provider flags before state or network access", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "peekumi-share-flags-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  for (const args of [["share", "cloudflare"], ["share", "--tunnel"], ["share", "--tunnel", "unknown"], ["doctor", "--tunnel", "cloudflare"], ["start", "--tunnel=cloudflare"]]) {
    const result = spawnSync(process.execPath, ["scripts/manage.mjs", ...args], {
      encoding: "utf8", env: { ...process.env, PEEKUMI_HOME: state },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--tunnel/);
  }
  assert.deepEqual(await readdir(state), []);
});

test("explicit Cloudflare share warns, prints a temporary pairing link and closes on SIGINT without persisting its URL", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "peekumi-share-cloudflare-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ repositories: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const original = { version: 1, repositories: [], port: server.address().port, secureCookie: true, publicUrl: "https://private.tailnet.example" };
  await writeFile(join(state, "config.json"), JSON.stringify(original));
  await writeFile(join(state, "access-token"), "fixture-token");
  // Isolate network exposure while exercising the real manager's warning, token,
  // signal and persistence behavior. Provider/download behavior has separate tests.
  const mock = `import { writeFile } from 'node:fs/promises';
    export function createCloudflareProvider({state}) {
      let done;
      let keepAlive;
      return {
        status: () => ({}),
        async expose(port, status, {signal}) {
          keepAlive = setInterval(() => {}, 1000);
          status.done = new Promise(resolve => { done = resolve; });
          signal.addEventListener('abort', () => done({signal: 'SIGTERM'}), {once: true});
        },
        url: () => 'https://fixture.trycloudflare.com',
        close: () => { clearInterval(keepAlive); return writeFile(state + '/closed', 'yes'); },
      };
    }`;
  const loader = join(state, "loader.mjs");
  await writeFile(loader, `export async function load(url, context, next) {
    if (url.endsWith('/scripts/tunnel/cloudflare.mjs')) return {format: 'module', shortCircuit: true, source: ${JSON.stringify(mock)}};
    return next(url, context);
  }`);
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, "scripts/manage.mjs", "share", "--tunnel", "cloudflare"], {
    env: { ...process.env, PEEKUMI_HOME: state }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("share never became ready: " + errors)), 5000);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("Ctrl+C")) { clearTimeout(timer); resolve(); }
    });
    child.on("error", reject);
  });
  assert.match(errors, /URL is PUBLIC/);
  assert.match(output, /https:\/\/fixture.trycloudflare.com\/#token=fixture-token/);
  assert.match(output, /next run gets a new URL/);
  child.kill("SIGINT");
  assert.equal((await closed)[0], 0);
  assert.equal(await readFile(join(state, "closed"), "utf8"), "yes");
  assert.deepEqual(JSON.parse(await readFile(join(state, "config.json"), "utf8")), original);
});
