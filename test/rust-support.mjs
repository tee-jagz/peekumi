import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
const root = path.resolve(import.meta.dirname, "..");
export async function startRust(
  directory,
  {
    base = "HEAD~1",
    head = "HEAD",
    token = "rust-test-token",
    stateDirectory,
    python = process.env.STRATA_PYTHON ||
      (process.platform === "darwin" ? "/usr/bin/python3" : "python3"),
    node = process.execPath,
    codex,
    claude,
    repositories = [],
    extraEnv = {},
    isolatePrimary = false,
  } = {},
) {
  const state =
    stateDirectory || (await mkdtemp(path.join(os.tmpdir(), "strata-rust-")));
  const proc = spawn(
    path.join(root, "target/release/strata"),
    [
      directory,
      "--port",
      "0",
      "--base",
      base,
      "--head",
      head,
      "--state-dir",
      state,
      "--parser-root",
      root,
      ...repositories.flatMap((repo) => ["--repo", repo]),
      ...(isolatePrimary ? ["--isolate-primary"] : []),
    ],
    {
      env: {
        ...process.env,
        ...extraEnv,
        STRATA_TOKEN: token,
        STRATA_PYTHON: python,
        STRATA_NODE: node,
        ...(codex ? { STRATA_CODEX: codex } : {}),
        ...(claude ? { STRATA_CLAUDE: claude } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  proc.stderr.on("data", (data) => (errors += data));
  const closed = new Promise((resolve) => proc.once("exit", resolve));
  const lines = createInterface({ input: proc.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(Error("Rust startup timeout: " + errors));
    }, 30000);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Rust startup failed " + code + ": " + errors));
    });
    lines.on("line", (line) => {
      if (line.startsWith("STRATA_READY ")) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + JSON.parse(line.slice(13)).port);
      }
    });
  });
  return {
    url,
    token,
    state,
    async close() {
      proc.kill();
      await closed;
      lines.close();
      if (!stateDirectory) await rm(state, { recursive: true, force: true });
    },
  };
}
export async function rustRpc(directory, stateDirectory, requests) {
  const proc = spawn(
    path.join(root, "target/release/strata"),
    [
      directory,
      "--stdio",
      "--state-dir",
      stateDirectory,
      "--parser-root",
      root,
    ],
    {
      env: {
        ...process.env,
        STRATA_PYTHON: process.env.STRATA_PYTHON || "/usr/bin/python3",
        STRATA_NODE: process.execPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "",
    errors = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (errors += d));
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(Error(errors))));
  });
  proc.stdin.end(
    requests
      .map((request, id) => JSON.stringify({ id, ...request }))
      .join("\n") + "\n",
  );
  await done;
  return output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
