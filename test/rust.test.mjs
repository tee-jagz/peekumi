import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  symlink,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Repository, command } from "./reference/engine.mjs";
import { startRust, rustRpc } from "./rust-support.mjs";
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "strata-parity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => command("git", ["-C", directory, ...args]);
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Strata Test");
  await git("config", "user.email", "test@example.invalid");
  await put(
    "pkg/model.py",
    '"""Models."""\nclass Model:\n    """A model."""\n    value: int = 1\n    def run(self, value: str, /, *, limit: int = 3) -> str:\n        """Run it."""\n        return value\n',
  );
  await put(
    "pkg/use.py",
    'from .model import Model\ndef go():\n    return Model().run("ok")\n',
  );
  await put(
    "web/src/lib/model.ts",
    "/** @module Models. */\n/** A typed model. */\nexport class Model {\n/** Run input.\n * @param input The input.\n * @returns The result.\n */\nrun<T>(input: T): T {return input;}\n}\n",
  );
  await put(
    "web/src/page.svelte",
    '<script lang="ts">\nimport {Model} from "$lib/model";\nconst run = (value: string): string => value;\n</script>\n<h1>Hello 👋</h1>\n<script type="application/ld+json">{"a":1}</script>\n',
  );
  await put(".env", "DO_NOT_EXPOSE=private\n");
  await put("binary.png", Buffer.from([0, 1, 2]));
  await put("large.txt", "x".repeat(512 * 1024 + 1));
  await put("old.txt", "removed");
  await put("\u{10000}.txt", "supplementary filename");
  await put("\uE000.txt", "BMP filename");
  await put(
    "unicode.ts",
    "/** " +
      "😀".repeat(20000) +
      " */\nexport function unicode(): string { return '😀'; }\n",
  );
  await put("script.sh", "echo unused\n");
  await put("broken.py", "def invalid(:\n");
  await put("odd [name].txt", "before");
  await symlink("pkg/model.py", path.join(directory, "link.py"));
  await git("add", ".");
  await git("commit", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")).toString().trim();
  await put(
    "pkg/model.py",
    (await readFile(path.join(directory, "pkg/model.py"), "utf8"))
      .replace("value: int = 1", "value: int = 2")
      .replace("limit: int = 3", "limit: int = 4"),
  );
  await put(
    "other/use.py",
    'from .model import Model\ndef go():\n    return Model().run("ok")\n',
  );
  await put("new.md", "new");
  await rm(path.join(directory, "old.txt"));
  await chmod(path.join(directory, "script.sh"), 0o755);
  await put("odd [name].txt", "after");
  await git("add", ".");
  await git("commit", "-m", "Changes");
  return {
    directory,
    git,
    base,
    repo: new Repository(directory, {
      python: process.env.STRATA_PYTHON || "/usr/bin/python3",
    }),
  };
}
test("Rust full/overview/source/metadata match the Node reference, including reverse comparisons", async (t) => {
  const f = await fixture(t);
  const server = await startRust(f.directory, { base: f.base });
  t.after(() => server.close());
  const get = async (route) => {
    const r = await fetch(server.url + route, {
      headers: { Authorization: "Bearer " + server.token },
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const metadata = await get("/api/repo");
  assert.ok(metadata.branches.some((b) => b.ref === "refs/heads/main"));
  assert.equal(metadata.selectedBranch.ref, "refs/heads/main");
  const { branches, selectedBranch, ...identity } = metadata;
  assert.deepEqual(identity, {
    ...(await f.repo.metadata()),
    initialBase: f.base,
    initialHead: await f.repo.resolve("HEAD"),
  });
  for (const [base, head] of [
    [f.base, "HEAD"],
    ["HEAD", f.base],
    ["HEAD", "HEAD"],
  ]) {
    const q = new URLSearchParams({ base, head });
    const expected = await f.repo.compare(base, head);
    assert.deepEqual(await get("/api/compare?" + q), expected);
    assert.deepEqual(
      await get("/api/compare?" + q + "&view=overview"),
      await f.repo.compare(base, head, { view: "overview" }),
    );
    for (const file of expected.files)
      assert.deepEqual(
        await get(
          "/api/source?" + q + "&path=" + encodeURIComponent(file.path),
        ),
        await f.repo.source(base, head, file.path),
        file.path,
      );
  }
  const previous = await get(
    "/api/compare?base=" + f.base + "&head=HEAD&view=overview",
  );
  await writeFile(path.join(f.directory, "new.md"), "updated");
  await f.git("add", ".");
  await f.git("commit", "-m", "Advance HEAD");
  const next = await get(
    "/api/compare?base=" + f.base + "&head=HEAD&view=overview",
  );
  assert.notEqual(
    previous.head,
    next.head,
    "A cached comparison never pins a moving ref",
  );
  assert.deepEqual(
    next,
    await f.repo.compare(f.base, "HEAD", { view: "overview" }),
  );
  assert.equal((await f.git("status", "--porcelain")).toString(), "");
});
test("Rust authentication, write content-type boundary, gzip negotiation and static assets", async (t) => {
  const f = await fixture(t);
  const server = await startRust(f.directory, { base: f.base });
  t.after(() => server.close());
  const url = server.url,
    headers = { Authorization: "Bearer " + server.token };
  assert.equal((await fetch(url + "/api/repo")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/session", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: JSON.stringify({ token: server.token }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/session", {
        method: "POST",
        body: "x".repeat(2049),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(url + "/api/session", { method: "POST", body: "{" })).status,
    400,
  );
  const login = await fetch(url + "/api/session", {
    method: "POST",
    headers: { Origin: url },
    body: JSON.stringify({ token: server.token }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(url + "/api/repo", { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(url + "/api/source?path=.env", { headers })).status,
    200,
  );
  assert.equal(
    (await (await fetch(url + "/api/source?path=.env", { headers })).json())
      .after,
    null,
  );
  assert.equal(
    (await fetch(url + "/api/runs", { method: "POST", headers })).status,
    403,
  );
  assert.equal(
    (await fetch(url + "/api/compare?base=--help", { headers })).status,
    400,
  );
  assert.equal(
    (await fetch(url + "/api/source?path=../outside", { headers })).status,
    400,
  );
  assert.equal((await fetch(url + "/Cargo.toml", { headers })).status, 404);
  const compressed = await fetch(url + "/api/compare", {
    headers: { ...headers, "Accept-Encoding": "gzip" },
  });
  const plain = await fetch(url + "/api/compare", {
    headers: { ...headers, "Accept-Encoding": "gzip;q=0" },
  });
  assert.equal(compressed.headers.get("content-encoding"), "gzip");
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.deepEqual(await compressed.json(), await plain.json());
  assert.equal(compressed.headers.get("cache-control"), "no-store");
  assert.match(
    compressed.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(url + "/canvas.js")).status, 200);
  assert.equal((await fetch(url + "/select.js")).status, 200);
});
test("Rust syntax index survives process restart and unavailable parsers remain explicit", async (t) => {
  const f = await fixture(t);
  const state = await mkdtemp(path.join(os.tmpdir(), "strata-rust-index-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const requests = [
    { method: "compare", args: [f.base, "HEAD", { view: "overview" }] },
    { method: "metrics", args: [] },
  ];
  const first = await rustRpc(f.directory, state, requests);
  const second = await rustRpc(f.directory, state, requests);
  assert.deepEqual(first[0].result, second[0].result);
  assert.ok(first[1].result.parsed > 0);
  assert.ok(first[1].result.reused > 0);
  assert.equal(second[1].result.parsed, 0);
  const server = await startRust(f.directory, {
    base: f.base,
    python: "/missing-python",
    node: "/missing-node",
  });
  t.after(() => server.close());
  const data = await (
    await fetch(server.url + "/api/compare", {
      headers: { Authorization: "Bearer " + server.token },
    })
  ).json();
  assert.match(
    data.files.find((f) => f.path === "pkg/model.py").analysis,
    /Python unavailable/,
  );
  assert.match(
    data.files.find((f) => f.path === "web/src/lib/model.ts").analysis,
    /TypeScript unavailable/,
  );
});

test("Rust keeps serving when its optional disk index is unavailable", async (t) => {
  const f = await fixture(t);
  const state = await mkdtemp(path.join(os.tmpdir(), "strata-rust-fallback-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(path.join(state, "index-rust"), "not a directory");
  const server = await startRust(f.directory, {
    base: f.base,
    stateDirectory: state,
  });
  t.after(() => server.close());
  const response = await fetch(server.url + "/api/compare?view=overview", {
    headers: { Authorization: "Bearer " + server.token },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    await f.repo.compare(f.base, "HEAD", { view: "overview" }),
  );
});

test("Rust declarations are served from committed blobs and repo sessions coexist", async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  await mkdir(path.join(a.directory, "rust"));
  await writeFile(
    path.join(a.directory, "rust/main.rs"),
    "//! Service entry.\nmod model;\n",
  );
  await writeFile(
    path.join(a.directory, "rust/model.rs"),
    "/// Run input.\npub fn run(value: &str) -> usize { value.len() }\n",
  );
  await a.git("add", ".");
  await a.git("commit", "-m", "Rust module");
  await writeFile(
    path.join(a.directory, "rust/model.rs"),
    "uncommitted invalid Rust",
  );
  const servers = [
    await startRust(a.directory, { base: a.base }),
    await startRust(b.directory, { base: b.base }),
  ];
  t.after(() => Promise.all(servers.map((s) => s.close())));
  const cookies = [];
  for (const s of servers) {
    const r = await fetch(s.url + "/api/session", {
      method: "POST",
      headers: { Origin: s.url },
      body: JSON.stringify({ token: s.token }),
    });
    assert.equal(r.status, 200);
    cookies.push(r.headers.get("set-cookie").split(";")[0]);
  }
  assert.notEqual(cookies[0].split("=")[0], cookies[1].split("=")[0]);
  for (const s of servers)
    assert.equal(
      (
        await fetch(s.url + "/api/repo", {
          headers: { Cookie: cookies.join("; ") },
        })
      ).status,
      200,
    );
  const r = await fetch(servers[0].url + "/api/source?path=rust/model.rs", {
    headers: { Cookie: cookies.join("; ") },
  });
  assert.equal(r.status, 200);
  const data = await r.json(),
    method = data.details.after.symbols.find((s) => s.name === "run");
  assert.equal(method.description, "Run input.");
  assert.equal(method.returns, "usize");
  assert.equal(method.parameters[0].name, "value");
});

test("directory descriptions use committed revision-specific docs and package fallback", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.directory, "pkg/README.md"),
    "# Package\n\nOriginal responsibility.\n\nMore detail.\n",
  );
  await mkdir(path.join(f.directory, "fallback"));
  await writeFile(
    path.join(f.directory, "fallback/__init__.py"),
    '"""Package fallback description."""\n',
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Directory documentation");
  const base = (await f.git("rev-parse", "HEAD")).toString().trim();
  await writeFile(
    path.join(f.directory, "pkg/README.md"),
    "# Package\n\nUpdated responsibility.\n",
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "Update description");
  await writeFile(
    path.join(f.directory, "pkg/README.md"),
    "Working tree must not leak.",
  );
  const s = await startRust(f.directory, { base });
  t.after(() => s.close());
  const response = await fetch(s.url + "/api/directories", {
    headers: { Authorization: "Bearer " + s.token },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.before.pkg.description, "Original responsibility.");
  assert.equal(data.after.pkg.description, "Updated responsibility.");
  assert.equal(data.before.pkg.revision, base);
  assert.equal(data.after.pkg.path, "pkg/README.md");
  assert.equal(
    data.after.fallback.description,
    "Package fallback description.",
  );
  assert.equal(data.after.fallback.provenance, "Python package docstring");
  assert.equal(data.after["pkg/nested"], undefined);
  assert.deepEqual(data.adapters.map((a) => a.id).sort(), [
    "python",
    "rust",
    "typescript",
  ]);
  assert.ok(
    data.adapters.every(
      (a) => a.capabilities.includes("documentation") && a.limitations,
    ),
  );
  const reversed = await (
    await fetch(s.url + "/api/directories?base=HEAD&head=" + base, {
      headers: { Authorization: "Bearer " + s.token },
    })
  ).json();
  assert.equal(reversed.after.pkg.description, "Original responsibility.");
});

test("remembered browser survives service restart and token rotation revokes it", async (t) => {
  const f = await fixture(t);
  const stateDirectory = await mkdtemp(
    path.join(os.tmpdir(), "strata-sessions-"),
  );
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let server = await startRust(f.directory, { base: f.base, stateDirectory });
  t.after(() => server.close());
  const login = await fetch(server.url + "/api/session", {
    method: "POST",
    headers: { Origin: server.url },
    body: JSON.stringify({ token: server.token }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Max-Age=2592000/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await server.close();
  server = await startRust(f.directory, { base: f.base, stateDirectory });
  assert.equal(
    (await fetch(server.url + "/api/repo", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(server.url + "/api/repo", {
        headers: { Cookie: cookie + "x" },
      })
    ).status,
    401,
  );
  await server.close();
  server = await startRust(f.directory, {
    base: f.base,
    stateDirectory,
    token: "rotated-owner-token",
  });
  assert.equal(
    (await fetch(server.url + "/api/repo", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});
