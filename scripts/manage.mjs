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
import { createTailscaleProvider } from "./tunnel/tailscale.mjs";
import { createCloudflareProvider } from "./tunnel/cloudflare.mjs";
import { tunnelName } from "./tunnel/select.mjs";
const tunnel = createTailscaleProvider(run);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Reads a PEEKUMI_* setting, or its STRATA_* name from before the rename. */
const setting = (name) =>
  process.env["PEEKUMI_" + name] ?? process.env["STRATA_" + name];
// The private state directory. Without a setting it is ~/.local/share/peekumi; an existing
// ~/.local/share/strata from before the rename is used in place until `start` moves it.
const newState = join(homedir(), ".local/share/peekumi"),
  formerState = join(homedir(), ".local/share/strata");
const chosenState = setting("HOME");
const state = resolve(
  chosenState ||
    (!(await exists(newState)) && (await exists(formerState))
      ? formerState
      : newState),
);
const configPath = join(state, "config.json");
const serviceId = (path) =>
  createHash("sha256").update(path).digest("hex").slice(0, 12);
const service = "dev.peekumi." + serviceId(state);
// Service registrations from before the rename, which start and stop retire.
const formerServices = [
  ...new Set([
    "dev.repostrata." + serviceId(state),
    "dev.repostrata." + serviceId(formerState),
  ]),
];
const system = platform();
const uid = process.getuid?.();
const node = process.execPath;
const executable =
  setting("BINARY") ||
  ((await exists(join(root, "libexec/peekumi"))) &&
    join(root, "libexec/peekumi")) ||
  join(root, "target/release/peekumi");
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
  "No systemd user service manager is available here (common in containers, WSL without systemd and minimal systems). Run peekumi serve to keep Peekumi in the foreground, or run it under your own process manager.";
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
        "Unsupported config version; use a compatible Peekumi release.",
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
const plistFor = (label) =>
  join(homedir(), "Library/LaunchAgents", label + ".plist");
const unitFor = (label) =>
  join(homedir(), ".config/systemd/user", label + ".service");
const plist = plistFor(service);
const unit = unitFor(service);
/** Stops and removes the service registrations from before the rename, if any exist. */
async function retireFormerServices() {
  const { rm } = await import("node:fs/promises");
  for (const label of formerServices) {
    const file = system === "darwin" ? plistFor(label) : unitFor(label);
    if (!(await exists(file))) continue;
    try {
      if (system === "darwin")
        run("launchctl", ["bootout", `gui/${uid}`, file]);
      else run("systemctl", ["--user", "disable", "--now", label]);
    } catch {}
    await rm(file, { force: true });
  }
  if (system === "linux" && serviceManagerAvailable())
    try {
      run("systemctl", ["--user", "daemon-reload"]);
    } catch {}
}
/** Moves ~/.local/share/strata to ~/.local/share/peekumi when it is the state in use, no
 * setting chose another place, nothing is serving from it and the new folder is free. */
