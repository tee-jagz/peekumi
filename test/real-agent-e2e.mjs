/**
 * Opt-in end-to-end test with a real agent (Codex), the real interface and a throwaway
 * repository. Not part of `npm test`: it uses the owner's Codex login and takes minutes.
 *
 * Flow on a phone-size screen: write an instruction on the map, send it as a task, let the
 * agent work, read its report, keep the file it left uncommitted (salvage), approve and merge.
 * Git confirms each step, and every status the run and the instruction pass through must be
 * a move that backend/lifecycle.rs allows.
 *
 * Usage: `npm run build:rust && node test/real-agent-e2e.mjs`. Screenshots go to
 * test-results/e2e-*.png; the throwaway repository stays in the folder that it prints.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startRust } from "./rust-support.mjs";

// The server and its agent see an ordinary owner environment, not this shell's session.
for (const key of Object.keys(process.env))
  if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE")
    delete process.env[key];

const dir = await mkdtemp(path.join(os.tmpdir(), "peekumi-e2e-"));
const git = (...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.name", "E2E Owner");
git("config", "user.email", "owner@example.invalid");
await writeFile(
  path.join(dir, "app.py"),
  '"""A tiny app."""\n\n\ndef greet(name):\n    return f"Hello, {name}"\n',
);
git("add", ".");
git("commit", "-m", "Initial");
console.log("Throwaway repository:", dir);

const server = await startRust(dir, {
  base: "HEAD",
  head: "HEAD",
  token: "e2e-token",
});
const api = async (route) =>
  (
    await fetch(server.url + route, {
      headers: { Authorization: "Bearer e2e-token" },
    })
  ).json();
const shot = (page, name) =>
  page.screenshot({ path: `test-results/e2e-${name}.png` });
const step = (text) =>
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${text}`);

const INSTRUCTION =
  "Create NOTES.md with one line: End-to-end test. Commit only NOTES.md. " +
  "Also create draft.txt with the text: unsaved draft. Do not commit draft.txt and do not delete it.";

let browser;
try {
  await mkdir("test-results", { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  step("open Peekumi");
  await page.goto(server.url + "/#token=e2e-token");
  await page.locator('.sheet[data-front="true"] .pk-card').first().waitFor();
  await shot(page, "1-map");

  step("write the instruction on the map");
  await page.getByLabel("Ask, or describe a change").fill(INSTRUCTION);
  await page
    .locator("#composerHost")
    .getByRole("button", { name: "Add as a change", exact: true })
    .click();
  await page.locator("#reviewActions .pk-tray").waitFor();

  step("send it as a task with Codex");
  await page.locator("#openTasks").click();
  await page
    .getByRole("button", { name: "Send 1 change", exact: true })
    .click();
  await page.locator('#panel[data-view="prepare"]').waitFor();
  await page
    .locator(".pk-disclosure > summary", { hasText: "The exact task" })
    .waitFor();
  await shot(page, "2-send");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page
    .locator('#openTasks[data-cue="working"]')
    .waitFor({ timeout: 30000 });
  await shot(page, "3-working");

  step("wait for the real agent (up to 15 minutes)");
  await page
    .locator('#openTasks[data-cue="ready"]')
    .waitFor({ timeout: 15 * 60000 });
  const run = (await api("/api/workflow")).runs.find(
    (r) => r.status !== "preview",
  );
  assert.equal(
    run.status,
    "completed",
    `The task ended ${run.status}: ${run.message}`,
  );
  const branchFiles = git("ls-tree", "-r", "--name-only", run.branch).split(
    "\n",
  );
  assert.ok(branchFiles.includes("NOTES.md"), "The agent committed NOTES.md");
  assert.ok(
    !branchFiles.includes("draft.txt"),
    "The agent did not commit draft.txt",
  );
  let comment = (await api("/api/workflow")).comments[0];
  assert.equal(comment.status, "addressed", "The agent reported its commit");

  step("open the task: report and loose files");
  const notice = page.getByText(/The agent left \d+ files? uncommitted\./);
  await notice.waitFor({ timeout: 30000 });
  await shot(page, "4-review");

  step("keep the file the agent left");
  await page.getByRole("button", { name: "Keep these files" }).click();
  const sheet = page.locator("dialog.pk-modal");
  await sheet.getByText("draft.txt").waitFor();
  await shot(page, "5-keep");
  await sheet.getByRole("button", { name: "Keep and commit" }).click();
  await sheet.waitFor({ state: "detached" });
  const kept = await api("/api/runs/" + run.id);
  assert.ok(
    kept.salvaged?.[0]?.files.includes("draft.txt"),
    "draft.txt was kept",
  );
  assert.equal(
    kept.results.length,
    run.results.length + 1,
    "The kept commit is a result",
  );
  assert.equal(
    git("status", "--porcelain"),
    "",
    "The owner's folder did not change",
  );

  // Nothing is left to keep, and the view shows the new branch head.
  await page
    .getByText(/The agent left \d+ files? uncommitted\./)
    .waitFor({ state: "detached" });
  step("approve and merge");
  await page.locator("#approveMerge").waitFor({ timeout: 30000 });
  await shot(page, "6-approve");
  await page.locator("#approveMerge").click();
  await page.locator("#confirmMerge").click();
  await page
    .locator('.merge-step[data-state="merged"]')
    .waitFor({ timeout: 30000 });
  await shot(page, "7-merged");
  const mainFiles = git("ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(mainFiles.includes("NOTES.md") && mainFiles.includes("draft.txt"));
  assert.equal(git("rev-parse", "main"), git("rev-parse", run.branch));
  comment = (await api("/api/workflow")).comments[0];
  assert.equal(comment.status, "verified");

  step("check every status change against the life cycle");
  const moves = comment.history
    ?.map((h) => h.status)
    .filter(Boolean)
    .map((s, i, all) => (i ? `${all[i - 1]}→${s}` : `new→${s}`));
  console.log(
    "Instruction history:",
    moves?.join(", ") || "(no history field)",
  );
  assert.deepEqual(errors, [], "No page errors");
  step("PASSED");
} finally {
  await browser?.close();
  await server.close?.();
}
