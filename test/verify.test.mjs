import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { command } from "./reference/engine.mjs";
import { startRust, RUST_BINARY } from "./rust-support.mjs";
import { fixture, waitFor } from "./workflow-support.mjs";

const git = (cwd, ...args) => command("git", ["-C", cwd, ...args]);

async function makeRepo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peekumi-verify-test-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "peekumi-verify-state-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Peekumi Test");
  await git(dir, "config", "user.email", "test@example.com");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.dirname(full), { recursive: true }),
    );
    await writeFile(full, content);
  }
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "Initial commit");
  const start = (await git(dir, "rev-parse", "HEAD")).toString().trim();
  return {
    dir,
    start,
    state,
    async commit(updates, message = "Next commit") {
      for (const [rel, content] of Object.entries(updates)) {
        const full = path.join(dir, rel);
        await import("node:fs/promises").then((fs) =>
          fs.mkdir(path.dirname(full), { recursive: true }),
        );
        await writeFile(full, content);
      }
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", message);
      return (await git(dir, "rev-parse", "HEAD")).toString().trim();
    },
    async close() {
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
}

function runVerify(repoDir, stateDir, start, head, extra = []) {
  const res = spawnSync(
    RUST_BINARY,
    [
      "verify",
      repoDir,
      "--state-dir",
      stateDir,
      "--start",
      start,
      "--head",
      head,
      "--json",
      ...extra,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

test("sandboxed verify proves all 5 isolation guarantees and never modifies the checkout", async (t) => {
  // Create a unique secret file in the real $HOME to prove the sandbox cannot read it.
  const secretName = `.peekumi-verify-secret-${process.pid}-${Date.now()}`;
  const secretPath = path.join(os.homedir(), secretName);
  const outsideWrite = path.join(
    os.tmpdir(),
    `peekumi-outside-${process.pid}-${Date.now()}`,
  );
  await writeFile(secretPath, "TOP_SECRET_VALUE_DO_NOT_LEAK\n", {
    mode: 0o600,
  });
  t.after(async () => {
    await rm(secretPath, { force: true });
    await rm(outsideWrite, { force: true });
  });

  const probeScript = `
import os, pathlib, socket, sys

# 1. Must not have a .git directory in the archived copy.
assert not pathlib.Path(".git").exists(), ".git must not exist in archive"

# 2. Must not be able to read a secret file in the user's real home folder.
secret_path = sys.argv[1]
try:
    data = pathlib.Path(secret_path).read_text()
    raise AssertionError(f"LEAKED SECRET: {data}")
except (PermissionError, OSError):
    pass

# 3. Must not be able to reach the network.
try:
    s = socket.create_connection(("1.1.1.1", 80), timeout=2)
    s.close()
    raise AssertionError("NETWORK ACCESS SUCCEEDED")
except OSError:
    pass

# 4. Must not be able to write outside the private copy.
outside = sys.argv[2]
try:
    pathlib.Path(outside).write_text("escaped")
    raise AssertionError("OUTSIDE WRITE SUCCEEDED")
except (PermissionError, OSError):
    pass

# 5. Must not see ambient secret env vars or real HOME.
assert os.environ.get("PEEKUMI_TOKEN") is None
assert os.environ.get("HOME") != str(pathlib.Path(secret_path).parent)
print("ALL_ISOLATION_CHECKS_PASSED")
`;

  const repo = await makeRepo({
    "probe.py": probeScript,
    "app.py": "def ok():\n    return True\n",
    ".peekumi.json": JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        items: [
          {
            id: "isolation",
            name: "Sandbox isolation probe",
            command: ["python3", "probe.py", secretPath, outsideWrite],
            timeoutSeconds: 30,
          },
        ],
      },
    }),
  });
  t.after(() => repo.close());

  const head = await repo.commit({ "app.py": "def ok():\n    return 42\n" });
  // Leave an uncommitted dirty file in the checkout to prove verify never touches it.
  await writeFile(path.join(repo.dir, "dirty.txt"), "keep me\n");
  const beforeStatus = (
    await git(repo.dir, "status", "--porcelain")
  ).toString();

  const res = runVerify(repo.dir, repo.state, repo.start, head);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.json.state, "passed");
  assert.equal(res.json.sandbox.network, "denied");
  assert.equal(res.json.sandbox.noGitDir, true);
  assert.equal(res.json.sandbox.cleanEnv, true);
  assert.match(res.json.checks[0].output, /ALL_ISOLATION_CHECKS_PASSED/);

  // Outside file must not exist, and checkout status must be completely unchanged.
  await assert.rejects(() => access(outsideWrite));
  assert.equal(
    (await git(repo.dir, "status", "--porcelain")).toString(),
    beforeStatus,
  );
  assert.equal(
    (await git(repo.dir, "rev-parse", "HEAD")).toString().trim(),
    head,
  );
});

