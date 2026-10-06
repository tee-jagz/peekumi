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

test("Tailscale share failures print the cause and both recovery paths without changing state", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "peekumi-share-tailscale-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ repositories: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const original = JSON.stringify({ version: 1, repositories: [], port: server.address().port, secureCookie: false, publicUrl: "https://existing.example" });
  await writeFile(join(state, "config.json"), original);
  await writeFile(join(state, "access-token"), "fixture-token");
  const signedIn = JSON.stringify({ Self: { DNSName: "machine.example." } });
  const ok = (stdout) => ({ status: 0, stdout });
  const cases = [
    { name: "missing CLI", responses: [{ error: { message: "spawnSync tailscale ENOENT" } }], cause: /Cannot run tailscale: spawnSync tailscale ENOENT/ },
    { name: "daemon unavailable", responses: [{ status: 1, stderr: "failed to connect to local tailscaled" }], cause: /tailscale: failed to connect to local tailscaled/ },
    { name: "signed out", responses: [ok("{}")], cause: /Sign into Tailscale first/ },
    { name: "malformed status", responses: [ok("invalid JSON")], cause: /JSON/ },
    { name: "Serve status failure", responses: [ok(signedIn), { status: 1, stderr: "cannot read Serve configuration" }], cause: /tailscale: cannot read Serve configuration/ },
    { name: "existing Serve configuration", responses: [ok(signedIn), ok('{"Proxy":"http://127.0.0.1:9999"}')], cause: /Tailscale Serve already has another configuration/ },
    { name: "exposure denied", responses: [ok(signedIn), ok("{}"), { status: 1, stderr: "HTTPS is not enabled in the tailnet" }], cause: /tailscale: HTTPS is not enabled in the tailnet/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      // Exercise the real provider and CLI; intercept subprocesses so the test
      // cannot expose a tunnel or invoke an OS service manager even on regression.
      const mock = `import { appendFileSync } from 'node:fs';
        const responses = ${JSON.stringify(scenario.responses)};
        export function spawnSync(program, args) {
          appendFileSync(${JSON.stringify(join(state, "calls"))}, JSON.stringify([program, ...args]) + '\\n');
          if (program !== 'tailscale' || !responses.length) throw new Error('Unexpected subprocess: ' + program);
          return responses.shift();
        }
        export function spawn() { throw new Error('Unexpected background process'); }`;
      const loader = join(state, "loader.mjs");
      await writeFile(loader, `export async function load(url, context, next) {
        if (url === 'node:child_process') return {format: 'module', shortCircuit: true, source: ${JSON.stringify(mock)}};
        if (url.endsWith('/scripts/tunnel/cloudflare.mjs')) return {format: 'module', shortCircuit: true, source: "export function createCloudflareProvider() { throw new Error('Unexpected public fallback'); }"};
        return next(url, context);
      }`);
      for (const flags of [[], ["--tunnel", "tailscale"]]) {
        await writeFile(join(state, "calls"), "");
        const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, "scripts/manage.mjs", "share", ...flags], {
          env: { ...process.env, PEEKUMI_HOME: state }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
        });
        t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
        let output = "";
        let errors = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { errors += chunk; });
        assert.equal((await once(child, "close"))[0], 1, errors);
        assert.equal(output, "");
        assert.match(errors, /Tailscale sharing is not ready:/);
        assert.match(errors, scenario.cause);
        assert.match(errors, /Install Tailscale on this host and your phone/);
        assert.match(errors, /sign into the same tailnet/);
        assert.match(errors, /tailscale status/);
        assert.match(errors, /Enable tailnet HTTPS/);
        assert.match(errors, /tailscale serve status/);
        assert.match(errors, /Retry peekumi share, then run peekumi pair/);
        assert.match(errors, /peekumi share --tunnel cloudflare/);
        assert.match(errors, /PUBLIC temporary URL/);
        assert.match(errors, /keep pairing links private/);
        assert.doesNotMatch(errors, /Unexpected (subprocess|background process|public fallback)/);
        assert.equal(await readFile(join(state, "config.json"), "utf8"), original);
        assert.equal(await readFile(join(state, "access-token"), "utf8"), "fixture-token");
        const calls = (await readFile(join(state, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(calls, [
          ["tailscale", "status", "--json"],
          ["tailscale", "serve", "status", "--json"],
          ["tailscale", "serve", "--bg", `http://127.0.0.1:${server.address().port}`],
        ].slice(0, scenario.responses.length));
        assert.deepEqual((await readdir(state)).sort(), ["access-token", "calls", "config.json", "loader.mjs"]);
      }
    });
  }
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

test("install.sh downloads a public release with no token: it asks the API for the file itself", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "peekumi-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir, chmod } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  // A small bundle whose `peekumi upgrade <prefix>` records that it ran.
  const bundle = join(dir, "build", "peekumi-0.0.0-test");
  await mkdir(join(bundle, "bin"), { recursive: true });
  await writeFile(join(bundle, "bin", "peekumi"), `#!/bin/sh\nmkdir -p "$2/bin" && cp "$0" "$2/bin/peekumi" && echo "$1" > "${dir}/ran"\n`);
  await chmod(join(bundle, "bin", "peekumi"), 0o755);
  const archive = join(dir, "archive.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", join(dir, "build"), "peekumi-0.0.0-test"]).status, 0);
  const sum = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(join(dir, "archive.sha256"), `${sum}  archive\n`);
  // The release lists an archive for each platform; asset ids 1 (archive) and 2 (checksum).
  const assets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].flatMap((p) => [
    `{"url": "https://api.github.com/repos/o/r/releases/assets/1", "name": "peekumi-0.0.0-${p}.tar.gz"}`,
    `{"url": "https://api.github.com/repos/o/r/releases/assets/2", "name": "peekumi-0.0.0-${p}.tar.gz.sha256"}`,
  ]);
  await writeFile(join(dir, "release.json"), `{"tag_name": "v0.0.0", "assets": [${assets.join(", ")}]}`);
  // A fake curl, as GitHub's API answers: an asset URL sends the file only with
  // "Accept: application/octet-stream", and a JSON description without it.
  const bin = join(dir, "fake-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh
out=""; url=""; accept=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -H) case "$2" in "Accept: application/octet-stream") accept=1 ;; esac; shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
case "$url" in
  */releases/latest) src="${dir}/release.json" ;;
  */assets/1) [ -n "$accept" ] && src="${dir}/archive.tar.gz" || src="${dir}/release.json" ;;
  */assets/2) [ -n "$accept" ] && src="${dir}/archive.sha256" || src="${dir}/release.json" ;;
  *) exit 22 ;;
esac
cp "$src" "$out"
`,
  );
  await chmod(join(bin, "curl"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PEEKUMI_PREFIX: join(dir, "lib"), PEEKUMI_BIN: join(dir, "links"), PEEKUMI_REPO: "o/r" };
  delete env.GITHUB_TOKEN;
  delete env.PEEKUMI_VERSION;
  const run = spawnSync("sh", ["install.sh"], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await readFile(join(dir, "ran"), "utf8")).trim(), "upgrade", "The verified bundle installed itself");
  assert.match(run.stdout, /Linked .*peekumi/);
});
