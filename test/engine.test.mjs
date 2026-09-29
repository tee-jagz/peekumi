import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Repository, command } from "../src/engine.mjs";
import { createServer } from "../src/server.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "strata-test-"));
  const git = (...args) => command("git", ["-C", directory, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Strata Test");
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
        process.env.STRATA_PYTHON ||
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
  assert.match(await html.text(), /Repo Strata/);
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
