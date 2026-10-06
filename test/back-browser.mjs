/** The back button steps back inside the app, one layer at a time, and leaves it only when
 * nothing is left: a menu, then a page (nav.js), then a map level, then out. */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { fixture } from "./workflow-support.mjs";
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const f = await fixture({ files: { "backend/lookup.py": "def route():\n    return 1\n" } });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto("about:blank");
      await page.goto(f.server.url + "/#token=" + f.server.token);
      const backend = page.locator('.sheet[data-front="true"] .node[data-path="backend"]');
      await backend.waitFor();
      const crumbs = () => page.locator(".crumbs").textContent();
      const back = async () => {
        await page.evaluate(() => history.back());
        await page.waitForTimeout(250);
      };
      // Into backend, Conversations open, and a context menu on a card.
      await backend.click();
      await backend.click();
      await page.waitForFunction(() => /backend/.test(document.querySelector(".crumbs")?.textContent || ""));
      await page.locator("#openConversations").click();
      await page.waitForFunction(() => document.querySelector("#panel").dataset.view === "conversations");
      await page.locator('.sheet[data-front="true"] .node[data-path="backend/lookup.py"]').click({ button: "right" });
      await page.locator(".context-menu").waitFor();
      // Back: the menu closes; nothing else changes.
      await back();
      assert.equal(await page.locator(".context-menu").count(), 0);
      assert.equal(await page.evaluate(() => document.querySelector("#panel").dataset.view), "conversations");
      // Back: the page gives way to the map's details.
      await back();
      assert.equal(await page.evaluate(() => document.querySelector("#panel").dataset.view), "details");
      assert.match(await crumbs(), /backend/);
      // Back: one map level up.
      await back();
      assert.doesNotMatch(await crumbs(), /backend/);
      assert.ok(page.url().startsWith(f.server.url), "Still in the app");
      // Back with nothing left: the app is left.
      await back();
      await page.waitForURL("about:blank");
      assert.deepEqual(errors, []);
      console.log(`PASS back button ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
