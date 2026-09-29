// Compare both backends with identical API requests and immutable Git revisions.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RepositoryClient } from "../test/reference/repository-client.mjs";
import { createServer } from "../test/reference/server.mjs";
import { startRust, rustRpc } from "../test/rust-support.mjs";
const [directory, base = "HEAD~10", head = "HEAD"] = process.argv.slice(2);
if (!directory)
  throw Error(
    "Usage: node scripts/benchmark-rust.mjs /path/to/repo [base] [head]",
  );
const state = await mkdtemp(path.join(os.tmpdir(), "strata-backends-"));
const token = "benchmark-local-token";
const options = {
  python:
    process.env.STRATA_PYTHON ||
    (process.platform === "darwin" ? "/usr/bin/python3" : "python3"),
  cacheDirectory: path.join(state, "node"),
};
const query = new URLSearchParams({ base, head, view: "overview" });
let node, server, rust, reference;
const get = async (url, route) => {
  const response = await fetch(url + route, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  return {
    value: await response.json(),
    bytes: Number(response.headers.get("content-length")),
  };
};
async function measure(label, url) {
  const start = performance.now();
  const overview = await get(url, "/api/compare?" + query);
  const coldMs = Math.round(performance.now() - start);
  if (reference) assert.deepEqual(overview.value, reference);
  else reference = overview.value;
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await get(url, "/api/compare?" + query);
    samples.push(Math.round(performance.now() - start));
  }
  console.log(
    JSON.stringify({
      backend: label,
      coldRequestMs: coldMs,
      warmMedianMs: samples.toSorted((a, b) => a - b)[2],
      warmSamples: samples,
      gzipBytes: overview.bytes,
      files: overview.value.files.length,
      changed: overview.value.files.filter((f) => f.status !== "unchanged")
        .length,
    }),
  );
}
try {
  node = new RepositoryClient(directory, options);
  await node.resolve("HEAD");
  server = createServer(node, { token, base, head });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port;
  await measure("node-empty-index", url);
  rust = await startRust(directory, {
    base,
    head,
    token,
    stateDirectory: path.join(state, "rust"),
    python: options.python,
  });
  await measure("rust-empty-index", rust.url);
  const q = new URLSearchParams({ base: reference.base, head: reference.head });
  const expected = (await get(url, "/api/compare?" + q)).value;
  assert.deepEqual((await get(rust.url, "/api/compare?" + q)).value, expected);
  for (const file of [
    expected.files.find((f) => f.path.endsWith("services/database.py")),
    expected.files.find((f) => f.path.endsWith(".ts") && f.symbols.length),
  ])
    if (file)
      assert.deepEqual(
        (
          await get(
            rust.url,
            "/api/source?" + q + "&path=" + encodeURIComponent(file.path),
          )
        ).value,
        (
          await get(
            url,
            "/api/source?" + q + "&path=" + encodeURIComponent(file.path),
          )
        ).value,
      );
  await rust.close();
  rust = await startRust(directory, {
    base,
    head,
    token,
    stateDirectory: path.join(state, "rust"),
    python: options.python,
  });
  await measure("rust-existing-index", rust.url);
  const results = await rustRpc(directory, path.join(state, "rust"), [
    {
      method: "compare",
      args: [reference.base, reference.head, { view: "overview" }],
    },
    { method: "metrics", args: [] },
  ]);
  assert.equal(results[1].result.parsed, 0);
  console.log(
    JSON.stringify({
      parity: "full comparison and selected source verified",
      persisted: results[1].result,
    }),
  );
} finally {
  await rust?.close();
  if (server) await new Promise((r) => server.close(r));
  await node?.close();
  await rm(state, { recursive: true, force: true });
}
