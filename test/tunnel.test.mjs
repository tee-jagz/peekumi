import test from "node:test";
import assert from "node:assert/strict";
import { createTailscaleProvider } from "../scripts/tunnel/tailscale.mjs";

function fixture(responses) {
  const calls = [];
  const provider = createTailscaleProvider((program, args) => {
    calls.push([program, ...args]);
    assert.ok(responses.length, "Unexpected tunnel command");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  return { provider, calls };
}

test("Tailscale availability preserves version and optional-install diagnostics", () => {
  const { provider, calls } = fixture(["1.2.3\n  build details"]);
  assert.deepEqual(provider.available(), { ok: true, detail: "1.2.3" });
  assert.deepEqual(calls, [["tailscale", "version"]]);
  const missing = fixture([new Error("Cannot run tailscale: ENOENT")]);
  assert.deepEqual(missing.provider.available(), {
    ok: false,
    detail: "Install Tailscale to enable its optional integration",
  });
});

test("Tailscale sharing accepts empty and matching Serve configurations", () => {
  for (const configuration of [
    {},
    {
      Web: {
        "machine.example:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
        },
      },
    },
  ]) {
    for (const host of ["machine.example.", "machine.example"]) {
      const { provider, calls } = fixture([
        JSON.stringify({ Self: { DNSName: host } }),
        JSON.stringify(configuration),
        "",
      ]);
      const status = provider.status();
      provider.expose(4317, status);
      assert.equal(provider.url(status), "https://machine.example");
      assert.deepEqual(calls, [
        ["tailscale", "status", "--json"],
        ["tailscale", "serve", "status", "--json"],
        ["tailscale", "serve", "--bg", "http://127.0.0.1:4317"],
      ]);
    }
  }
});

test("Tailscale sharing leaves another Serve configuration intact", () => {
  const { provider, calls } = fixture([
    JSON.stringify({ Self: { DNSName: "machine.example." } }),
    JSON.stringify({ Proxy: "http://127.0.0.1:9999" }),
  ]);
  const status = provider.status();
  assert.throws(() => provider.expose(4317, status), {
    message:
      "Tailscale Serve already has another configuration. Keep it intact and configure a separate HTTPS endpoint for Peekumi.",
  });
  assert.equal(calls.length, 2);
});

test("Tailscale sharing requires a DNS host before inspecting Serve", () => {
  for (const value of [{}, { Self: {} }, { Self: { DNSName: "." } }]) {
    const { provider, calls } = fixture([JSON.stringify(value)]);
    assert.throws(() => provider.status(), {
      message: "Sign into Tailscale first",
    });
    assert.deepEqual(calls, [["tailscale", "status", "--json"]]);
  }
});

test("Tailscale sharing propagates command and malformed JSON failures", () => {
  const signedIn = JSON.stringify({ Self: { DNSName: "machine.example." } });
  const failure = new Error("tailscale: command failed");
  for (const responses of [[failure], [signedIn, failure]]) {
    const { provider } = fixture(responses);
    assert.throws(
      () => provider.status(),
      (error) => error === failure,
    );
  }
  for (const responses of [["invalid JSON"], [signedIn, "invalid JSON"]]) {
    const { provider } = fixture(responses);
    assert.throws(() => provider.status(), SyntaxError);
  }
  const { provider } = fixture([signedIn, "{}", failure]);
  const status = provider.status();
  assert.throws(
    () => provider.expose(8080, status),
    (error) => error === failure,
  );
});

// The contract of a tunnel provider (docs/EXTENDING.md): the factory makes the operations
// and runs nothing; a public provider also has `close`.
test("every tunnel provider keeps the contract and runs nothing when it is made", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createCloudflareProvider } =
    await import("../scripts/tunnel/cloudflare.mjs");
  const state = await mkdtemp(join(tmpdir(), "peekumi-tunnel-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const never = () => {
    throw new Error("A provider ran something when it was made");
  };
  const providers = {
    tailscale: [createTailscaleProvider(never), false],
    cloudflare: [
      createCloudflareProvider({
        state,
        fetcher: never,
        spawnProcess: never,
        extract: never,
      }),
      true,
    ],
  };
  for (const [name, [provider, isPublic]] of Object.entries(providers)) {
    for (const operation of ["available", "status", "expose", "url"])
      assert.equal(
        typeof provider[operation],
        "function",
        `${name}.${operation}`,
      );
    if (isPublic)
      assert.equal(
        typeof provider.close,
        "function",
        `${name} is public, so it closes`,
      );
  }
});
