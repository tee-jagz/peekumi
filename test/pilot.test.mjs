import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  buildSchedule,
  dryRun,
  summarizeResults,
} from "../scripts/pilot/run-pilot.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("pilot kit has 20 balanced review cases covering stale CI, skipped check and weakened test", async () => {
  const cases = JSON.parse(
    await readFile(path.join(root, "scripts/pilot/cases.json"), "utf8"),
  );
  assert.equal(cases.length, 20);
  const flaws = new Set(cases.map((c) => c.plantedFlaw).filter(Boolean));
  assert.ok(flaws.has("stale_ci"));
  assert.ok(flaws.has("skipped_check"));
  assert.ok(flaws.has("weakened_test"));

  const s1 = buildSchedule(cases, "p01");
  const s2 = buildSchedule(cases, "p02");
  assert.equal(s1.length, 20);
  assert.equal(s2.length, 20);
  assert.notEqual(s1[0].tool, s2[0].tool, "Tool order must be counterbalanced");
  assert.equal(s1.filter((c) => c.tool === "peekumi").length, 10);
  assert.equal(s1.filter((c) => c.tool === "github_ci_ai").length, 10);

  const sim = await dryRun();
  assert.equal(sim.casesCount, 20);
  assert.equal(sim.records.length, 40);
  assert.equal(sim.summary.peekumi.approvalsOnPlantedFalseEvidence, 0);
  assert.equal(sim.summary.targets.zeroFalseEvidenceApprovalsInPeekumi, true);
  assert.equal(sim.summary.targets.medianTimeAtLeast25PctFaster, true);

  // CLI dry-run smoke test
  const cli = spawnSync(
    process.execPath,
    [path.join(root, "scripts/pilot/run-pilot.mjs"), "--dry-run", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.totalRecords, 40);
  assert.equal(parsed.peekumi.approvalsOnPlantedFalseEvidence, 0);
});

test("summarizeResults reports raw counts and reverts accurately", () => {
  const summary = summarizeResults([
    {
      tool: "peekumi",
      plantedFlaw: "stale_ci",
      decision: "request-changes",
      durationMs: 30000,
      reverted: false,
    },
    {
      tool: "github_ci_ai",
      plantedFlaw: "stale_ci",
      decision: "approve",
      durationMs: 60000,
      reverted: true,
    },
  ]);
  assert.equal(summary.peekumi.approvalsOnPlantedFalseEvidence, 0);
  assert.equal(summary.github_ci_ai.approvalsOnPlantedFalseEvidence, 1);
  assert.equal(summary.github_ci_ai.recordedReverts, 1);
  assert.equal(summary.medianTimeReductionPct, 50);
});
