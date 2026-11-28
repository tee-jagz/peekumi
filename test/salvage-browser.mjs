import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { fixture, waitFor } from "./workflow-support.mjs";

// Salvage: a task whose agent left files uncommitted shows them, and the owner keeps them.
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const f = await fixture();
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      const c = await f.req("/api/comments", {
        text: "Write the result file LEAVE_LOOSE",
        sha: f.sha,
        anchor: { kind: "repo", path: "" },
      });
      const p = await f.req("/api/runs/preview", {
        agent: "codex",
        commentIds: [c.id],
      });
      await f.req("/api/runs", { previewId: p.id });
      await waitFor(
        async () => (await f.req("/api/runs/" + p.id)).status === "completed",
      );
      await page.goto(f.server.url + "/#token=" + f.server.token);
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      const notice = page.getByText("The agent left 3 files uncommitted.");
      await notice.waitFor();
      await page.screenshot({
        path: `test-results/salvage-notice-${viewport.width}.png`,
      });
      await page.getByRole("button", { name: "Keep these files" }).click();
      const sheet = page.locator("dialog.pk-modal");
      await sheet.getByText("Commit 2 files on").waitFor();
      const text = await sheet.innerText();
      assert.match(text, /module\.py[^]*Changed/);
      assert.match(text, /notes\/loose\.txt[^]*New/);
      assert.match(text, /\.env[^]*Restricted: not kept, never read/);
      await page.screenshot({
        path: `test-results/salvage-sheet-${viewport.width}.png`,
      });
      await sheet.getByRole("button", { name: "Keep and commit" }).click();
      await page.getByText("The agent left 1 file uncommitted.").waitFor();
      const run = await f.req("/api/runs/" + p.id);
      assert.equal(run.results.length, 2);
      assert.deepEqual(run.salvaged[0].files.sort(), [
        "module.py",
        "notes/loose.txt",
      ]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      console.log(
        `Salvage browser ${viewport.width}: notice → sheet → kept passed`,
      );
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
