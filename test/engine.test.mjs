import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Repository, command } from "./reference/engine.mjs";
import { createServer } from "./reference/server.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peekumi-test-"));
  const git = (...args) => command("git", ["-C", directory, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Peekumi Test");
  await git("config", "user.email", "test@example.invalid");
  async function put(file, text) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
  await put(
    "pkg/model.py",
    "LIMIT = 1\nclass Model:\n    value = 1\n    def run(self):\n        return self.value\n",
  );
  await put(
    "pkg/use.py",
    "from .model import Model\ndef go():\n    return Model().run()\n",
  );
  await put("web/src/lib/helper.ts", "export const answer = () => 42;\n");
  await put(
    "web/src/page.svelte",
    '<script lang="ts">\nimport { answer } from "$lib/helper";\nconst label = () => answer();\n</script>\n<h1>Hello 👋</h1>\n{@html `<script type="application/ld+json">${data}</script>`}\n',
  );
  await put("old.txt", "removed later\n");
  await put("script.sh", "echo test\n");
  await put(".env", "PRIVATE_VALUE=do-not-expose\n");
  await put("asset.png", Buffer.from([0, 1, 2, 0]));
  await git("add", ".");
  await git("commit", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")).toString().trim();
  await put(
    "pkg/model.py",
    "LIMIT = 2\nclass Model:\n    value = 2\n    def run(self):\n        return self.value\n",
  );
  await put(
    "web/src/page.svelte",
    '<script lang="ts">\nimport { answer } from "$lib/helper";\nconst label = () => answer();\n</script>\n<h1>Changed template 👋</h1>\n{@html `<script type="application/ld+json">${data}</script>`}\n',
  );
  await put("docs/new.md", "New documentation\n");
  await rm(path.join(directory, "old.txt"));
  await chmod(path.join(directory, "script.sh"), 0o755);
  await git("add", ".");
  await git("commit", "-m", "Change constants, template, mode and files");
  return {
    directory,
    git,
    put,
    base,
    repo: new Repository(directory, {
      python:
        process.env.PEEKUMI_PYTHON ||
        (process.platform === "darwin" ? "/usr/bin/python3" : "python3"),
    }),
  };
}

test("accounts for all Git changes, including class attributes, templates, modes and removals", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const data = await f.repo.compare(f.base, "HEAD");
  const files = new Map(data.files.map((file) => [file.path, file]));
  const gitChanged = (await f.git("diff", "--name-only", "-z", f.base, "HEAD"))
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    data.files
      .filter((file) => file.status !== "unchanged")
      .map((file) => file.path)
      .sort(),
    gitChanged,
  );
  assert.equal(
    files.get("pkg/model.py").symbols.find((s) => s.name === "Model").status,
    "changed",
  );
  assert.equal(
    files.get("pkg/model.py").symbols.find((s) => s.name === "Model.run")
      .status,
    "unchanged",
  );
  assert.equal(files.get("web/src/page.svelte").status, "changed");
  assert.equal(
    files.get("web/src/page.svelte").symbols.find((s) => s.name === "label")
      .status,
    "unchanged",
  );
  assert.deepEqual(files.get("pkg/use.py").deps, ["pkg/model.py"]);
  assert.deepEqual(files.get("web/src/page.svelte").deps, [
    "web/src/lib/helper.ts",
  ]);
  assert.equal(files.get("old.txt").status, "removed");
  const source = await f.repo.source(f.base, "HEAD", "pkg/model.py");
  assert.match(source.patch, /\+LIMIT = 2/);
  assert.equal((await f.repo.source(f.base, "HEAD", ".env")).after, null);
  assert.equal((await f.repo.source(f.base, "HEAD", "asset.png")).after, null);
  await assert.rejects(f.repo.resolve("--help"));
  assert.equal((await f.git("status", "--porcelain")).toString(), "");
});

test("parse failures and missing Python stay visible, and comparisons work in either direction", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  await f.put("broken.py", "def invalid(:\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Invalid Python");
  const data = await f.repo.compare(f.base, "HEAD");
  assert.match(
    data.files.find((f) => f.path === "broken.py").analysis,
    /parse error/,
  );
  const reverse = await f.repo.compare("HEAD", f.base);
  assert.equal(
    reverse.files.find((f) => f.path === "docs/new.md").status,
    "removed",
  );
  const repo = new Repository(f.directory, { python: "/missing-python" });
  const snapshot = await repo.snapshot("HEAD");
  assert.match(snapshot.files["pkg/model.py"].analysis, /Python unavailable/);
  assert.match(snapshot.files["pkg/model.py"].source, /LIMIT/);
});