async function moveFormerState() {
  if (chosenState || state !== formerState || (await exists(newState)))
    return state;
  await rename(formerState, newState);
  console.log(`Moved ${formerState} to ${newState}`);
  return newState;
}
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
    signal: AbortSignal.timeout(options.timeout || 10000),
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
      headers: { "X-Peekumi-Repository": repo.id },
    });
    if (
      workflow.runs.some((r) =>
        ["starting", "running", "interrupted"].includes(r.status),
      )
    )
      throw new Error(
        `Finish or stop active agent runs in ${repo.name} before restarting Peekumi`,
      );
  }
}
async function installService() {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const args = [node, join(root, "scripts/manage.mjs"), "serve"];
  if (system === "darwin") {
    await mkdir(dirname(plist), { recursive: true });
    const env = {
      PEEKUMI_HOME: state,
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
      `[Unit]\nDescription=Peekumi\nAfter=network.target\n[Service]\nExecStart=${args.map(unitArg).join(" ")}\nEnvironment=${unitArg("PEEKUMI_HOME=" + state)}\nEnvironment=${unitArg("PATH=" + process.env.PATH)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    run("systemctl", ["--user", "daemon-reload"]);
  } else
    throw new Error(
      "Background service supports macOS and Linux. Use peekumi serve on other platforms.",
    );
}
async function start() {
  const c = await config();
  if (!c.repositories.length)
    throw new Error("Add a repository first: peekumi repo add /path/to/repo");
  if (await running()) {
    console.log("Peekumi is already serving on port " + c.port);
    return;
  }
  await retireFormerServices();
  if ((await moveFormerState()) !== state) {
    // The state moved; run again so every path, label and log points at the new folder.
    const again = spawnSync(
      process.execPath,
      [...process.execArgv, ...process.argv.slice(1)],
      {
        stdio: "inherit",
      },
    );
    process.exitCode = again.status ?? 1;
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
      `Port ${c.port} is already in use by another service. Choose another port with peekumi port <number>.`,
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
        `Peekumi ready at http://127.0.0.1:${c.port}/ · run peekumi pair for your private link`,
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
    "Service did not become ready. Run peekumi logs and peekumi doctor. Check that the configured port is free.",
  );
}
async function stop() {
  if (!serviceManagerAvailable()) throw new Error(NO_SERVICE_MANAGER);
  await ensureIdle();
  // The service may still be registered under its name from before the rename.
  await retireFormerServices();
  try {
    if (system === "darwin") run("launchctl", ["bootout", `gui/${uid}`, plist]);
    else run("systemctl", ["--user", "disable", "--now", service]);
  } catch (error) {
    if (await running()) throw error;
  }
  console.log("Peekumi stopped. Repositories and review state retained.");
}
async function doctor() {
  const checks = [];
  for (const [name, cmd, args, required] of [
    ["Git", "git", ["--version"], true],
    ["Server", executable, ["--version"], true],
    ["Node", node, ["--version"], true],
    ["Python", setting("PYTHON") || "python3", ["--version"], false],
    ["GitHub CLI", "gh", ["--version"], false],
    ["Claude Code", "claude", ["--version"], false],
    ["Codex", "codex", ["--version"], false],
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
  checks.push({ name: "Tailscale", ...tunnel.available(), required: false });
  if (system === "linux")
    checks.push({
      name: "Background service",
      ok: serviceManagerAvailable(),
      required: false,
      detail: serviceManagerAvailable()
        ? "systemd user services"
        : "No systemd user session; use peekumi serve in the foreground",
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
/**
 * Keeps an explicitly requested public tunnel in the foreground. Management owns
 * secure-cookie persistence/restarts; the temporary hostname is never persisted.
 * Signals cancel download/startup and close the child before returning.
 */
async function shareCloudflare(c) {
  console.error("Warning: the Cloudflare URL is PUBLIC and reachable from the internet. Peekumi still requires pairing; keep pairing links private. Traffic passes through Cloudflare.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const provider = createCloudflareProvider({ state });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
  try {
    const token = (await readFile(join(state, "access-token"), "utf8")).trim();
    if (!c.secureCookie) {
      c.secureCookie = true;
      await save(c);
      await stop();
      await start();
    }
    controller.signal.throwIfAborted();
    const status = provider.status();
    await provider.expose(c.port, status, { signal: controller.signal });
    const url = provider.url(status);
    console.log(`Public phone URL: ${url}/\nPrivate pairing link: ${url}/#token=${token}\nKeep this command running. Ctrl+C closes the tunnel; the next run gets a new URL.`);
    const result = await status.done;
    if (!controller.signal.aborted)
      throw result.error || new Error(`cloudflared exited (${result.code ?? result.signal}); run peekumi share --tunnel cloudflare again`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    await provider.close();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
  }
}
async function main() {
  const [command = "help", sub, ...args] = process.argv.slice(2);
  if (command !== "share" && process.argv.slice(3).some((arg) => arg === "--tunnel" || arg.startsWith("--tunnel=")))
    throw new Error("--tunnel is supported only by peekumi share");
  if (command === "doctor") return doctor();
  if (command === "repo") {
    const c = await config();
    if (sub === "list") {
      console.log(JSON.stringify(c.repositories, null, 2));
      return;
    }
    if (!["add", "remove"].includes(sub) || !args[0])
      throw new Error("Use peekumi repo add|remove /path/to/repo");
    // A running service picks the change up straight away; the registry is what it starts
    // from next time.
    const live = await running();
    if (sub === "add") {
      const directory = await realpath(args[0]);
      const actual = await realpath(
        run("git", ["-C", directory, "rev-parse", "--show-toplevel"]),
      );
      run("git", ["-C", actual, "rev-parse", "--verify", "HEAD"]);
      if (!c.repositories.includes(actual)) c.repositories.push(actual);
      await save(c);
      if (!live)
        return console.log(
          `Added ${actual}. It is served from the next start.`,
        );
      try {
        await api("/api/repositories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: actual }),
          timeout: 60000,
        });
        console.log(`Added ${actual}. It is being served now.`);
      } catch (error) {
        console.log(
          `Added ${actual} to the registry, but the running service could not open it: ${error.message}\nRun peekumi restart to try again.`,
        );
      }
      return;
    }
    // The folder may already be gone; remove it by the path it was registered under.
    const directory = await realpath(args[0]).catch(() => resolve(args[0]));
    if (!c.repositories.includes(directory))
      return console.log(`${directory} is not registered.`);
    const first = c.repositories[0] === directory;
    if (live && !first)
      await api(
        `/api/repositories/${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`,
        {
          method: "DELETE",
        },
      ).catch((error) => {
        if (!/not registered/.test(error.message)) throw error;
      });
    c.repositories = c.repositories.filter((p) => p !== directory);
    await save(c);
    console.log(
      live && first
        ? `Removed ${directory}. It was the first repository, so run peekumi restart to stop serving it.`
        : `Removed ${directory}.`,
    );
    return;
  }
  if (command === "serve") {
    process.umask(0o077);
    const c = await config();
    if (!c.repositories.length)
      throw new Error("Add a repository with peekumi repo add first");
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
    delete env.PEEKUMI_TOKEN;
    delete env.STRATA_TOKEN;
    const child = spawn(executable, params, { stdio: "inherit", env });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => child.kill(signal));
    child.on("error", (e) => {
      console.error(e.message + "; run peekumi doctor");
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
      if (!args[0]) throw new Error("Use peekumi devices revoke <id>");
      await api("/api/devices/" + encodeURIComponent(args[0]), {
        method: "DELETE",
      });
      console.log("Device revoked");
    } else console.log(JSON.stringify(await api("/api/devices"), null, 2));
    return;
  }
  if (command === "share") {
    const name = tunnelName(process.argv.slice(3));
    const c = await config();
    if (!(await running())) throw new Error("Start Peekumi first");
    await ensureIdle();
    if (name === "cloudflare") return shareCloudflare(c);
    let tunnelStatus;
    try {
      tunnelStatus = tunnel.status();
      tunnel.expose(c.port, tunnelStatus);
    } catch (cause) {
      throw new Error(
        `Tailscale sharing is not ready: ${cause.message}\n\n` +
          "To use private Tailscale sharing:\n" +
          "1. Install Tailscale on this host and your phone, and make sure the tailscale CLI is on PATH.\n" +
          "2. Start Tailscale and sign into the same tailnet on both devices. Run tailscale status on the host to check the connection.\n" +
          "3. Enable tailnet HTTPS if prompted. Review tailscale serve status and preserve any existing Serve configuration.\n" +
          "4. Retry peekumi share, then run peekumi pair for your private pairing link.\n\n" +
          "For an explicitly opted-in PUBLIC temporary URL instead, run:\n" +
          "  peekumi share --tunnel cloudflare\n" +
          "The Cloudflare URL is reachable from the internet; keep pairing links private.",
        { cause },
      );
    }
    c.publicUrl = tunnel.url(tunnelStatus);
    c.secureCookie = true;
    await save(c);
    await stop();
    await start();
    console.log(
      `Phone URL: ${c.publicUrl}/ · connect Tailscale on your phone, then run peekumi pair`,
    );
    return;
  }
  if (command === "port") {
    if (await running())
      throw new Error("Stop Peekumi before changing its port");
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
    const dest = resolve(sub || join(homedir(), ".local/lib/peekumi"));
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
      for (const name of ["LICENSE", "NOTICE"])
        if (await exists(join(root, name)))
          await copyFile(join(root, name), join(staging, name));
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
      await copyFile(executable, join(staging, "libexec/peekumi.next"));
      await rename(
        join(staging, "libexec/peekumi.next"),
        join(staging, "libexec/peekumi"),
      );
      await writeFile(
        join(staging, "bin/peekumi"),
        // Resolve symlinks first, so a link such as ~/.local/bin/peekumi finds the bundle.
        '#!/bin/sh\nself=$0\nwhile [ -L "$self" ]; do\n  target=$(readlink "$self")\n  case $target in /*) self=$target ;; *) self=$(dirname -- "$self")/$target ;; esac\ndone\nPEEKUMI_ROOT=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd)\nexec "$PEEKUMI_ROOT/libexec/node" "$PEEKUMI_ROOT/scripts/manage.mjs" "$@"\n',
        { mode: 0o755 },
      );
      // The command's name before the rename keeps working.
      const { symlink } = await import("node:fs/promises");
      await symlink("peekumi", join(staging, "bin/strata"));
      await chmod(join(staging, "libexec/peekumi"), 0o755);
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
        for (const path of older)
          await rm(path, { recursive: true, force: true });
        console.log("Previous installation retained at " + backup);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    // install.sh prints its own next steps; a direct install explains them here.
    console.log(
      setting("INSTALLER")
        ? `Installed ${dest}`
        : `Installed ${join(dest, "bin/peekumi")}\nAdd ${join(dest, "bin")} to PATH. Run the installed peekumi doctor, then peekumi start.\nExisting state is retained. Stop the old service and start using the installed command to switch service paths.`,
    );
    return;
  }
  console.log(
    "Peekumi setup\n  doctor\n  install|upgrade [directory]\n  repo add|remove <path> | repo list\n  port <port>\n  start | stop | restart | serve | status | logs\n  share [--tunnel tailscale]  Private Tailscale HTTPS access (default)\n  share --tunnel cloudflare  PUBLIC temporary HTTPS URL; downloads verified cloudflared, stays in foreground\n  pair [--read-only]     Print a private device pairing link\n  devices [revoke <id>]\n\nPEEKUMI_HOME (or the former STRATA_HOME) selects the private registry/state directory. Agents: read docs/SETUP.md.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
