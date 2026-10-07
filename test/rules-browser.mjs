/** Dependency rules in the browser: a task that adds a rule break says so before Approve; the
 * rule summary shows the breaks a comparison adds and each rule's coverage; and "Forbid this
 * dependency" on a relationship starts an instruction that asks for a rule. Phone and desktop. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { fixture, waitFor } from "./workflow-support.mjs";
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const f = await fixture({
      files: {
        ".peekumi.json": JSON.stringify({
          version: 1,
          groups: { ui: ["ui/**"], db: ["db/**"] },
          rules: [
            {
              id: "ui-no-db",
              from: "ui",
              to: ["db"],
              kinds: ["imports", "calls"],
              message: "The UI goes through services.",
            },
          ],
        }),
        "ui/__init__.py": "",
        "ui/view.py": "def show():\n    return 1\n",
        "db/__init__.py": "",
        "db/store.py": "def save():\n    return 2\n",
      },
    });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      // A task whose commit makes ui/view.py import db/store.py.
      const c = await f.req("/api/comments", {
        text: "Write the result file. CHECK_RULES",
        sha: f.sha,
        anchor: { kind: "repo", path: "" },
      });
      const p = await f.req("/api/runs/preview", {
        commentIds: [c.id],
        using: { agent: "claude" },
      });
      await f.req("/api/runs", { previewId: p.id });
      await waitFor(
        async () => (await f.req("/api/runs/" + p.id)).status === "completed",
      );
      await page.goto(f.server.url + "/#token=" + f.server.token);
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".node").first().waitFor();

      // The task names the break before Approve.
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      const note = page.locator(".rule-added-note");
      await note.waitFor();
      assert.match(
        await note.innerText(),
        /adds 1 dependency rule break: ui-no-db \(view\.py → store\.py\)/,
      );
      await page.screenshot({
        path: `test-results/rules-task-${viewport.width}.png`,
      });

      // On the task's branch, the rule summary shows the added break and the coverage.
      await page
        .getByRole("button", { name: "Explore changes", exact: true })
        .click();
      await page.locator("#taskReturn:not([hidden])").waitFor();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="dependencies"]').click();
      const summary = page.locator(".rule-summary > summary");
      await summary.waitFor();
      assert.match(
        await summary.innerText(),
        /^1 new rule break · 1 rule violation · 1 rule/,
      );
      await summary.click();
      assert.match(
        await page.locator(".rule-summary .rule-added").first().innerText(),
        /ui-no-db: ui\/view\.py → db\/store\.py \(imports\)/,
      );
      assert.match(
        await page.locator(".rule-summary .rule-coverage").first().innerText(),
        /^ui-no-db: checked \d+, broke 1, unresolved \d+$/,
      );

      // "Forbid this dependency" on the relationship starts an instruction draft.
      await page.evaluate(() =>
        document
          .querySelector('.sheet[data-front="true"] path.hit')
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="details"]').click();
      await page
        .getByRole("button", { name: /Forbid this dependency/ })
        .click();
      const box = page.getByLabel("What should change, and why");
      await box.waitFor();
      assert.match(
        await box.inputValue(),
        /^Add a rule to \.peekumi\.json that forbids imports from ui\/\*\* to db\/\*\*/,
      );
      await page.screenshot({
        path: `test-results/rules-forbid-${viewport.width}.png`,
      });
      assert.deepEqual(errors, []);
      console.log(`PASS rules ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
