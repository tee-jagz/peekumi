/** The context menu in the browser: a right-click on desktop and a long press on a phone open
 * one small menu for a map card or a name, with only the actions that fit; its keys and
 * actions use the app's own paths; a moving finger pans and opens nothing. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { fixture, waitFor } from "./workflow-support.mjs";
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    const phone = viewport.width < 900;
    const f = await fixture({ files: { "backend/lookup.py": "def route():\n    return 1\n" } });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce", colorScheme: "dark", hasTouch: phone });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(f.server.url + "/#token=" + f.server.token);
      const card = page.locator('.sheet[data-front="true"] .node[data-path="backend"]');
      await card.waitFor();
      const menu = page.locator('.context-menu[role="menu"]');
      // Open the menu the way the device does: right-click, or a held finger.
      // Real touch input through the browser, so the press is a true one.
      const cdp = phone ? await page.context().newCDPSession(page) : null;
      const touch = async (target, { move = 0 } = {}) => {
        const box = await target.boundingBox();
        const x = box.x + Math.min(40, box.width / 2), y = box.y + Math.min(30, box.height / 2);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        if (move) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + move, y }] });
        await page.waitForTimeout(650);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const openOn = (target) => (phone ? touch(target) : target.click({ button: "right" }));
      // One quick tap with a finger, as on a phone.
      const tap = async (target) => {
        const box = await target.boundingBox();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      await openOn(card);
      await menu.waitFor();
      assert.match(await menu.locator(".context-menu-head").textContent(), /^backend · folder/);
      const labels = await menu.locator('[role="menuitem"] span').allTextContents();
      assert.deepEqual(labels.slice(0, 4), ["Open", "Ask about this", "Add instruction", "Start a session here"]);
      assert.ok(labels.includes("Copy path"));
      assert.equal(await page.locator(".node.sel").count(), 0, "A long press or right-click does not also select the card");
      assert.equal(await page.locator("body.menu-open").count(), 1, "The rest of the map dims");
      await page.screenshot({ path: `test-results/menu-card-${viewport.width}.png` });
      if (!phone) {
        // Keys: Escape closes and gives focus back; A asks about the card.
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), "backend");
        await openOn(card);
        await menu.waitFor();
        await page.keyboard.press("a");
      } else {
        // The first tap on an item runs it: the long press does not swallow it.
        await tap(menu.getByRole("menuitem", { name: /Ask about this/ }));
      }
      await page.waitForFunction(() => document.querySelector('[data-compose="ask"]').getAttribute("aria-selected") === "true");
      assert.match(await page.locator("#dockContext").textContent(), /backend/);
      // A moving finger pans the map and opens nothing.
      if (phone) {
        await touch(card, { move: 30 });
        await page.waitForTimeout(200);
        assert.equal(await menu.count(), 0, "A moving finger opens no menu");
      }
      // With a session open, the card can be pointed at for the next reply.
      const session = await f.req("/api/runs/session", { text: "Look around.", sha: f.sha, anchor: { kind: "repo", path: "" }, using: { agent: "codex" } });
      await waitFor(async () => (await f.req("/api/runs/" + session.id)).status === "waiting");
      await page.reload();
      await card.waitFor();
      await openOn(card);
      await menu.waitFor();
      await menu.getByRole("menuitem", { name: /Point the agent here/ }).click();
      await page.getByLabel("Reply to the agent").waitFor();
      assert.match(await page.locator("#dockContext").textContent(), /backend/, "The reply carries the card");
      // A name in an answer: its menu moves the map there.
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-compose="ask"]').getAttribute("aria-selected") === "true");
      await page.getByLabel("Your question").fill("Name references.");
      await page.locator("#composerHost").getByRole("button", { name: "Send question", exact: true }).click();
      const name = page.locator('.ask-message .code-link[data-target]', { hasText: "module.py" }).first();
      await name.waitFor();
      await openOn(name);
      await menu.waitFor();
      assert.deepEqual((await menu.locator('[role="menuitem"] span').allTextContents()).slice(0, 3), ["Show on the map", "Source", "Ask about this"]);
      await page.screenshot({ path: `test-results/menu-name-${viewport.width}.png` });
      await menu.getByRole("menuitem", { name: /Show on the map/ }).click();
      await page.waitForFunction(() => /module\.py/.test(document.querySelector(".crumbs")?.textContent || ""));
      assert.deepEqual(errors, []);
      console.log(`PASS context menu ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