test("verify uses the start commit checks even when head tampers with .peekumi.json, and enforces exit codes 0/1/2 and timeouts", async (t) => {
  const repo = await makeRepo({
    "app.py": "VALUE = 1\n",
    "check.py": "import app\nassert app.VALUE == 1, f'bad {app.VALUE}'\n",
    ".peekumi.json": JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        items: [
          {
            id: "unit",
            name: "Assert VALUE == 1",
            command: ["python3", "check.py"],
            timeoutSeconds: 20,
          },
        ],
      },
    }),
  });
  t.after(() => repo.close());

  // Agent breaks app.py AND tampers with .peekumi.json in head to replace the check with `true`.
  const tamperedHead = await repo.commit(
    {
      "app.py": "VALUE = 999\n",
      ".peekumi.json": JSON.stringify({
        version: 1,
        groups: {},
        rules: [],
        checks: {
          items: [
            {
              id: "unit",
              name: "Tampered pass",
              command: ["python3", "-c", "print('fake pass')"],
            },
          ],
        },
      }),
    },
    "Break app and weaken .peekumi.json",
  );

  // Verify MUST run start commit's check -> fails with exit code 1 and flags configChanged!
  const failed = runVerify(repo.dir, repo.state, repo.start, tamperedHead);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.json.state, "failed");
  assert.equal(failed.json.configCommit, repo.start);
  assert.equal(failed.json.configChanged, true);
  assert.equal(failed.json.checks[0].observed, "failed");
  assert.match(failed.json.checks[0].output, /bad 999/);

  // Missing checks section returns exit code 2 (blocked).
  const noChecksRepo = await makeRepo({ "a.py": "x = 1\n" });
  t.after(() => noChecksRepo.close());
  const blocked = runVerify(
    noChecksRepo.dir,
    noChecksRepo.state,
    noChecksRepo.start,
    noChecksRepo.start,
  );
  assert.equal(blocked.status, 2);
  assert.equal(blocked.json.state, "blocked");

  // Explicit --config-ref lets the owner run checks from a newer trusted branch (e.g. main)
  // against an older branch whose start commit had no checks, while rejecting any unreviewed
  // commit in start..head (both head and intermediate commits like branch~1).
  await writeFile(path.join(noChecksRepo.dir, "a.py"), "x = 2\n");
  await git(noChecksRepo.dir, "checkout", "-qb", "agent-work");
  await git(noChecksRepo.dir, "add", "a.py");
  await git(noChecksRepo.dir, "commit", "-qm", "Agent commit 1 before checks");
  await writeFile(path.join(noChecksRepo.dir, "b.py"), "y = 3\n");
  await git(noChecksRepo.dir, "add", "b.py");
  await git(noChecksRepo.dir, "commit", "-qm", "Agent commit 2 before checks");
  const oldAgentHead = (await git(noChecksRepo.dir, "rev-parse", "HEAD"))
    .toString()
    .trim();
  const oldAgentParent = (await git(noChecksRepo.dir, "rev-parse", "HEAD~1"))
    .toString()
    .trim();
  // Descendant commit after head (e.g. newer agent tip) and side branch off start must also be rejected.
  await writeFile(path.join(noChecksRepo.dir, "c.py"), "z = 4\n");
  await git(noChecksRepo.dir, "add", "c.py");
  await git(noChecksRepo.dir, "commit", "-qm", "Agent descendant commit");
  const agentDescendant = (await git(noChecksRepo.dir, "rev-parse", "HEAD"))
    .toString()
    .trim();
  await git(
    noChecksRepo.dir,
    "checkout",
    "-qb",
    "side-branch",
    noChecksRepo.start,
  );
  await writeFile(path.join(noChecksRepo.dir, "side.py"), "s = 1\n");
  await git(noChecksRepo.dir, "add", "side.py");
  await git(noChecksRepo.dir, "commit", "-qm", "Untrusted side branch");
  const sideBranchTip = (await git(noChecksRepo.dir, "rev-parse", "HEAD"))
    .toString()
    .trim();
  await git(noChecksRepo.dir, "checkout", "-q", "main");
  await writeFile(
    path.join(noChecksRepo.dir, ".peekumi.json"),
    JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        items: [
          {
            id: "check-x",
            name: "Check x is 2",
            command: [
              "python3",
              "-c",
              "import a; assert a.x == 2, f'got {a.x}'",
            ],
          },
        ],
      },
    }),
  );
  await git(noChecksRepo.dir, "add", ".peekumi.json");
  await git(noChecksRepo.dir, "commit", "-qm", "Add checks on main");
  const mainWithChecks = (await git(noChecksRepo.dir, "rev-parse", "HEAD"))
    .toString()
    .trim();
  const fromMain = runVerify(
    noChecksRepo.dir,
    noChecksRepo.state,
    noChecksRepo.start,
    oldAgentHead,
    ["--config-ref", "main"],
  );
  assert.equal(fromMain.status, 0, fromMain.stdout + fromMain.stderr);
  assert.equal(fromMain.json.state, "passed");
  assert.equal(fromMain.json.configCommit, mainWithChecks);
  assert.equal(fromMain.json.configRef, "main");
  for (const untrustedRef of [
    oldAgentHead,
    oldAgentParent,
    agentDescendant,
    sideBranchTip,
  ]) {
    const rejected = runVerify(
      noChecksRepo.dir,
      noChecksRepo.state,
      noChecksRepo.start,
      oldAgentHead,
      ["--config-ref", untrustedRef],
    );
    assert.equal(rejected.status, 2);
    assert.equal(rejected.json.state, "blocked");
    assert.match(rejected.json.reason, /Untrusted configRef/);
  }

  // Timeout kills the process group and marks observed = timed_out (exit 1).
  const slowRepo = await makeRepo({
    ".peekumi.json": JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        items: [
          {
            id: "hang",
            name: "Slow check",
            command: ["python3", "-c", "import time; time.sleep(30)"],
            timeoutSeconds: 1,
          },
        ],
      },
    }),
  });
  t.after(() => slowRepo.close());
  const timedOut = runVerify(
    slowRepo.dir,
    slowRepo.state,
    slowRepo.start,
    slowRepo.start,
  );
  assert.equal(timedOut.status, 1);
  assert.equal(timedOut.json.checks[0].timedOut, true);
  assert.equal(timedOut.json.checks[0].observed, "timed_out");
});

