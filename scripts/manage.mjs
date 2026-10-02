#!/usr/bin/env node
/** @module User-facing setup and service management. Uses argument arrays, versioned private configuration, and OS service managers. */
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  realpath,
  access,
  copyFile,
  chmod,
} from "node:fs/promises";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(
  process.env.STRATA_HOME || join(homedir(), ".local/share/strata"),
);
const configPath = join(state, "config.json");
const service =
  "dev.repostrata." +
  createHash("sha256").update(state).digest("hex").slice(0, 12);
const system = platform();
const uid = process.getuid?.();
const node = process.execPath;
const executable =
  process.env.STRATA_BINARY ||
  ((await exists(join(root, "libexec/strata"))) &&
    join(root, "libexec/strata")) ||
  join(root, "target/release/strata");
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    timeout: 30000,
    encoding: "utf8",
    ...options,
  });
  if (result.error)
    throw new Error(`Cannot run ${program}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${program}: ${result.stderr?.trim() || "command failed"}`);
  return result.stdout?.trim() || "";
}
const NO_SERVICE_MANAGER =
  "No systemd user service manager is available here (common in containers, WSL without systemd and minimal systems). Run strata serve to keep Strata in the foreground, or run it under your own process manager.";
/** Reports whether this Linux session can run a systemd user service; macOS always can. */
function serviceManagerAvailable() {
  if (system !== "linux") return true;
  const probe = spawnSync("systemctl", ["--user", "show-environment"], {
    timeout: 10000,
    encoding: "utf8",
  });
  return !probe.error && probe.status === 0;
}
async function config() {
  try {
    const c = JSON.parse(await readFile(configPath, "utf8"));
    if (c.version !== 1)
      throw new Error(
        "Unsupported config version; use a compatible Strata release.",
      );
    return c;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return { version: 1, repositories: [], port: 4317, secureCookie: false };
  }
}
async function save(c) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(configPath + ".next", JSON.stringify(c, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(configPath + ".next", configPath);
}
function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function unitArg(value) {
  return (
    '"' +
    String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("\n", "\\n") +
    '"'
  );
}
const plist = join(homedir(), "Library/LaunchAgents", service + ".plist");
const unit = join(homedir(), ".config/systemd/user", service + ".service");
async function running() {
  try {
    const c = await config();
    const token = (await readFile(join(state, "access-token"), "utf8")).trim();
    const r = await fetch(`http://127.0.0.1:${c.port}/api/repositories`, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}
async function api(path, options = {}) {
  const c = await config();
  const token = (await readFile(join(state, "access-token"), "utf8")).trim();
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    ...options,
    headers: { Authorization: "Bearer " + token, ...options.headers },
    signal: AbortSignal.timeout(10000),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error);
  return v;
}
async function ensureIdle() {
  if (!(await running())) return;
  const { repositories } = await api("/api/repositories");
  for (const repo of repositories) {
    const workflow = await api("/api/workflow", {
      headers: { "X-Strata-Repository": repo.id },
    });
    if (
      workflow.runs.some((r) =>
        ["starting", "running", "interrupted"].includes(r.status),
      )
    )
      throw new Error(
        `Finish or stop active agent runs in ${repo.name} before restarting Strata`,
      );
  }
}
async function installService() {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const args = [node, join(root, "scripts/manage.mjs"), "serve"];
  if (system === "darwin") {
    await mkdir(dirname(plist), { recursive: true });
    const env = {
      STRATA_HOME: state,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    };
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${service}</string><key>ProgramArguments</key><array>${args.map((a) => "<string>" + xml(a) + "</string>").join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(
        env,
      )
        .map(([k, v]) => "<key>" + k + "</key><string>" + xml(v) + "</string>")
        .join(
          "",
        )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(state, "server.log"))}</string><key>StandardErrorPath</key><string>${xml(join(state, "server.log"))}</string></dict></plist>`,
      { mode: 0o600 },
    );
  } else if (system === "linux") {
    if (!serviceManagerAvailable()) throw new Error(NO_SERVICE_MANAGER);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(
      unit,
      `[Unit]\nDescription=Repo Strata\nAfter=network.target\n[Service]\nExecStart=${args.map(unitArg).join(" ")}\nEnvironment=${unitArg("STRATA_HOME=" + state)}\nEnvironment=${unitArg("PATH=" + process.env.PATH)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    run("systemctl", ["--user", "daemon-reload"]);
  } else
    throw new Error(
      "Background service supports macOS and Linux. Use strata serve on other platforms.",
    );
}
async function start() {
  const c = await config();
  if (!c.repositories.length)
    throw new Error("Add a repository first: strata repo add /path/to/repo");
  if (await running()) {
    console.log("Strata is already serving on port " + c.port);
    return;
  }
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${c.port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    occupied = true;
  } catch {}
  if (occupied)
    throw new Error(
      `Port ${c.port} is already in use by another service. Choose another port with strata port <number>.`,
    );
  await installService();
  if (system === "darwin") {
    try {
      run("launchctl", ["bootout", `gui/${uid}`, plist]);
    } catch {}
    run("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  } else run("systemctl", ["--user", "enable", "--now", service]);
  for (let i = 0; i < 40; i++) {
    if (await running()) {
      console.log(
        `Strata ready at http://127.0.0.1:${c.port}/ · run strata pair for your private link`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    if (system === "darwin") run("launchctl", ["bootout", `gui/${uid}`, plist]);
    else run("systemctl", ["--user", "disable", "--now", service]);
  } catch {}
  throw new Error(
    "Service did not become ready. Run strata logs and strata doctor. Check that the configured port is free.",
  );
}
async function stop() {
  if (!serviceManagerAvailable()) throw new Error(NO_SERVICE_MANAGER);
  await ensureIdle();
  if (system === "darwin") run("launchctl", ["bootout", `gui/${uid}`, plist]);
  else run("systemctl", ["--user", "disable", "--now", service]);
  console.log("Strata stopped. Repositories and review state retained.");
}
async function doctor() {
  const checks = [];
  for (const [name, cmd, args, required] of [
    ["Git", "git", ["--version"], true],
    ["Server", executable, ["--version"], true],
    ["Node", node, ["--version"], true],
    ["Python", process.env.STRATA_PYTHON || "python3", ["--version"], false],
    ["GitHub CLI", "gh", ["--version"], false],
    ["Claude Code", "claude", ["--version"], false],
    ["Codex", "codex", ["--version"], false],
    ["Tailscale", "tailscale", ["version"], false],
  ]) {
    try {
      checks.push({
        name,
        ok: true,
        detail: run(cmd, args).split("\n")[0],
        required,
      });
    } catch {
      checks.push({
        name,
        ok: false,
        required,
        detail: `Install ${name}${required ? " before starting" : " to enable its optional integration"}`,
      });
    }
  }
  if (system === "linux")
    checks.push({
      name: "Background service",
      ok: serviceManagerAvailable(),
      required: false,
      detail: serviceManagerAvailable()
        ? "systemd user services"
        : "No systemd user session; use strata serve in the foreground",
    });
  try {
    run(
      node,
      [
        "--input-type=module",
        "-e",
        "import('typescript').then(()=>process.stdout.write('ok'))",
      ],
      { cwd: root },
    );
    checks.push({ name: "TypeScript parser", ok: true });
  } catch {
    checks.push({
      name: "TypeScript parser",
      ok: false,
      required: true,
      detail: "Install bundle dependencies or run npm ci",
    });
  }
  console.log(
    JSON.stringify(
      { platform: system, architecture: process.arch, state, checks },
      null,
      2,
    ),
  );
  if (checks.some((c) => c.required && !c.ok)) process.exitCode = 1;
}
async function main() {
  const [command = "help", sub, ...args] = process.argv.slice(2);
  if (command === "doctor") return doctor();
  if (command === "repo") {
    const c = await config();
    if (sub === "list") {
      console.log(JSON.stringify(c.repositories, null, 2));
      return;
    }
    if (!["add", "remove"].includes(sub) || !args[0])
      throw new Error("Use strata repo add|remove /path/to/repo");
    const directory = await realpath(args[0]);
    if (sub === "add") {
      const actual = await realpath(
        run("git", ["-C", directory, "rev-parse", "--show-toplevel"]),
      );
      run("git", ["-C", actual, "rev-parse", "--verify", "HEAD"]);
      if (!c.repositories.includes(actual)) c.repositories.push(actual);
    } else c.repositories = c.repositories.filter((p) => p !== directory);
    await save(c);
    console.log(
      "Repository registry saved. Run strata restart if the service is already running.",
    );
    return;
  }
  if (command === "serve") {
    process.umask(0o077);
    const c = await config();
    if (!c.repositories.length)
      throw new Error("Add a repository with strata repo add first");
    const params = [
      c.repositories[0],
      "--state-dir",
      state,
      "--isolate-primary",
      "--host",
      "127.0.0.1",
      "--port",
      String(c.port),
      "--parser-root",
      root,
      "--node",
      node,
    ];
    for (const repo of c.repositories.slice(1)) params.push("--repo", repo);
    if (c.secureCookie) params.push("--secure-cookie");
    const env = { ...process.env };
    delete env.STRATA_TOKEN;
    const child = spawn(executable, params, { stdio: "inherit", env });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => child.kill(signal));
    child.on("error", (e) => {
      console.error(e.message + "; run strata doctor");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "restart") {
    if (await running()) await stop();
    return start();
  }
  if (command === "status") {
    const c = await config();
    console.log(
      JSON.stringify(
        {
          running: await running(),
          port: c.port,
          repositories: c.repositories,
          state,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "logs") {
    if (system === "linux")
      console.log(
        run("journalctl", ["--user", "-u", service, "-n", "80", "--no-pager"]),
      );
    else
      console.log(
        (await readFile(join(state, "server.log"), "utf8"))
          .split("\n")
          .slice(-80)
          .join("\n")
          .replace(/#token=[a-f0-9]+/g, "#token=[redacted]"),
      );
    return;
  }
  if (command === "pair") {
    const c = await config();
    const path =
      sub === "--read-only"
        ? join(state, "read-only/access-token")
        : join(state, "access-token");
    const token = (await readFile(path, "utf8")).trim();
    console.log(
      `${c.publicUrl || `http://127.0.0.1:${c.port}`}/#token=${token}`,
    );
    return;
  }
  if (command === "devices") {
    if (sub === "revoke") {
      if (!args[0]) throw new Error("Use strata devices revoke <id>");
      await api("/api/devices/" + encodeURIComponent(args[0]), {
        method: "DELETE",
      });
      console.log("Device revoked");
    } else console.log(JSON.stringify(await api("/api/devices"), null, 2));
    return;
  }
  if (command === "share") {
    const c = await config();
    if (!(await running())) throw new Error("Start Strata first");
    await ensureIdle();
    const ts = JSON.parse(run("tailscale", ["status", "--json"]));
    const host = ts.Self?.DNSName?.replace(/\.$/, "");
    if (!host) throw new Error("Sign into Tailscale first");
    const existing = JSON.parse(
      run("tailscale", ["serve", "status", "--json"]),
    );
    if (
      Object.keys(existing).length &&
      !JSON.stringify(existing).includes(`http://127.0.0.1:${c.port}`)
    )
      throw new Error(
        "Tailscale Serve already has another configuration. Keep it intact and configure a separate HTTPS endpoint for Strata.",
      );
    // No Funnel/public exposure: Serve is restricted to devices on the tailnet.
    run("tailscale", ["serve", "--bg", `http://127.0.0.1:${c.port}`]);
    c.publicUrl = "https://" + host;
    c.secureCookie = true;
    await save(c);
    await stop();
    await start();
    console.log(
      `Phone URL: ${c.publicUrl}/ · connect Tailscale on your phone, then run strata pair`,
    );
    return;
  }
  if (command === "port") {
    if (await running())
      throw new Error("Stop Strata before changing its port");
    const value = Number(sub);
    if (!Number.isInteger(value) || value < 1024 || value > 65535)
      throw new Error("Choose a port between 1024 and 65535");
    const c = await config();
    c.port = value;
    await save(c);
    console.log("Port saved; restart to apply.");
    return;
  }
  if (command === "install" || command === "upgrade") {
    await ensureIdle();
    const dest = resolve(sub || join(homedir(), ".local/lib/strata"));
    if (dest === root)
      throw new Error(
        "Choose an installation directory outside the source tree",
      );
    const { cp, rm } = await import("node:fs/promises");
    const staging = dest + ".staging-" + process.pid + "-" + Date.now();
    await mkdir(dirname(dest), { recursive: true });
    await mkdir(staging);
    let backup;
    try {
      await mkdir(join(staging, "libexec"), { recursive: true });
      await mkdir(join(staging, "bin"), { recursive: true });
      await cp(join(root, "scripts"), join(staging, "scripts"), {
        recursive: true,
      });
      await cp(join(root, "docs/SETUP.md"), join(staging, "SETUP.md"));
      await mkdir(join(staging, "docs"), { recursive: true });
      await cp(join(root, "docs/SETUP.md"), join(staging, "docs/SETUP.md"));
      await cp(join(root, "skills"), join(staging, "skills"), {
        recursive: true,
      });
      const nodeLicense = join(dirname(dirname(node)), "LICENSE");
      if (await exists(nodeLicense))
        await copyFile(nodeLicense, join(staging, "NODE-LICENSE"));
      await cp(
        join(root, "backend/adapters"),
        join(staging, "backend/adapters"),
        {
          recursive: true,
        },
      );
      await cp(
        join(root, "node_modules/typescript"),
        join(staging, "node_modules/typescript"),
        { recursive: true },
      );
      await copyFile(node, join(staging, "libexec/node.next"));
      await rename(
        join(staging, "libexec/node.next"),
        join(staging, "libexec/node"),
      );
      await copyFile(executable, join(staging, "libexec/strata.next"));
      await rename(
        join(staging, "libexec/strata.next"),
        join(staging, "libexec/strata"),
      );
      await writeFile(
        join(staging, "bin/strata"),
        // Resolve symlinks first, so a link such as ~/.local/bin/strata finds the bundle.
        '#!/bin/sh\nself=$0\nwhile [ -L "$self" ]; do\n  target=$(readlink "$self")\n  case $target in /*) self=$target ;; *) self=$(dirname -- "$self")/$target ;; esac\ndone\nSTRATA_ROOT=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd)\nexec "$STRATA_ROOT/libexec/node" "$STRATA_ROOT/scripts/manage.mjs" "$@"\n',
        { mode: 0o755 },
      );
      await chmod(join(staging, "libexec/strata"), 0o755);
      await chmod(join(staging, "libexec/node"), 0o755);
      // The bundle copies the running Node binary. Refuse one that depends on shared
      // libraries outside it (Homebrew's Node needs libnode), before replacing anything.
      const runtime = spawnSync(join(staging, "libexec/node"), ["--version"], {
        encoding: "utf8",
      });
      if (runtime.status !== 0)
        throw new Error(
          `The Node runtime ${node} is not self-contained and would not run from the bundle. ` +
            "Run install/upgrade with an official nodejs.org build of Node 22.",
        );
      if (await exists(dest)) {
        backup = dest + ".previous-" + Date.now();
        await rename(dest, backup);
      }
      try {
        await rename(staging, dest);
      } catch (error) {
        if (backup) await rename(backup, dest);
        throw error;
      }
      if (backup) {
        // Keep only the newest previous installation; each bundle carries its own Node runtime.
        const { readdir } = await import("node:fs/promises");
        const prefix = basename(dest) + ".previous-";
        const older = (await readdir(dirname(dest)))
          .filter((name) => name.startsWith(prefix))
          .map((name) => join(dirname(dest), name))
          .filter((path) => path !== backup);
        for (const path of older) await rm(path, { recursive: true, force: true });
        console.log("Previous installation retained at " + backup);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    // install.sh prints its own next steps; a direct install explains them here.
    console.log(
      process.env.STRATA_INSTALLER
        ? `Installed ${dest}`
        : `Installed ${join(dest, "bin/strata")}\nAdd ${join(dest, "bin")} to PATH. Run the installed strata doctor, then strata start.\nExisting state is retained. Stop the old service and start using the installed command to switch service paths.`,
    );
    return;
  }
  console.log(
    "Strata setup\n  doctor\n  install|upgrade [directory]\n  repo add|remove <path> | repo list\n  port <port>\n  start | stop | restart | serve | status | logs\n  share                 Private Tailscale HTTPS access\n  pair [--read-only]     Print a private device pairing link\n  devices [revoke <id>]\n\nSTRATA_HOME selects the private registry/state directory. Agents: read docs/SETUP.md.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
