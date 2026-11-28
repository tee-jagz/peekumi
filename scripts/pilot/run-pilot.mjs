#!/usr/bin/env node
/**
 * @module Balanced crossover pilot runner for Peekumi verification evaluation.
 *
 * Assigns the 20 review cases from `scripts/pilot/cases.json` in a counterbalanced order
 * across two tools: `peekumi` (treatment) and `github_ci_ai` (control). Half of participants
 * start with Peekumi and half start with GitHub + CI + AI reviewer; clean and planted-flaw
 * cases are split evenly across both tools.
 *
 * Logs raw per-case decisions, elapsed time and revert tracking to JSONL, and prints a raw
 * count summary (false-evidence approvals, median times and deltas).
 *
 * Usage:
 *   node scripts/pilot/run-pilot.mjs --participant p01 --log pilot-results.jsonl
 *   node scripts/pilot/run-pilot.mjs --dry-run [--json]
 */

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const CASES_PATH = path.resolve(import.meta.dirname, "cases.json");

/** Deterministic integer hash for balancing participant assignment. */
function participantIndex(id) {
  let n = 0;
  for (const ch of String(id || "p01")) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n;
}

/** Builds a counterbalanced schedule of all 20 cases for `participantId`.
 * Splits clean and flaw cases evenly between `peekumi` and `github_ci_ai`, and alternates
 * which tool goes first based on participant parity. */
export function buildSchedule(cases, participantId) {
  const parity = participantIndex(participantId) % 2;
  const clean = cases.filter((c) => !c.plantedFlaw);
  const flawed = cases.filter((c) => Boolean(c.plantedFlaw));

  const assign = (group, offset) =>
    group.map((item, i) => ({
      ...item,
      tool: (i + parity + offset) % 2 === 0 ? "peekumi" : "github_ci_ai",
    }));

  const combined = [...assign(clean, 0), ...assign(flawed, 1)];
  const firstTool = parity === 0 ? "peekumi" : "github_ci_ai";
  const firstBlock = combined.filter((c) => c.tool === firstTool);
  const secondBlock = combined.filter((c) => c.tool !== firstTool);
  return [...firstBlock, ...secondBlock].map((c, index) => ({
    order: index + 1,
    ...c,
  }));
}

/** Computes median of a nonempty numeric array, or null when empty. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Summarizes raw pilot logs by tool without hiding individual counts. */
export function summarizeResults(records) {
  const byTool = (tool) => records.filter((r) => r.tool === tool);
  const stats = (tool) => {
    const list = byTool(tool);
    const flawed = list.filter((r) => Boolean(r.plantedFlaw));
    const clean = list.filter((r) => !r.plantedFlaw);
    const falseApprovals = flawed.filter((r) => r.decision === "approve");
    const caughtFlaws = flawed.filter((r) => r.decision === "request-changes");
    const reverts = list.filter((r) => r.reverted === true);
    return {
      totalCases: list.length,
      cleanCases: clean.length,
      plantedFlawCases: flawed.length,
      approvalsOnPlantedFalseEvidence: falseApprovals.length,
      caughtPlantedFlaws: caughtFlaws.length,
      medianDurationMs: median(list.map((r) => r.durationMs)),
      medianCleanDurationMs: median(clean.map((r) => r.durationMs)),
      recordedReverts: reverts.length,
    };
  };
  const peekumi = stats("peekumi");
  const control = stats("github_ci_ai");
  const speedGainPct =
    peekumi.medianDurationMs != null &&
    control.medianDurationMs != null &&
    control.medianDurationMs > 0
      ? Math.round(
          ((control.medianDurationMs - peekumi.medianDurationMs) /
            control.medianDurationMs) *
            1000,
        ) / 10
      : null;
  return {
    totalRecords: records.length,
    peekumi,
    github_ci_ai: control,
    medianTimeReductionPct: speedGainPct,
    targets: {
      zeroFalseEvidenceApprovalsInPeekumi:
        peekumi.approvalsOnPlantedFalseEvidence === 0,
      medianTimeAtLeast25PctFaster:
        speedGainPct != null && speedGainPct >= 25.0,
    },
  };
}

/** Simulates a deterministic dry run across 2 balanced participants to validate the kit. */
export async function dryRun() {
  const cases = JSON.parse(await readFile(CASES_PATH, "utf8"));
  const records = [];
  for (const participant of ["dry-p01", "dry-p02"]) {
    const schedule = buildSchedule(cases, participant);
    for (const item of schedule) {
      const isPeekumi = item.tool === "peekumi";
      // Dry run checks the logging pipeline: Peekumi catches every planted flaw; control
      // misses a subset and takes longer to verify raw CI / test diffs.
      const decision = item.plantedFlaw
        ? isPeekumi
          ? "request-changes"
          : item.plantedFlaw === "stale_ci"
            ? "approve"
            : "request-changes"
        : "approve";
      const durationMs = isPeekumi
        ? item.plantedFlaw
          ? 52000
          : 34000
        : item.plantedFlaw
          ? 84000
          : 61000;
      records.push({
        participant,
        order: item.order,
        caseId: item.id,
        tool: item.tool,
        plantedFlaw: item.plantedFlaw,
        expectedDecision: item.expectedDecision,
        decision,
        durationMs,
        reverted: false,
        dryRun: true,
        recordedAt: Date.now(),
      });
    }
  }
  return {
    casesCount: cases.length,
    records,
    summary: summarizeResults(records),
  };
}

function parseArgs(argv) {
  const opts = {
    participant: "p01",
    log: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--participant" && argv[i + 1]) opts.participant = argv[++i];
    else if (a === "--log" && argv[i + 1]) opts.log = argv[++i];
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dryRun) {
    const result = await dryRun();
    if (opts.json) {
      console.log(JSON.stringify(result.summary, null, 2));
    } else {
      console.log(
        `Pilot dry run complete: ${result.casesCount} cases, ${result.records.length} simulated reviews.`,
      );
      console.log(JSON.stringify(result.summary, null, 2));
    }
    process.exit(0);
  }

  const cases = JSON.parse(await readFile(CASES_PATH, "utf8"));
  const schedule = buildSchedule(cases, opts.participant);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const records = [];
  try {
    console.log(
      `Starting pilot session for ${opts.participant} (${schedule.length} cases).`,
    );
    for (const item of schedule) {
      console.log(
        `\n[${item.order}/${schedule.length}] Tool: ${item.tool} | Case ${item.id}: ${item.title} (${item.language})`,
      );
      console.log(`Context: ${item.summary}`);
      const started = Date.now();
      let decision = "";
      while (!["approve", "request-changes", "defer"].includes(decision)) {
        decision = (
          await rl.question("Decision (approve / request-changes / defer): ")
        )
          .trim()
          .toLowerCase();
      }
      const durationMs = Date.now() - started;
      const entry = {
        participant: opts.participant,
        order: item.order,
        caseId: item.id,
        tool: item.tool,
        plantedFlaw: item.plantedFlaw,
        expectedDecision: item.expectedDecision,
        decision,
        durationMs,
        reverted: null,
        recordedAt: Date.now(),
      };
      records.push(entry);
      if (opts.log)
        await appendFile(opts.log, JSON.stringify(entry) + "\n", "utf8");
    }
  } finally {
    rl.close();
  }
  console.log("\nRaw summary:");
  console.log(JSON.stringify(summarizeResults(records), null, 2));
}