test("prepare populates cache in sandbox and check phase mounts cache read-only", async (t) => {
  const repo = await makeRepo({
    "deps.lock": "v1\n",
    "check_cache.py": `
import os, pathlib
cache = pathlib.Path(os.environ["PEEKUMI_VERIFY_CACHE"])
assert (cache / "vendor" / "lib.txt").read_text().strip() == "prepared-ok"
# Cache must be read-only in check phase!
try:
    (cache / "mutated.txt").write_text("nope")
    raise AssertionError("CACHE WRITE SUCCEEDED IN CHECK PHASE")
except (PermissionError, OSError):
    pass
assert pathlib.Path("vendor/lib.txt").read_text().strip() == "prepared-ok"
print("CACHE_READONLY_VERIFIED")
`,
    ".peekumi.json": JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        prepare: {
          command: [
            "python3",
            "-c",
            "import pathlib; pathlib.Path('vendor').mkdir(exist_ok=True); pathlib.Path('vendor/lib.txt').write_text('prepared-ok')",
          ],
          cacheKey: ["deps.lock"],
          cacheDirs: ["vendor"],
        },
        items: [
          {
            id: "cache-check",
            name: "Verify read-only cache",
            command: ["python3", "check_cache.py"],
          },
        ],
      },
    }),
  });
  t.after(() => repo.close());

  const res = runVerify(repo.dir, repo.state, repo.start, repo.start, [
    "--prepare",
  ]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.json.state, "passed");
  assert.equal(res.json.sandbox.readOnlyCache, true);
  assert.match(res.json.checks[0].output, /CACHE_READONLY_VERIFIED/);
});

