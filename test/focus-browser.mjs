/** Agent focus in the browser: the map follows a session's agent into the declaration it
 * reads, pauses when the owner moves the map, marks the folder that holds the agent when
 * zoomed out, and keeps the trail and the changed files once the agent stops. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
        "backend/lookup.py": "def route():\n    return 1\n\ndef highlight():\n    return 2\n",
        "backend/graph.py": "def fold():\n    return 3\n",
      },
    });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce", colorScheme: "dark" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("peekumi.agents.default", JSON.stringify({ task: { agent: "claude" } })));
    try {
      await page.goto(f.server.url + "/#token=" + f.server.token);
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      await page.locator('[data-compose="session"]').click();
      await page.getByLabel("What do you want to work on?").fill("Look around. FOCUS WAIT_FOR_STOP");
      await page.getByRole("button", { name: "Start session" }).click();
      // Follow moves the map into backend/lookup.py, where the agent reads route.
      const pill = page.locator("#agentFocus .follow-pill");
      await pill.waitFor();
      assert.equal(await pill.getAttribute("data-on"), "true");
      await page.locator('.node.agent-here[data-key="symbol:route"] .agent-badge').waitFor({ timeout: 15000 });
      assert.match(await page.locator(".session-step.is-current").textContent(), /read_declaration\s*route/);
      // The agent's place sits in the middle of the visible map.
      await page.waitForTimeout(400);
      const centred = await page.evaluate(() => {
        const card = document.querySelector('.node.agent-here[data-key="symbol:route"]').getBoundingClientRect();
        const map = document.querySelector('.sheet[data-front="true"] .map-canvas').getBoundingClientRect();
        const sheet = document.querySelector("#panel").getBoundingClientRect();
        const bottom = sheet.top > map.top + 80 ? Math.min(map.bottom, sheet.top) : map.bottom;
        return [card.left + card.width / 2 - (map.left + map.width / 2), card.top + card.height / 2 - (map.top + bottom) / 2];
      });
      assert.ok(Math.abs(centred[0]) < 30 && Math.abs(centred[1]) < 30, `Centred: ${centred}`);
      await page.screenshot({ path: `test-results/focus-follow-${viewport.width}.png` });
      // The eye stays under the top bar's popovers.
      await page.locator("#revisionDetails > summary").click();
      const eyeBox = await pill.boundingBox();
      const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#agentFocus") !== null, [eyeBox.x + eyeBox.width / 2, eyeBox.y + eyeBox.height / 2]);
      const covered = await page.evaluate(() => {
        const pop = document.querySelector("#revisionDetails .history-content")?.getBoundingClientRect();
        const eye = document.querySelector("#agentFocus").getBoundingClientRect();
        return Boolean(pop && pop.bottom > eye.top && pop.top < eye.bottom && pop.right > eye.left && pop.left < eye.right);
      });
      if (covered) assert.equal(onTop, false, "The Comparison panel covers the eye");
      await page.locator("#revisionDetails > summary").click();
      assert.equal(await page.locator("#dockContext").textContent(), "", "Follow's move is not a pointer for the next reply");
      // The owner moves the map: Follow pauses, and the folder that holds the agent glows.
      await page.locator(".crumbs .crumb-home").click();
      await page.locator('.node.agent-here[data-path="backend"]').waitFor();
      assert.equal(await pill.getAttribute("data-on"), "false");
      assert.equal(await pill.getAttribute("data-label"), "paused");
      assert.match(await pill.getAttribute("aria-label"), /Follow paused/);
      await page.waitForTimeout(3500);
      assert.equal(await page.locator('.node[data-path="backend"]').count(), 1, "Paused: the map stays where the owner put it");
      assert.equal(await page.locator('.node.agent-changed[data-path="backend"]').count(), 1, "backend holds a changed file");
      await page.screenshot({ path: `test-results/focus-paused-${viewport.width}.png` });
      // A tap follows again.
      await pill.click();
      await page.locator('.node.agent-here[data-key="symbol:route"]').waitFor({ timeout: 15000 });
      // Stopped: no "now" mark, the trail and the changed files stay, with a key.
      await page.getByRole("button", { name: "Stop" }).click();
      await page.locator(".session-status", { hasText: "Your turn" }).waitFor();
      assert.equal(await page.locator(".node.agent-here").count(), 0);
      assert.equal(await page.locator('.node.agent-trail[data-key="symbol:route"]').count(), 1, "route stays on the trail");
      // The map's legend explains the marks; nothing else floats on the map.
      assert.equal(await page.locator("#agentFocus .agent-key").count(), 0);
      await page.locator("#mapLegend > summary").click();
      assert.match(await page.locator("#legendContent").innerText(), /Session agent\s*Agent is here\s*Looked at\s*Changed/);
      await page.screenshot({ path: `test-results/focus-legend-${viewport.width}.png` });
      await page.getByRole("button", { name: "Close legend", exact: true }).click();
      await page.locator(".crumbs .crumb-home").click();
      await page.locator('.node.agent-trail[data-path="backend"]').waitFor();
      await page.screenshot({ path: `test-results/focus-waiting-${viewport.width}.png` });
      // Ask: while the answer works, the map follows what it reads. The owner's selection is
      // the subject of the next message; Follow moves the map, but never that choice.
      await page.locator('.sheet[data-front="true"] .node[data-path="backend"]').click();
      await page.locator("#agentFocus .follow-pill").click();
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.getByLabel("Your question").fill("Look at route.");
      await page.locator("#composerHost").getByRole("button", { name: "Send question", exact: true }).click();
      await page.locator('.node.agent-here[data-key="symbol:route"] .agent-badge').waitFor({ timeout: 15000 });
      assert.match(await page.locator("#dockContext").innerText(), /^backend\b/, "Follow keeps the owner's anchor");
      await page.screenshot({ path: `test-results/focus-ask-${viewport.width}.png` });
      await page.locator(".ask-message.from-assistant", { hasText: "returns 1" }).waitFor();
      await page.locator('.node.agent-trail[data-key="symbol:route"]').waitFor();
      assert.equal(await page.locator(".node.agent-here").count(), 0, "Done: what Ask read stays as a trail");
      // A task: while its agent works, the map follows it too.
      const c = await f.req("/api/comments", { text: "Look at graph.", sha: f.sha, anchor: { kind: "repo", path: "" } });
      const p = await f.req("/api/runs/preview", { commentIds: [c.id], brief: "FOCUS_TASK", using: { agent: "claude" } });
      await f.req("/api/runs", { previewId: p.id });
      await page.locator('.node.agent-here[data-path="backend/graph.py"] .agent-badge').waitFor({ timeout: 20000 });
      await page.screenshot({ path: `test-results/focus-task-${viewport.width}.png` });
      assert.deepEqual(errors, []);
      console.log(`PASS agent focus ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
