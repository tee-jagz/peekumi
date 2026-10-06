/** @module Explicit, foreground Cloudflare Quick Tunnels with a checksum-verified private download cache. */
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
} from "./cloudflare-release.mjs";

const exec = promisify(execFile);
const MAX_BYTES = 100 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Downloads a bounded release asset over HTTPS; rejects HTTP failures, timeouts and cancellation. */
async function download(url, signal, fetcher) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  });
  if (!response.ok)
    throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES)
      throw new Error("cloudflared download exceeds 100 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Creates an inert provider. Only expose downloads or runs cloudflared; available
 * and status are read-only. The caller must explicitly opt in and warn the user.
 * @param {object} options Private state directory and optional test dependencies.
 * @param {string} options.state Private Peekumi state directory, outside inspected repositories.
 * @returns {object} available/status/expose/url plus close for the foreground lifetime.
 */
export function createCloudflareProvider({
  state,
  platform = process.platform,
  arch = process.arch,
  assets = CLOUDFLARED_ASSETS,
  fetcher = fetch,
  spawnProcess = spawn,
  extract = (archive, directory) =>
    exec("tar", ["-xzf", archive, "-C", directory, "cloudflared"]),
  startupTimeout = 60000,
  shutdownTimeout = 5000,
}) {
  const asset = assets[`${platform}-${arch}`];
  const cache = join(
    state,
    "tunnel",
    `cloudflared-${CLOUDFLARED_VERSION}-${platform}-${arch}`,
  );
  const archive = asset && join(cache, asset.name);
  let session;
  let directory;
  let child;
  let closed;
  let closing;

  function supported() {
    if (!asset)
      throw new Error(
        `Cloudflare tunnel is unsupported on ${platform}/${arch}; use Tailscale instead`,
      );
  }

  async function cached() {
    supported();
    if ((await stat(archive)).size > MAX_BYTES)
      throw new Error("cloudflared cache exceeds 100 MiB");
    const bytes = await readFile(archive);
    if (digest(bytes) !== asset.sha256)
      throw new Error(
        `cloudflared SHA-256 checksum mismatch; remove ${archive} and retry explicit sharing`,
      );
    return bytes;
  }

  return {
    /** Checks platform and cached checksum without downloading, extracting or executing anything. */
    async available() {
      try {
        await cached();
        return {
          ok: true,
          detail: `cloudflared ${CLOUDFLARED_VERSION} (verified cache)`,
        };
      } catch (error) {
        return {
          ok: false,
          detail:
            error.code === "ENOENT"
              ? "Downloaded only by peekumi share --tunnel cloudflare (public URL)"
              : error.message,
        };
      }
    },

    /** Returns a new exposure handle; its URL is filled by expose once a connection is registered. */
    status() {
      return { publicUrl: undefined };
    },

    /**
     * Verifies a cached/downloaded artifact, stages its binary and runs a loopback Quick Tunnel.
     * Resolves after both URL discovery and connection registration; rejects startup errors,
     * checksum failures, timeout or cancellation. The handle's done promise reports later exits.
     * @param {number} port Loopback Peekumi port.
     * @param {object} status Handle from status(), populated with publicUrl and done.
     * @param {{signal?: AbortSignal}} options Cancellation for download and tunnel lifetime.
     */
    async expose(port, status, { signal = new AbortController().signal } = {}) {
      supported();
      if (session)
        throw new Error("This Cloudflare provider already has an exposure");
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Invalid tunnel port");
      session = status;
      try {
        signal.throwIfAborted();
        await mkdir(cache, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(cache, "run-"));
        let bytes;
        try {
          bytes = await cached();
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          bytes = await download(
            `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`,
            signal,
            fetcher,
          );
          if (digest(bytes) !== asset.sha256)
            throw new Error(
              "cloudflared SHA-256 checksum mismatch; download was not installed or executed",
            );
          signal.throwIfAborted();
          const staging = join(directory, "download");
          await writeFile(staging, bytes, { mode: 0o600, flag: "wx" });
          await rename(staging, archive);
        }
        const binary = join(directory, "cloudflared");
        if (asset.name.endsWith(".tgz")) {
          // Extract the verified bytes, never an archive another process could replace.
          const verified = join(directory, "verified.tgz");
          await writeFile(verified, bytes, { mode: 0o600 });
          await extract(verified, directory);
        } else await writeFile(binary, bytes, { mode: 0o600 });
        await chmod(binary, 0o700);
        // Override config discovery and tunnel env settings without touching the user's config.
        const config = join(directory, "config.yml");
        await writeFile(config, "{}\n", { mode: 0o600 });
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(TUNNEL_|CLOUDFLARED_|PEEKUMI_|STRATA_)/.test(key),
          ),
        );
        signal.throwIfAborted();
        child = spawnProcess(
          binary,
          [
            "tunnel",
            "--config",
            config,
            "--no-autoupdate",
            "--url",
            `http://127.0.0.1:${port}`,
            "--loglevel",
            "info",
          ],
          {
            cwd: directory,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let resolveClosed;
        closed = new Promise((resolve) => {
          resolveClosed = resolve;
        });
        status.done = closed;
        let failure;
        child.on("error", (error) => {
          failure = error;
        });
        child.once("close", (code, exitSignal) => {
          status.publicUrl = undefined;
          resolveClosed({ code, signal: exitSignal, error: failure });
        });
        // expose's error path or the manager's finally awaits close and reports errors.
        const abort = () => {
          void this.close().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        closed.then(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
        await new Promise((resolve, reject) => {
          let output = "";
          let publicUrl;
          let connected = false;
          const finish = (error) => {
            clearTimeout(timer);
            child.stdout.off("data", observe);
            child.stderr.off("data", observe);
            if (error) reject(error);
            else {
              status.publicUrl = publicUrl;
              resolve();
            }
          };
          const observe = (chunk) => {
            output = (output + chunk.toString()).slice(-16384);
            publicUrl ||= output.match(
              /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s"/]|$)/,
            )?.[0];
            connected ||= output.includes("Registered tunnel connection");
            if (publicUrl && connected) finish();
          };
          const timer = setTimeout(
            () =>
              finish(
                new Error(
                  "Timed out waiting for a Cloudflare tunnel connection",
                ),
              ),
            startupTimeout,
          );
          child.stdout.on("data", observe);
          child.stderr.on("data", observe);
          closed.then((result) =>
            finish(
              result.error ||
                new Error(
                  `cloudflared exited (${result.code ?? result.signal})`,
                ),
            ),
          );
        });
        signal.throwIfAborted();
      } catch (error) {
        await this.close();
        throw error;
      }
    },

    /** Returns the active HTTPS origin; rejects before readiness or after the child exits. */
    url(status) {
      if (!status.publicUrl)
        throw new Error("Cloudflare tunnel is not connected");
      return status.publicUrl;
    },

    /** Stops the owned child, escalates to SIGKILL after a grace period, and removes its staging directory. */
    async close() {
      if (closing) return closing;
      closing = (async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const timer = setTimeout(
            () => child.kill("SIGKILL"),
            shutdownTimeout,
          );
          await closed;
          clearTimeout(timer);
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