test("verify HTTP API starts runs, lists runs for a commit, and auto-runs when an agent finishes", async (t) => {
  const f = await fixture({
    files: {
      ".peekumi.json": JSON.stringify({
        version: 1,
        groups: {},
        rules: [],
        checks: {
          items: [
            {
              id: "result-exists",
              name: "Agent result file exists",
              command: [
                "python3",
                "-c",
                "import pathlib; assert pathlib.Path('agent-result.txt').is_file(); print('FOUND_RESULT')",
              ],
            },
          ],
        },
      }),
    },
  });
  t.after(() => f.close());

  // 1. Agent completes a task -> Peekumi automatically triggers an offline verify run!
  const c = await f.req("/api/comments", {
    text: "Write the result file",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "codex",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  const taskRun = await waitFor(async () => {
    const r = await f.req("/api/runs/" + p.id);
    return r.status === "completed" && r;
  });
  const head = taskRun.results.at(-1);

  const autoVerify = await waitFor(async () => {
    const { runs } = await f.req(`/api/verify/runs?head=${head}`);
    const found = runs.find((r) => r.runId === p.id && r.state !== "running");
    return found || false;
  });
  assert.equal(autoVerify.trigger, "auto");
  assert.equal(autoVerify.state, "passed");
  assert.match(autoVerify.checks[0].output, /FOUND_RESULT/);

  // Single-run read endpoint matches.
  const single = await f.req(`/api/verify/runs/${autoVerify.id}`);
  assert.equal(single.id, autoVerify.id);
  assert.equal(single.state, "passed");

  // Merge status attaches the latest verification run for the four-part review sheet.
  const status = await f.req(`/api/runs/${p.id}/merge`);
  assert.equal(status.verification?.id, autoVerify.id);

  // Phase 3: owner-only acceptance check binds into approvalRecord and invalidates on edit.
  const shellAcc = await f.req(`/api/runs/${p.id}/acceptance`, {
    command: ["sh", "-c", "true"],
  });
  assert.ok(shellAcc.acceptanceCheck?.commandHash);

  const accSet = await f.req(`/api/runs/${p.id}/acceptance`, {
    command: [
      "python3",
      "-c",
      "import pathlib; assert pathlib.Path('agent-result.txt').is_file()",
    ],
    expectFailOnStart: true,
  });
  assert.ok(accSet.acceptanceCheck?.commandHash);

  const runWithAcc = await f.req("/api/verify/runs", {
    start: status.start,
    head,
    runId: p.id,
  });
  const accVerify = await waitFor(async () => {
    const r = await f.req(`/api/verify/runs/${runWithAcc.id}`);
    return r.state !== "running" && r;
  });
  assert.equal(accVerify.state, "passed");
  assert.equal(accVerify.acceptanceResult?.observed, "fail_to_pass");
  assert.equal(
    accVerify.acceptanceResult?.commandHash,
    accSet.acceptanceCheck.commandHash,
  );

  // Approve binds acceptanceHash; changing the acceptance command invalidates prior approval.
  const approved = await f.req(`/api/runs/${p.id}/approve`, {
    start: status.start,
    head,
  });
  assert.equal(
    approved.approval.acceptanceHash,
    accSet.acceptanceCheck.commandHash,
  );
  assert.equal(approved.status.approvalCurrent, true);

  const accChanged = await f.req(`/api/runs/${p.id}/acceptance`, {
    command: ["python3", "-c", "assert 2 == 2"],
    expectFailOnStart: false,
  });
  assert.equal(accChanged.status.approvalCurrent, false);
  const blockedMerge = await f.req(`/api/runs/${p.id}/merge`, {
    target: accChanged.status.targetSha,
    head,
  });
  assert.match(blockedMerge.error || "", /Approve this task before you merge/);

  // Phase 1: GET /api/inbox returns waiting tasks + committed local branches, never uncommitted files.
  await writeFile(path.join(f.dir, "uncommitted-noise.txt"), "dirty\n");
  await git(f.dir, "checkout", "-qb", "feature/committed-branch");
  await writeFile(path.join(f.dir, "feat.py"), "v = 1\n");
  await git(f.dir, "add", "feat.py");
  await git(f.dir, "commit", "-qm", "Committed branch work");
  await git(f.dir, "checkout", "-q", "main");
  const inbox = await f.req("/api/inbox");
  assert.ok(
    inbox.needsYou.some((item) => item.kind === "task" && item.id === p.id),
  );
  assert.ok(
    inbox.needsYou.some(
      (item) =>
        item.kind === "branch" && item.name === "feature/committed-branch",
    ),
  );
  assert.ok(
    !inbox.needsYou.some((item) =>
      String(item.title || "").includes("uncommitted"),
    ),
  );
});

test("Phase 2: scoped paths skip honestly, match renames/deletions, and standalone fail-to-pass catches weak/inconclusive/dash-arg tests and inline Rust tests", async (t) => {
  const repo = await makeRepo({
    "backend/a.txt": "v1\n",
    "backend/del.txt": "remove me\n",
    "docs/guide.md": "hello\n",
    "calc.py": "def double(x):\n    return x\n",
    "src/lib.rs": "pub fn one() -> i32 { 1 }\n",
    ".peekumi.json": JSON.stringify({
      version: 1,
      groups: {},
      rules: [],
      checks: {
        newTests: {
          command: ["python3", "{files}"],
        },
        items: [
          {
            id: "backend-only",
            name: "Backend scoped check",
            command: ["python3", "-c", "print('BACKEND_RAN')"],
            paths: ["backend/**"],
          },
        ],
      },
    }),
  });
  t.after(() => repo.close());

  // 1. Docs-only change: backend-only check is skipped -> all-skipped gives zero passing evidence!
  await writeFile(path.join(repo.dir, "docs/guide.md"), "hello updated\n");
  await git(repo.dir, "add", "docs/guide.md");
  await git(repo.dir, "commit", "-qm", "Docs only");
  const docsHead = (await git(repo.dir, "rev-parse", "HEAD")).toString().trim();
  const skippedRun = runVerify(repo.dir, repo.state, repo.start, docsHead);
  assert.equal(skippedRun.json.state, "skipped");
  assert.equal(skippedRun.json.checks[0].observed, "skipped");
  assert.equal(skippedRun.json.checks[0].matched, false);
  assert.match(skippedRun.json.summary, /no passing evidence/i);

  // 2. Rename OUT of backend/ still matches backend/** via old rename side!
  await git(repo.dir, "checkout", "-qb", "rename-out", repo.start);
  await git(repo.dir, "mv", "backend/a.txt", "docs/moved.txt");
  await git(repo.dir, "commit", "-qm", "Rename out of backend");
  const renameHead = (await git(repo.dir, "rev-parse", "HEAD"))
    .toString()
    .trim();
  const renameRun = runVerify(repo.dir, repo.state, repo.start, renameHead);
  assert.equal(renameRun.status, 0);
  assert.equal(renameRun.json.checks[0].observed, "passed");

  // 3. Deletion inside backend/ still matches backend/**!
  await git(repo.dir, "checkout", "-qb", "delete-in-be", repo.start);
  await git(repo.dir, "rm", "-q", "backend/del.txt");
  await git(repo.dir, "commit", "-qm", "Delete backend file");
  const delHead = (await git(repo.dir, "rev-parse", "HEAD")).toString().trim();
  const delRun = runVerify(repo.dir, repo.state, repo.start, delHead);
  assert.equal(delRun.status, 0);
  assert.equal(delRun.json.checks[0].observed, "passed");

  // 4. Standalone fail-to-pass:
  //    - test_real.py fails assertion on start overlay and passes on head -> fail_to_pass
  //    - test_weak.py passes on start overlay -> weak_test (causes run state = failed!)
  //    - test_inconc.py imports brand_new_mod missing on start -> inconclusive
  //    - test/-dash-name.py has leading dash -> prefixed with ./ in argv (never parsed as option!)
  //    - src/lib.rs edits inline #[cfg(test)] -> recorded in inlineTestFiles!
  await git(repo.dir, "checkout", "-qb", "new-tests-branch", repo.start);
  await writeFile(
    path.join(repo.dir, "calc.py"),
    "def double(x):\n    return x * 2\n",
  );
  await writeFile(path.join(repo.dir, "brand_new_mod.py"), "VAL = 42\n");
  await mkdir(path.join(repo.dir, "test"), { recursive: true });
  await writeFile(
    path.join(repo.dir, "test/test_real.py"),
    "import sys; sys.path.insert(0, '.')\nimport calc\nassert calc.double(5) == 10, f'expected 10 got {calc.double(5)}'\n",
  );
  await writeFile(
    path.join(repo.dir, "test/test_weak.py"),
    "assert 1 + 1 == 2\n",
  );
  await writeFile(
    path.join(repo.dir, "test/test_inconc.py"),
    "import sys; sys.path.insert(0, '.')\nimport brand_new_mod\nassert brand_new_mod.VAL == 42\n",
  );
  await writeFile(
    path.join(repo.dir, "test/-dash-name.py"),
    "import sys; sys.path.insert(0, '.')\nimport calc\nassert calc.double(3) == 6\n",
  );
  await writeFile(
    path.join(repo.dir, "src/lib.rs"),
    "pub fn one() -> i32 { 1 }\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn ok() { assert_eq!(super::one(), 1); }\n}\n",
  );
  await git(repo.dir, "add", "-A");
  await git(
    repo.dir,
    "commit",
    "-qm",
    "Add real, weak, inconclusive, dash-arg, and inline tests",
  );
  const ntHead = (await git(repo.dir, "rev-parse", "HEAD")).toString().trim();

  const ntRun = runVerify(repo.dir, repo.state, repo.start, ntHead);
  assert.equal(ntRun.status, 1, ntRun.stdout + ntRun.stderr);
  assert.equal(ntRun.json.state, "failed");
  const byFile = new Map(
    ntRun.json.checks
      .filter((c) => c.kind === "new_test")
      .map((c) => [c.file, c]),
  );
  assert.equal(byFile.get("test/test_real.py")?.observed, "fail_to_pass");
  assert.equal(byFile.get("test/test_real.py")?.crapExcluded, true);
  assert.equal(byFile.get("test/test_weak.py")?.observed, "weak_test");
  assert.equal(byFile.get("test/test_inconc.py")?.observed, "inconclusive");
  assert.equal(byFile.get("test/-dash-name.py")?.observed, "fail_to_pass");
  assert.deepEqual(byFile.get("test/-dash-name.py")?.command, [
    "python3",
    "./test/-dash-name.py",
  ]);
  assert.deepEqual(ntRun.json.inlineTestFiles, ["src/lib.rs"]);
});
