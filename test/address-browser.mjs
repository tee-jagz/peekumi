/** The address and the way back keep what the owner looked at: Back keeps the branch; a
 * reload keeps Time mode, the commit and a selection at the top level; leaving an explored
 * task's branch brings back the place on the map; the header pages do not pile up; and the
 * context menu in Ask starts a session from the map. Phone and desktop. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixture, waitFor } from "./workflow-support.mjs";
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const f = await fixture({
      files: {
        "backend/lookup.py": "def route():\n    return 1\n",
        "docs/notes.md": "# Notes\n",
      },
    });
    // A second commit on main, and a feature branch.
    await writeFile(
      path.join(f.dir, "backend/graph.py"),
      "def fold():\n    return 3\n",
    );
    await f.git("add", ".");
    await f.git("commit", "-m", "Add graph");
    await f.git("branch", "feature");
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      const front = page.locator('.sheet[data-front="true"]');
      const view = () =>
        page.evaluate(() => document.querySelector("#panel").dataset.view);
      const back = async () => {
        await page.evaluate(() => history.back());
        await page.waitForTimeout(300);
      };
      const param = (name) =>
        page.evaluate((n) => new URL(location.href).searchParams.get(n), name);
      await page.goto(
        f.server.url + "/?branch=refs/heads/feature#token=" + f.server.token,
      );
      await front.locator(".node").first().waitFor();

      // Back keeps the branch in the address, so a reload shows the same branch.
      await front.locator('.node[data-path="backend"]').click();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="changes"]').click();
      await back();
      assert.equal(
        await param("branch"),
        "refs/heads/feature",
        "Back keeps the branch",
      );
      assert.equal(await param("item"), "backend");

      // A selection at the top level comes back after a reload.
      await page.reload();
      await front.locator('.node.sel[data-path="backend"]').waitFor();
      assert.equal(
        await page.locator("#branchPicker").inputValue(),
        "refs/heads/feature",
      );

      // Time mode and its commit come back after a reload.
      await page.locator('button[data-mode="time"]').click();
      const card = page.locator("#commitBar button, .commits button").last();
      await card.waitFor();
      await card.click();
      await page.waitForFunction(
        () => new URL(location.href).searchParams.get("mode") === "time",
      );
      const head = await param("head");
      await page.reload();
      await front.locator(".node").first().waitFor();
      assert.equal(await param("mode"), "time");
      assert.equal(
        await param("head"),
        head,
        "The commit stays after a reload",
      );
      assert.equal(
        await page
          .locator('button[data-mode="time"]')
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.locator('button[data-mode="diff"]').click();

      // The header pages give way to each other: Tasks, then Conversations, then one Back.
      await page.locator("#openTasks").click();
      await page.locator("#openConversations").click();
      assert.equal(await view(), "conversations");
      await back();
      assert.notEqual(
        await view(),
        "tasks",
        "Tasks did not stay under Conversations",
      );

      // Leaving an explored task's branch brings back the place on the map.
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
      await waitFor(
        async () => (await f.req("/api/runs/" + p.id)).status === "completed",
      );
      const home = page.locator(".crumbs .crumb-home");
      if (await home.isEnabled()) await home.click();
      const backend = front.locator('.node[data-path="backend"]');
      await backend.click();
      await backend.click();
      await front.locator('.node[data-path="backend/lookup.py"]').click();
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      await page
        .getByRole("button", { name: "Explore changes", exact: true })
        .click();
      await page.locator("#taskReturn:not([hidden])").waitFor();
      await back();
      assert.equal(await view(), "run");
      await page.waitForFunction(
        () =>
          document.querySelector("#branchPicker")?.value ===
          "refs/heads/feature",
      );
      await back();
      await back();
      await page.waitForFunction(() =>
        /backend/.test(document.querySelector(".crumbs")?.textContent || ""),
      );
      await front.locator('.node.sel[data-path="backend/lookup.py"]').waitFor();
      // A reload while exploring keeps the way back to the branch.
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      await page
        .getByRole("button", { name: "Explore changes", exact: true })
        .click();
      await page.locator("#taskReturn:not([hidden])").waitFor();
      await page.reload();
      await page.locator("#taskReturn:not([hidden])").waitFor();
      await page.locator("#taskReturn").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#branchPicker")?.value ===
          "refs/heads/feature",
      );
      await front.locator('.node[data-path="backend"]').waitFor();

      // In Ask, the menu's "Start a session here" goes to the map's dock, in Session mode.
      await page.locator('[data-compose="ask"]').click();
      await page.getByLabel("Your question").fill("Name references.");
      await page
        .getByRole("button", { name: "Send question", exact: true })
        .click();
      assert.equal(await view(), "ask");
      await front
        .locator('.node[data-path="backend"]')
        .click({ button: "right" });
      await page
        .locator(".context-menu")
        .getByRole("menuitem", { name: /Start a session here/ })
        .click();
      assert.notEqual(await view(), "ask");
      await page.getByLabel("What do you want to work on?").waitFor();

      assert.deepEqual(errors, []);
      console.log(`PASS address and way back ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
