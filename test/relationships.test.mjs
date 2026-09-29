import test from "node:test";
import { expandRelationships } from "../frontend/model.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";

test("relationships retain language evidence, unresolved dispatch and versioned rule-only changes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "strata-relationships-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => command("git", ["-C", dir, ...args]);
  const put = async (p, text) => {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), text);
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await put(
    "backend/main.rs",
    "mod provider; mod consumer; mod duplicate; mod ambiguous;",
  );
  await put("backend/provider.rs", "pub trait Port {}\npub fn helper() {}");
  await put("backend/duplicate.rs", "pub trait Port {}");
  await put(
    "backend/ambiguous.rs",
    "use super::provider::*; use super::duplicate::*; struct Ambiguous; impl Port for Ambiguous {}",
  );
  await put(
    "backend/consumer.rs",
    "use super::provider::{Port,helper as alias};\nstruct Client;\nimpl Port for Client {}\nimpl !Send for Client {}\nfn local() {}\nfn run() { local(); alias(); }\nfn shadow(local:fn()) {local();}\nimpl Client {fn run(&self){ self.unknown(); }}",
  );
  await put("py/provider.py", "class Base: pass\ndef helper(): return 1");
  await put(
    "py/consumer.py",
    "from .provider import Base, helper as alias\nclass Child(Base):\n    def run(self):\n        return self.unknown()\ndef local(): return 1\ndef run():\n    local()\n    alias()\ndef shadow(local):\n    local()\ndef nested():\n    def inner(): alias()\n    inner()\n",
  );
  await put(
    "web/provider.ts",
    "export interface Port {}\nexport class Base {}\nexport function helper():number {return 1;}",
  );
  await put(
    "web/consumer.ts",
    'import {Port, Base, helper as alias} from "./provider";\nclass Child extends Base implements Port { run(){ return this.unknown(); } }\nfunction local():number {return 1;}\nfunction run(){local();alias();}\nfunction shadow(local:()=>void){local();}\nfunction nested(){function inner(){alias();} inner();}',
  );
  await git("add", ".");
  await git("commit", "-m", "Relations");
  const base = (await git("rev-parse", "HEAD")).toString().trim();
  const config = {
    version: 1,
    groups: { consumers: ["**/consumer.*"], providers: ["**/provider.*"] },
    rules: [
      {
        id: "boundary",
        from: "consumers",
        to: ["providers"],
        kinds: ["imports", "calls", "implements", "inherits"],
        message: "Keep providers out of consumers",
      },
    ],
  };
  await put(".strata.json", JSON.stringify(config));
  await git("add", ".");
  await git("commit", "-m", "Rules only");
  await put(".strata.json", "uncommitted invalid rules");
  const server = await startRust(dir, { base });
  t.after(() => server.close());
  const get = async (q = "") => {
    const r = await fetch(server.url + "/api/relationships?" + q, {
      headers: { Authorization: "Bearer " + server.token },
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const data = await get(),
    rows = data.relationships;
  assert.equal(data.checks.before.state, "not configured");
  assert.equal(data.checks.after.state, "evaluated");
  assert.ok(data.checks.after.violations >= 9);
  for (const [file, owner, target, kind] of [
    ["backend/consumer.rs", "Client", "Port", "implements"],
    ["backend/consumer.rs", "run", "alias", "calls"],
    ["py/consumer.py", "Child", "Base", "inherits"],
    ["py/consumer.py", "run", "alias", "calls"],
    ["web/consumer.ts", "Child", "Port", "implements"],
    ["web/consumer.ts", "Child", "Base", "inherits"],
    ["web/consumer.ts", "run", "alias", "calls"],
  ]) {
    const r = rows.find(
      (r) =>
        r.source.path === file &&
        r.source.symbol === owner &&
        r.target === target &&
        r.kind === kind,
    );
    assert.ok(r, `${file} ${target}`);
    assert.equal(r.resolution, "resolved");
    assert.equal(r.status, "changed");
    assert.equal(r.before.violations.length, 0);
    assert.equal(r.after.violations[0].id, "boundary");
    assert.ok(r.sites[0] > 0);
  }
  for (const file of [
    "backend/consumer.rs",
    "py/consumer.py",
    "web/consumer.ts",
  ]) {
    const local = rows.find(
      (r) =>
        r.source.path === file &&
        r.source.symbol === "run" &&
        r.target === "local",
    );
    assert.equal(local.resolution, "resolved");
    assert.equal(local.violations.length, 0);
    const shadow = rows.find(
      (r) =>
        r.source.path === file &&
        r.source.symbol === "shadow" &&
        r.target === "local",
    );
    assert.equal(shadow.resolution, "unresolved");
    assert.ok(
      rows.some(
        (r) =>
          r.source.path === file &&
          r.target.includes("unknown") &&
          r.resolution === "unresolved",
      ),
    );
  }
  assert.ok(
    rows.some(
      (r) =>
        r.source.path === "backend/ambiguous.rs" &&
        r.kind === "implements" &&
        r.resolution === "ambiguous",
    ),
  );
  for (const file of ["py/consumer.py", "web/consumer.ts"])
    assert.ok(
      !rows.some(
        (r) =>
          r.source.path === file &&
          r.source.symbol === "nested" &&
          r.target === "alias",
      ),
      "Nested calls are not attributed to outer functions",
    );
  assert.ok(
    !rows.some((r) => r.kind === "implements" && r.target === "Send"),
    "Negative impls do not become positive implementation edges",
  );
  const overview = expandRelationships(await get("view=overview"));
  assert.ok(overview.relationships.every((r) => r.resolution === "resolved"));
  assert.ok(
    overview.relationships.some(
      (r) => r.kind === "implements" && r.violations.length,
    ),
  );
  const scoped = await get("path=web/provider.ts");
  assert.ok(
    scoped.relationships.some((r) => r.source.path === "web/consumer.ts"),
  );
  const reverse = await get("base=HEAD&head=" + base);
  assert.equal(reverse.checks.after.state, "not configured");
  assert.equal(reverse.checks.after.violations, 0);
  await put(".strata.json", '{"version":1,"groups":{},"rules":[{"typo":1}]}');
  await git("add", ".");
  await git("commit", "-m", "Invalid config");
  const invalid = await get();
  assert.equal(invalid.checks.after.state, "invalid");
  assert.ok(invalid.checks.after.errors.length);
  assert.equal((await fetch(server.url + "/api/relationships")).status, 401);
});
