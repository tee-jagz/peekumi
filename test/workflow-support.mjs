import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";
const root = path.resolve(import.meta.dirname, "..");
export async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peekumi-workflow-"));
  const git = (...args) => command("git", ["-C", dir, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Workflow Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(
    path.join(dir, "module.py"),
    '"""Fixture module."""\ndef run():\n    return 1\n',
  );
  await git("add", ".");
  await git("commit", "-m", "Initial");
  const sha = (await git("rev-parse", "HEAD")).toString().trim();
  const state = await mkdtemp(path.join(os.tmpdir(), "peekumi-workflow-state-"));
  const fake = path.join(state, "agent");
  await writeFile(
    fake,
    `#!${process.execPath}\n` +
      (await readFile(path.join(root, "test/workflow-fixture.mjs"), "utf8")),
  );
  await chmod(fake, 0o755);
  let server = await startRust(dir, {
    base: sha,
    stateDirectory: state,
    codex: fake,
    claude: fake,
  });
  const req = async (
    route,
    body,
    method = body ? "POST" : "GET",
    extra = {},
  ) => {
    const r = await fetch(server.url + route, {
      method,
      headers: {
        Authorization: "Bearer " + server.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  };
  return {
    dir,
    state,
    sha,
    git,
    req,
    get server() {
      return server;
    },
    async restart() {
      await server.close();
      server = await startRust(dir, {
        base: sha,
        stateDirectory: state,
        codex: fake,
        claude: fake,
      });
    },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
}
export async function waitFor(fn) {
  for (let n = 0; n < 900; n++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Workflow timeout");
}