test("API requires auth, rejects cross-origin pairing, and serves source through a session", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const server = createServer(f.repo, { token: "a".repeat(64), base: f.base });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + "/api/repo")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/session", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ token: "a".repeat(64) }),
      })
    ).status,
    403,
  );
  const login = await fetch(url + "/api/session", {
    method: "POST",
    body: JSON.stringify({ token: "a".repeat(64) }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const response = await fetch(url + "/api/compare", { headers: { cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.ok(
    data.files
      .flatMap((file) => file.symbols)
      .every((symbol) => !("hash" in symbol)),
  );
  const plain = await fetch(url + "/api/compare", {
    headers: { cookie, "Accept-Encoding": "gzip;q=0, identity" },
  });
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.deepEqual(await plain.json(), data);
  assert.ok(
    Number(response.headers.get("content-length")) <
      Number(plain.headers.get("content-length")) / 2,
  );
  const html = await fetch(url + "/", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(html.headers.get("content-encoding"), "gzip");
  assert.match(await html.text(), /Peekumi/);
  assert.equal(
    data.files.find((f) => f.path === "docs/new.md").status,
    "added",
  );
  assert.equal(
    (await fetch(url + "/api/runs", { method: "POST", headers: { cookie } }))
      .status,
    405,
  );
});

test("declaration metadata is revision-specific, lazy, and never inferred", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  await f.put(
    "documented.py",
    `"""Repository services."""
class Service(Base):
    """Handles a request."""
    count: int
    async def run(self, value: str, /, limit: int = 3, *items: str, strict: bool = False, **options: str) -> list[str]:
        """Run the service."""
        return []
`,
  );
  await f.put(
    "documented.ts",
    `/** @module Typed services. */
/** A service. */
export class Service extends Base {
  count: number;
  /** Runs a request.
   * @param value Request input.
   * @returns Returned results.
   */
  async run<T>(value: T, limit = 3): Promise<T[]> { return []; }
}
/** A JS-compatible function.
 * @param {string} value Input text.
 * @returns {number} Text length.
 */
export const length = (value) => value.length;
/** A record. */
export interface Result { name?: string; }
`,
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Document declarations");
  const documented = await f.repo.resolve("HEAD");
  const py = (await f.repo.source(f.base, documented, "documented.py")).details;
  assert.equal(py.before, null);
  assert.equal(py.after.description, "Repository services.");
  const method = py.after.symbols.find((s) => s.name === "Service.run");
  assert.equal(method.description, "Run the service.");
  assert.equal(method.returns, "list[str]");
  assert.equal(method.async, true);
  assert.equal(method.parameters[1].kind, "positional-only");
  assert.equal(method.parameters[2].default, "3");
  assert.equal(method.parameters[4].kind, "keyword-only");
  assert.equal(method.parameters[0].type, null);
  assert.deepEqual(py.after.symbols[0].fields, [
    { name: "count", type: "int" },
  ]);
  assert.deepEqual(py.after.symbols[0].bases, ["Base"]);
  const ts = (await f.repo.source(f.base, documented, "documented.ts")).details
    .after;
  assert.match(ts.description, /Typed services/);
  const run = ts.symbols.find((s) => s.name === "Service.run");
  assert.equal(run.description, "Runs a request.");
  assert.equal(run.parameters[0].type, "T");
  assert.equal(run.parameters[0].description, "Request input.");
  assert.equal(run.parameters[1].type, null);
  assert.equal(run.returns, "Promise<T[]>");
  assert.match(run.signature, /run<T>/);
  const length = ts.symbols.find((s) => s.name === "length");
  assert.equal(length.parameters[0].type, "string");
  assert.equal(length.returns, "number");
  assert.deepEqual(ts.symbols.find((s) => s.name === "Result").fields, [
    { name: "name", type: "string", optional: true },
  ]);
  const comparison = await f.repo.compare(f.base, documented);
  assert.ok(!JSON.stringify(comparison).includes("Run the service."));
  assert.ok(!JSON.stringify(comparison).includes("Request input."));
  await f.put(
    "documented.py",
    '"""Updated services."""\ndef run():\n    return None\n',
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Update declarations");
  const versions = (await f.repo.source(documented, "HEAD", "documented.py"))
    .details;
  assert.equal(versions.before.description, "Repository services.");
  assert.equal(versions.after.description, "Updated services.");
  assert.equal(versions.after.symbols[0].returns, null);
});

test("blob index persists across restarts, reuses unchanged syntax, and resolves moved imports per snapshot", async (t) => {
  const f = await fixture();
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "peekumi-index-"));
  t.after(async () => {
    await rm(f.directory, { recursive: true, force: true });
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  const options = { python: f.repo.python, cacheDirectory };
  const indexed = new Repository(f.directory, options);
  const expected = await f.repo.compare(f.base, "HEAD");
  assert.deepEqual(await indexed.compare(f.base, "HEAD"), expected);
  assert.ok(indexed.metrics().parsed > 0);
  assert.ok(indexed.metrics().reused > 0);
  indexed.close();
  const restarted = new Repository(f.directory, options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.compare(f.base, "HEAD"), expected);
  assert.equal(
    restarted.metrics().parsed,
    0,
    "A fresh repository instance uses persisted syntax",
  );
  const head = await restarted.resolve("HEAD");
  await f.put(
    "other/use.py",
    "from .model import Model\ndef go():\n    return Model().run()\n",
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Reuse syntax at a different path");
  const next = await restarted.compare(head, "HEAD");
  assert.equal(
    restarted.metrics().parsed,
    0,
    "Identical blob at new path is not reparsed",
  );
  assert.deepEqual(next.files.find((f) => f.path === "other/use.py").deps, []);
  assert.deepEqual(next.files.find((f) => f.path === "pkg/use.py").deps, [
    "pkg/model.py",
  ]);
  const old = await restarted.snapshot(head);
  assert.deepEqual(
    old.files["pkg/use.py"].imports[0].resolved,
    ["pkg/model.py"],
    "Resolving another path never mutates cached snapshots",
  );
  await f.put("other/model.py", "class Model:\n    pass\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Add target");
  const added = await restarted.compare(head, "HEAD");
  assert.equal(restarted.metrics().parsed, 1, "Only new content is parsed");
  assert.deepEqual(added.files.find((f) => f.path === "other/use.py").deps, [
    "other/model.py",
  ]);
  assert.equal((await f.git("status", "--porcelain")).toString(), "");
});

test("overview preserves every file and edge while symbols and imports arrive with file details", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const full = await f.repo.compare(f.base, "HEAD");
  const overview = await f.repo.compare(f.base, "HEAD", { view: "overview" });
  assert.equal(overview.files.length, full.files.length);
  for (let i = 0; i < full.files.length; i++) {
    const a = full.files[i],
      b = overview.files[i];
    assert.equal(b.path, a.path);
    assert.equal(b.status, a.status);
    assert.deepEqual(b.deps, a.deps);
    assert.deepEqual(b.beforeDeps, a.beforeDeps);
    assert.equal(b.symbolCount, a.symbols.length);
    assert.ok(!("symbols" in b));
    assert.ok(!("imports" in b));
    const source = await f.repo.source(f.base, "HEAD", a.path);
    assert.deepEqual(source.symbols, a.symbols);
    assert.deepEqual(source.imports, a.imports);
  }
  const server = createServer(f.repo, { token: "overview-test", base: f.base });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    "http://127.0.0.1:" + server.address().port + "/api/compare?view=overview",
    { headers: { Authorization: "Bearer overview-test" } },
  );
  assert.deepEqual(await response.json(), overview);
});

test("worker-backed repository preserves API results and reports failures without hanging", async (t) => {
  const { RepositoryClient } = await import("./reference/repository-client.mjs");
  const f = await fixture();
  const worker = new RepositoryClient(f.directory, { python: f.repo.python });
  t.after(async () => {
    await worker.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  assert.deepEqual(
    await worker.compare(f.base, "HEAD", { view: "overview" }),
    await f.repo.compare(f.base, "HEAD", { view: "overview" }),
  );
  assert.deepEqual(
    await worker.source(f.base, "HEAD", "pkg/model.py"),
    await f.repo.source(f.base, "HEAD", "pkg/model.py"),
  );
  await assert.rejects(worker.resolve("--help"), /Invalid Git revision/);
  const pending = worker.compare(f.base, "HEAD");
  const rejected = assert.rejects(pending, /stopped/);
  await worker.close();
  await rejected;
  await assert.rejects(worker.metadata(), /stopped/);
});

test("an unavailable persistent index falls back to memory without losing analysis", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const blocker = path.join(f.directory, "index-blocker");
  await writeFile(blocker, "not a directory");
  const repo = new Repository(f.directory, {
    python: f.repo.python,
    cacheDirectory: blocker,
  });
  t.after(() => repo.close());
  assert.deepEqual(
    await repo.compare(f.base, "HEAD"),
    await f.repo.compare(f.base, "HEAD"),
  );
  assert.ok(repo.metrics().reused > 0);
});
