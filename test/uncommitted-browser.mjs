/** Uncommitted changes in the browser: the newest commit's map includes them, a card with
 * some has a dashed outline, the newest commit card counts them, and a reload reads them
 * again. No card of their own. Phone and desktop. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixture } from "./workflow-support.mjs";
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
        "lib/__init__.py": "",
        "lib/tools.py": "def tool():\n    return 1\n",
      },
    });
    // A second commit, so the newest commit has a parent to compare with.
    await writeFile(
      path.join(f.dir, "lib/tools.py"),
      "def tool():\n    return 9\n",
    );
    await f.git("commit", "-qam", "Change the tool");
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await writeFile(
        path.join(f.dir, "lib/extra.py"),
        "def extra():\n    return 3\n",
      );
      await page.goto(f.server.url + "/#token=" + f.server.token);
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".node").first().waitFor();
      const lib = front.locator('.node[data-kind="folder"][data-path="lib"]');
      const root = front.locator('.node[data-kind="rootfiles"]');
      assert.equal(await lib.getAttribute("data-uncommitted"), "true");
      assert.equal(await root.getAttribute("data-uncommitted"), null);
      assert.match(await lib.getAttribute("aria-label"), /uncommitted changes/);
      assert.match(
        await page.locator("#commitHead .c-meta").textContent(),
        / \+ 1 uncommitted · compared with /,
      );
      assert.match(
        await page.locator("header.top").innerText(),
        /→ uncommitted/,
      );
      assert.equal(new URL(page.url()).searchParams.get("head"), null);
      // Time mode has no card for them: the newest commit card counts them.
      await page.locator('button[data-mode="time"]').click();
      const cards = page.locator("#timeRail .chip");
      assert.equal(await cards.count(), 2);
      assert.match(await cards.last().innerText(), /\+ 1 uncommitted/);
      assert.equal(await cards.last().getAttribute("aria-selected"), "true");
      await page.screenshot({
        path: `test-results/uncommitted-${viewport.width}.png`,
      });
      // The older commit shows without them.
      await cards.first().click();
      await page
        .locator("#commitHead .c-title", { hasText: "Initial" })
        .waitFor({ state: "attached" });
      assert.equal(await lib.getAttribute("data-uncommitted"), null);
      await cards.last().click();
      await lib.and(page.locator('[data-uncommitted="true"]')).waitFor();
      // A reload reads them again: one more changed file, at the top of the repository.
      await writeFile(
        path.join(f.dir, "module.py"),
        "def run():\n    return 5\n",
      );
      await page.reload();
      await root.and(page.locator('[data-uncommitted="true"]')).waitFor();
      assert.match(
        await page.locator("#commitHead .c-meta").textContent(),
        / \+ 2 uncommitted/,
      );
      assert.deepEqual(errors, []);
      console.log(`PASS uncommitted changes ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
