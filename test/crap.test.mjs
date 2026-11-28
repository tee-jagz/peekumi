import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { command } from "./reference/engine.mjs";
import { startRust, RUST_BINARY } from "./rust-support.mjs";

const git = (cwd, ...args) => command("git", ["-C", cwd, ...args]);

// Runs a tiny stdlib Python trace-based test runner that writes valid LCOV for calc.py,
// so the test needs zero third-party Python packages (no pytest/coverage install needed).
const LCOV_RUNNER = `
import pathlib, sys, trace

tracer = trace.Trace(count=True, trace=False)
import test_calc
tracer.runfunc(test_calc.run_tests)
results = tracer.results()

counts = {}
for (filename, lineno), hits in results.counts.items():
    p = pathlib.Path(filename).resolve()
    try:
        rel = p.relative_to(pathlib.Path.cwd().resolve()).as_posix()
    except ValueError:
        continue
    if rel == "calc.py":
        counts[lineno] = hits

# Include all non-empty code lines in calc.py so uncovered branches appear as DA:<line>,0.
src_lines = pathlib.Path("calc.py").read_text().splitlines()
out = ["TN:", "SF:calc.py"]
for idx, text in enumerate(src_lines, start=1):
    s = text.strip()
    if not s or s.startswith("#") or s.startswith("def "):
        continue
    out.append(f"DA:{idx},{counts.get(idx, 0)}")
out.append("end_of_record")
pathlib.Path("coverage").mkdir(exist_ok=True)
pathlib.Path("coverage/lcov.info").write_text("\\n".join(out) + "\\n")
print("LCOV_WRITTEN")
`;

const CALC_BEFORE = `def price(amount, tier):
    if tier == "vip":
        return amount * 0.8
    return amount
`;

// High complexity (>= 10) with low coverage (~20% of lines) -> CRAP > 30 (risky!).
const CALC_AFTER = `def price(amount, tier):
    if tier == "vip":
        return amount * 0.8
    if tier == "partner":
        if amount < 0:
            return 0
        if amount > 1000 and tier != "trial":
            amount = amount * 0.7
        elif amount > 500 or amount == 250:
            amount = amount * 0.8
        elif amount > 100:
            amount = amount * 0.9
        for step in range(3):
            if step > 1:
                amount -= 1
            else:
                amount -= 0.5
        if amount < 10:
            return 10
        return amount
    return amount
`;

const TEST_CALC = `import calc

def run_tests():
    assert calc.price(100, "vip") == 80.0
    assert calc.price(10, "regular") == 10
`;

test("CRAP reports exact before and after scores for changed Python functions and 'not available' for other languages", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peekumi-crap-test-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "peekumi-crap-state-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Peekumi Test");
  await git(dir, "config", "user.email", "test@example.com");

  const config = {
    version: 1,
    groups: {},
    rules: [],
    checks: {
      items: [
        {
          id: "py-cov",
          name: "Python unit tests with coverage",
          command: ["python3", "run_cov.py"],
          coverage: "coverage/lcov.info",
          timeoutSeconds: 30,
        },
      ],
    },
  };

  await writeFile(path.join(dir, ".peekumi.json"), JSON.stringify(config));
  await writeFile(path.join(dir, "run_cov.py"), LCOV_RUNNER);
  await writeFile(path.join(dir, "calc.py"), CALC_BEFORE);
  await writeFile(path.join(dir, "test_calc.py"), TEST_CALC);
  await writeFile(path.join(dir, "view.ts"), "export const x = 1;\n");
  await writeFile(path.join(dir, "lib.rs"), "pub fn a() -> i32 { 1 }\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "Base commit");
  const start = (await git(dir, "rev-parse", "HEAD")).toString().trim();

  await writeFile(path.join(dir, "calc.py"), CALC_AFTER);
  await writeFile(path.join(dir, "view.ts"), "export const x = 2;\n");
  await writeFile(path.join(dir, "lib.rs"), "pub fn a() -> i32 { 2 }\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "Add uncovered complex branches");
  const head = (await git(dir, "rev-parse", "HEAD")).toString().trim();

  // Run sandboxed verification on both start and head so Peekumi records real coverage for both commits.
  for (const commit of [start, head]) {
    const res = spawnSync(
      RUST_BINARY,
      [
        "verify",
        dir,
        "--state-dir",
        state,
        "--start",
        start,
        "--head",
        commit,
        "--json",
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
  }

  const server = await startRust(dir, {
    base: start,
    head,
    stateDirectory: state,
  });
  t.after(() => server.close());

  const response = await fetch(
    `${server.url}/api/crap?base=${start}&head=${head}`,
    { headers: { Authorization: `Bearer ${server.token}` } },
  );
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.threshold, 30, JSON.stringify(data));
  assert.equal(data.filesChanged, 3, JSON.stringify(data));
  assert.equal(data.filesAnalysed, 1, JSON.stringify(data));
  assert.equal(data.riskyCount, 1, JSON.stringify(data));

  // Python function has measured before (low CRAP) and after (risky CRAP > 30).
  const fn = data.functions.find((f) => f.key === "calc.py::price");
  assert.ok(fn, JSON.stringify(data));
  assert.equal(fn.before.state, "measured");
  assert.equal(fn.after.state, "measured");
  assert.ok(
    fn.before.crap < 10,
    `Expected low before CRAP, got ${fn.before.crap}`,
  );
  assert.ok(
    fn.after.crap > 30,
    `Expected risky after CRAP > 30, got ${fn.after.crap}`,
  );
  assert.equal(fn.after.risky, true);
  assert.equal(fn.after.commit, head);
  assert.ok(fn.after.verifyRunId);
  assert.equal(fn.after.checkId, "py-cov");
  assert.equal(fn.after.artifactPath, "coverage/lcov.info");

  // Non-Python changed files explicitly report "CRAP not available" with their language reason.
  const tsExcl = data.excludedFiles.find((e) => e.path === "view.ts");
  const rsExcl = data.excludedFiles.find((e) => e.path === "lib.rs");
  assert.ok(tsExcl && /CRAP not available for typescript/i.test(tsExcl.reason));
  assert.ok(rsExcl && /CRAP not available for rust/i.test(rsExcl.reason));
});
