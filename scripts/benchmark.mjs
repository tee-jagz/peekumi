// Usage: STRATA_PYTHON=/usr/bin/python3 node scripts/benchmark.mjs /path/to/repo [base] [head]
// Optional STRATA_BASELINE_ENGINE points to a previous engine.mjs for a before/after comparison.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { RepositoryClient } from "../src/repository-client.mjs";
const [directory, base = "HEAD~10", head = "HEAD"] = process.argv.slice(2);
if (!directory) throw Error("Provide a repository path");
const cacheDirectory = await mkdtemp(
  path.join(os.tmpdir(), "strata-benchmark-"),
);
const options = {
  python: process.env.STRATA_PYTHON || "python3",
  cacheDirectory,
};
let worker;
const measure = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - started), value };
};
try {
  let baseline;
  if (process.env.STRATA_BASELINE_ENGINE) {
    const { Repository } = await import(
      pathToFileURL(path.resolve(process.env.STRATA_BASELINE_ENGINE))
    );
    const repo = new Repository(directory, { python: options.python });
    baseline = await measure(() => repo.compare(base, head));
    console.log(
      JSON.stringify({
        stage: "baseline-cold-full",
        ms: baseline.ms,
        gzipBytes: gzipSync(JSON.stringify(baseline.value)).length,
      }),
    );
    repo.close?.();
  }
  worker = new RepositoryClient(directory, options);
  const cold = await measure(() =>
    worker.compare(base, head, { view: "overview" }),
  );
  console.log(
    JSON.stringify({
      stage: "empty-index-overview",
      ms: cold.ms,
      gzipBytes: gzipSync(JSON.stringify(cold.value)).length,
      ...(await worker.metrics()),
    }),
  );
  if (baseline)
    assert.deepEqual(
      cold.value.files.map((f) => [f.path, f.status, f.deps, f.beforeDeps]),
      baseline.value.files.map((f) => [f.path, f.status, f.deps, f.beforeDeps]),
    );
  await worker.close();
  worker = new RepositoryClient(directory, options);
  const restart = await measure(() =>
    worker.compare(base, head, { view: "overview" }),
  );
  assert.deepEqual(restart.value, cold.value);
  console.log(
    JSON.stringify({
      stage: "persisted-index-overview",
      ms: restart.ms,
      ...(await worker.metrics()),
    }),
  );
  const timings = [];
  for (let i = 0; i < 5; i++)
    timings.push(
      (await measure(() => worker.compare(base, head, { view: "overview" })))
        .ms,
    );
  console.log(
    JSON.stringify({
      stage: "warm-overview",
      medianMs: timings.sort((a, b) => a - b)[2],
      samples: timings,
      files: cold.value.files.length,
      changed: cold.value.files.filter((f) => f.status !== "unchanged").length,
    }),
  );
} finally {
  await worker?.close();
  await rm(cacheDirectory, { recursive: true, force: true });
}
