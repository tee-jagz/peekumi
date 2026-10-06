#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const installed = path.join(
  homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "cargo.exe" : "cargo",
);
const cargo =
  process.env.PEEKUMI_CARGO ||
  process.env.STRATA_CARGO ||
  (existsSync(installed) ? installed : "cargo");
const proc = spawn(cargo, process.argv.slice(2), {
  cwd: path.resolve(import.meta.dirname, ".."),
  stdio: "inherit",
});
proc.on("error", (error) => {
  console.error("Rust toolchain required:", error.message);
  process.exitCode = 1;
});
proc.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => proc.kill(signal));
