/** @module Run bounded local media commands without printing process environment values. */
import { spawn } from "node:child_process";
/** Run an executable with literal arguments. Reject with bounded stderr on failure. */
export function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            Error(program + " exited " + code + ": " + stderr.slice(-5000)),
          ),
    );
  });
}
