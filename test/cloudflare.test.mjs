import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCloudflareProvider } from "../scripts/tunnel/cloudflare.mjs";
import {
  CLOUDFLARED_VERSION,
  CLOUDFLARED_ASSETS,
} from "../scripts/tunnel/cloudflare-release.mjs";
import { tunnelName } from "../scripts/tunnel/select.mjs";

async function fixture(t, options = {}) {
  const state = await mkdtemp(join(tmpdir(), "peekumi-cloudflare-test-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const bytes = Buffer.from("fixture cloudflared");
  const calls = { downloads: [], spawns: [], kills: [], children: [] };
  const dependencies = {
    state,
    platform: "linux",
    arch: "x64",
    startupTimeout: 100,
    assets: {
      "linux-x64": {
        name: "cloudflared-linux-amd64",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    fetcher: async (url) => {
      calls.downloads.push(url);
      return new Response(bytes);
    },
    spawnProcess: (program, args, settings) => {
      calls.spawns.push({ program, args, settings });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        calls.kills.push(signal);
        child.signalCode = signal;
        queueMicrotask(() => child.emit("close", null, signal));
      };
      calls.children.push(child);
      setImmediate(() => {
        child.stderr.write("https://quiet-river.trycloud");
        child.stderr.write("flare.com\n");
        child.stderr.write("Registered tunnel connection connIndex=0\n");
      });
      return child;
    },
    ...options,
  };
  const provider = createCloudflareProvider(dependencies);
  t.after(() => provider.close());
  return { provider, state, calls, bytes, dependencies };
}

test("only explicit share arguments select Cloudflare", () => {
  assert.equal(tunnelName([]), "tailscale");
  assert.equal(tunnelName(["--tunnel", "tailscale"]), "tailscale");
  assert.equal(tunnelName(["--tunnel", "cloudflare"]), "cloudflare");
  for (const args of [
    ["cloudflare"],
    ["--tunnel"],
    ["--tunnel", "other"],
    ["--tunnel=cloudflare"],
    ["--tunnel", "cloudflare", "--tunnel", "tailscale"],
  ])
    assert.throws(() => tunnelName(args), /explicit --tunnel cloudflare/);
});

test("Cloudflare construction and diagnostics do not download or execute", async (t) => {
  const { provider, state, calls } = await fixture(t);
  assert.equal((await provider.available()).ok, false);
  assert.deepEqual(provider.status(), { publicUrl: undefined });
  assert.deepEqual(await readdir(state), []);
  assert.equal(calls.downloads.length + calls.spawns.length, 0);
  const unsupported = createCloudflareProvider({
    state,
    platform: "win32",
    arch: "arm64",
  });
  assert.match((await unsupported.available()).detail, /unsupported/);
  await assert.rejects(
    unsupported.expose(4317, unsupported.status()),
    /unsupported/,
  );
});

test("first exposure verifies, runs only the private binary and cleans up; subsequent opt-in reuses verified cache", async (t) => {
  const { provider, calls, dependencies, state } = await fixture(t);
  const status = provider.status();
  await provider.expose(4317, status);
  assert.equal(provider.url(status), "https://quiet-river.trycloudflare.com");
  assert.equal(calls.downloads.length, 1);
  assert.match(
    calls.downloads[0],
    new RegExp(
      `/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64$`,
    ),
  );
  assert.equal((await provider.available()).ok, true);
  const { program, args, settings } = calls.spawns[0];
  assert.ok(program.startsWith(state));
  assert.equal(args[0], "tunnel");
  assert.ok(args.includes("--no-autoupdate"));
  assert.equal(args[args.indexOf("--url") + 1], "http://127.0.0.1:4317");
  assert.equal(
    await readFile(args[args.indexOf("--config") + 1], "utf8"),
    "{}\n",
  );
  assert.ok(
    !Object.keys(settings.env).some((key) =>
      /^(TUNNEL_|CLOUDFLARED_|PEEKUMI_|STRATA_)/.test(key),
    ),
  );
  await provider.close();
  assert.equal((await status.done).signal, "SIGTERM");
  assert.throws(() => provider.url(status), /not connected/);
  await assert.rejects(readFile(program), { code: "ENOENT" });
  const second = createCloudflareProvider(dependencies);
  t.after(() => second.close());
  await second.expose(4317, second.status());
  assert.equal(calls.downloads.length, 1);
  await second.close();
});

test("bad downloads and HTTP failures never install or execute; staging is removed", async (t) => {
  for (const response of [
    new Response("tampered"),
    new Response("unavailable", { status: 503 }),
  ]) {
    const { provider, calls, state } = await fixture(t, {
      fetcher: async () => response,
    });
    await assert.rejects(
      provider.expose(4317, provider.status()),
      /checksum mismatch|HTTP 503/,
    );
    assert.equal(calls.spawns.length, 0);
    const cache = join(
      state,
      "tunnel",
      (await readdir(join(state, "tunnel")))[0],
    );
    assert.deepEqual(await readdir(cache), []);
  }
});

test("cached artifacts are reverified and corruption never triggers execution or an automatic redownload", async (t) => {
  const { provider, calls, state, dependencies } = await fixture(t);
  await provider.expose(4317, provider.status());
  await provider.close();
  const cache = join(
    state,
    "tunnel",
    (await readdir(join(state, "tunnel")))[0],
  );
  await writeFile(join(cache, "cloudflared-linux-amd64"), "corrupted");
  const second = createCloudflareProvider(dependencies);
  assert.match((await second.available()).detail, /checksum mismatch/);
  await assert.rejects(
    second.expose(4317, second.status()),
    /checksum mismatch/,
  );
  assert.equal(calls.spawns.length, 1);
  assert.equal(calls.downloads.length, 1);
});

test("archive extraction happens only after verification, and failures never spawn", async (t) => {
  let extractions = 0;
  const f = await fixture(t);
  const dependencies = {
    ...f.dependencies,
    assets: {
      "linux-x64": {
        ...f.dependencies.assets["linux-x64"],
        name: "fixture.tgz",
      },
    },
    extract: async (archive, directory) => {
      assert.deepEqual(await readFile(archive), f.bytes);
      extractions++;
      await writeFile(join(directory, "cloudflared"), "extracted fixture");
    },
  };
  const valid = createCloudflareProvider(dependencies);
  t.after(() => valid.close());
  await valid.expose(4317, valid.status());
  await valid.close();
  assert.equal(extractions, 1);
  const broken = createCloudflareProvider({
    ...dependencies,
    extract: async () => {
      throw new Error("tar failed");
    },
  });
  await assert.rejects(broken.expose(4317, broken.status()), /tar failed/);
  assert.equal(f.calls.spawns.length, 1);
});

test("cancellation before download and after readiness closes exposure", async (t) => {
  const f = await fixture(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.provider.expose(4317, f.provider.status(), { signal: aborted.signal }),
    /abort/i,
  );
  assert.equal(f.calls.downloads.length, 0);
  const provider = createCloudflareProvider(f.dependencies);
  const controller = new AbortController();
  const status = provider.status();
  await provider.expose(4317, status, { signal: controller.signal });
  controller.abort();
  await provider.close();
  assert.equal((await status.done).signal, "SIGTERM");
  assert.throws(() => provider.url(status), /not connected/);
});

test("cancellation interrupts downloads and pending connections without leaving a child", async (t) => {
  const downloadController = new AbortController();
  const f = await fixture(t, {
    fetcher: async (_url, { signal }) => {
      queueMicrotask(() => downloadController.abort());
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  await assert.rejects(
    f.provider.expose(4317, f.provider.status(), {
      signal: downloadController.signal,
    }),
    /abort/i,
  );
  assert.equal(f.calls.spawns.length, 0);
  const connectionController = new AbortController();
  const pending = await fixture(t);
  const provider = createCloudflareProvider({
    ...pending.dependencies,
    spawnProcess: (...args) => {
      const child = pending.dependencies.spawnProcess(...args);
      child.stderr.write = () => true;
      queueMicrotask(() => connectionController.abort());
      return child;
    },
  });
  await assert.rejects(
    provider.expose(4317, provider.status(), {
      signal: connectionController.signal,
    }),
    /exited|abort/i,
  );
  assert.deepEqual(pending.calls.kills, ["SIGTERM"]);
});

test("startup requires a registered connection, times out and kills unresponsive children", async (t) => {
  const f = await fixture(t);
  const provider = createCloudflareProvider({
    ...f.dependencies,
    startupTimeout: 20,
    shutdownTimeout: 20,
    spawnProcess: (...args) => {
      const child = f.dependencies.spawnProcess(...args);
      child.stderr.write = () => true;
      setImmediate(() =>
        child.stdout.write("https://quiet-river.trycloudflare.com\n"),
      );
      const kill = child.kill;
      child.kill = (signal) => {
        if (signal === "SIGKILL") kill(signal);
        else f.calls.kills.push(signal);
      };
      return child;
    },
  });
  await assert.rejects(provider.expose(4317, provider.status()), /Timed out/);
  assert.deepEqual(f.calls.kills, ["SIGTERM", "SIGKILL"]);
});

test("process errors and early exits reject startup; late exits invalidate the URL", async (t) => {
  for (const error of [undefined, new Error("spawn EACCES")]) {
    const f = await fixture(t);
    const provider = createCloudflareProvider({
      ...f.dependencies,
      spawnProcess: (...args) => {
        const child = f.dependencies.spawnProcess(...args);
        queueMicrotask(() => {
          if (error) child.emit("error", error);
          child.exitCode = 1;
          child.emit("close", 1, null);
        });
        return child;
      },
    });
    await assert.rejects(
      provider.expose(4317, provider.status()),
      /EACCES|exited/,
    );
  }
  const f = await fixture(t);
  const status = f.provider.status();
  await f.provider.expose(4317, status);
  const child = f.calls.children[0];
  child.exitCode = 2;
  child.emit("close", 2, null);
  assert.equal((await status.done).code, 2);
  assert.throws(() => f.provider.url(status), /not connected/);
  await f.provider.close();
});

test("pinned assets cover supported distribution platforms with SHA-256 digests", () => {
  assert.deepEqual(Object.keys(CLOUDFLARED_ASSETS).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  for (const asset of Object.values(CLOUDFLARED_ASSETS))
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
});
