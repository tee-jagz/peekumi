/** Navigation in the browser, as the view stack (frontend/nav.js) defines it:
 * - each open action shows a view with one header row, and Back (or Escape, or the row's
 *   arrow) always returns to the view before it;
 * - the dock follows the view: mode tabs on the map, the thread's reply box in a thread;
 * - Conversations hold Ask and sessions; Tasks hold only work;
 * - a small Peek and one word in the sheet's handle row lead to an open session;
 * - exploring a task's branch returns to the task and its comparison. Phone and desktop. */
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
    const f = await fixture({ files: { "backend/lookup.py": "def route():\n    return 1\n" } });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("peekumi.agents.default", JSON.stringify({ task: { agent: "claude" } })));
    try {
      // A finished task to review, made through the API as an owner would.
      const comment = await f.req("/api/comments", { text: "Write the result file", sha: f.sha, anchor: { kind: "repo", path: "" } });
      const preview = await f.req("/api/runs/preview", { agent: "codex", commentIds: [comment.id] });
      await f.req("/api/runs", { previewId: preview.id });
      await waitFor(async () => (await f.req("/api/runs/" + preview.id)).status === "completed");

      await page.goto(f.server.url + "/#token=" + f.server.token);
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".node").first().waitFor();
      const view = () => page.evaluate(() => document.querySelector("#panel").dataset.view);
      const title = () => page.locator("#viewHead .view-title").innerText();
      const back = async () => {
        await page.evaluate(() => history.back());
        await page.waitForTimeout(250);
      };
      const arrow = () => page.locator("#viewHead").getByRole("button", { name: "Back", exact: true }).click();
      const crumbs = () => page.locator(".crumbs").innerText();
      const tabs = page.locator("#tabs");
      const backend = front.locator('.node[data-path="backend"]');

      // The aspect buttons show once the sheet is open (a phone starts with it closed).
      const aspect = async (name) => {
        if (!(await page.locator("#helperTools").isVisible())) await page.locator("#sheetHandle").click();
        await page.locator(`#helperTools [data-tab="${name}"]`).click();
      };
      // The map: a selection, an aspect, and Back in reverse order.
      await backend.click();
      await aspect("changes");
      assert.equal(await view(), "changes");
      await back();
      assert.equal(await view(), "details", "Back from an aspect returns to Details");
      assert.equal(await front.locator('.node.sel[data-path="backend"]').count(), 1, "The selection stays");
      assert.ok(await tabs.isVisible(), "The map's dock offers Ask, Instruction and Session");

      // Tasks hold work only; a task opens over the list and Back returns to it.
      await page.locator("#openTasks").click();
      assert.equal(await view(), "tasks");
      assert.equal(await title(), "Tasks");
      assert.equal(await page.locator(".workflow-group", { hasText: "Sessions" }).count(), 0, "No sessions in Tasks");
      assert.ok(await tabs.isHidden(), "No dock modes on a list");
      await page.locator(".task-link").first().click();
      assert.equal(await view(), "run");
      await arrow();
      assert.equal(await view(), "tasks", "The arrow returns to the list");
      // A card tapped from a task view opens the map over it; Back returns to the task.
      await page.locator(".task-link").first().click();
      await backend.click();
      assert.equal(await view(), "details");
      await back();
      assert.equal(await view(), "run", "Back returns to the task after a map tap");
      // Explore changes shows the agent's branch; Back returns to the task and the comparison.
      const comparison = await page.locator("#revisionDetails > summary").innerText();
      await page.getByRole("button", { name: "Explore changes", exact: true }).click();
      await page.locator("#taskReturn").waitFor();
      assert.notEqual(await page.locator("#revisionDetails > summary").innerText(), comparison);
      await back();
      assert.equal(await view(), "run");
      await page.waitForFunction((before) => document.querySelector("#revisionDetails > summary")?.innerText === before, comparison);
      assert.ok(await page.locator("#taskReturn").isHidden());
      await back();
      assert.equal(await view(), "tasks");
      await page.keyboard.press("Escape");
      assert.equal(await view(), "details", "Escape steps back as Back does");

      // The return from the explored branch brought back the map's place (inside backend,
      // which the second tap above opened).
      assert.match(await crumbs(), /backend/);
      // Ask: a question opens its thread; the dock is the thread's box; Back returns.
      await page.locator(".crumbs .crumb-home").click();
      await backend.click();
      await page.locator('[data-compose="ask"]').click();
      await page.getByLabel("Your question").fill("Name references.");
      await page.getByRole("button", { name: "Send question", exact: true }).click();
      assert.equal(await view(), "ask");
      assert.match(await title(), /^Ask/);
      assert.ok(await tabs.isHidden(), "In a thread the dock has no modes");
      await page.locator(".ask-message.from-assistant").first().waitFor();
      await back();
      assert.equal(await view(), "details");
      assert.equal(await front.locator('.node.sel[data-path="backend"]').count(), 1);

      // A session: it starts from the dock and opens; Back returns to the map, where the
      // live line in the handle row leads back to it; Conversations list it and Ask.
      await page.locator('[data-compose="session"]').click();
      await page.getByLabel("What do you want to work on?").fill("Look around.");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await page.locator(".session-log").waitFor();
      assert.equal(await view(), "run");
      assert.ok(await tabs.isHidden());
      await page.getByLabel("Reply to the agent").waitFor();
      await page.locator(".session-status", { hasText: "Your turn" }).waitFor();
      await back();
      assert.equal(await view(), "details");
      const live = page.locator("#liveLine");
      await live.waitFor();
      assert.match(await live.getAttribute("aria-label"), /^Session Look around\. · Your turn/);
      await page.screenshot({ path: `test-results/navigation-live-${viewport.width}.png` });
      await live.click();
      assert.equal(await view(), "run");
      assert.ok(await live.isHidden(), "Hidden on its own session");
      await back();
      await page.locator("#openConversations").click();
      assert.equal(await view(), "conversations");
      const rows = page.locator(".conversation-row");
      assert.equal(await rows.count(), 2, "One session and one Ask thread");
      await page.screenshot({ path: `test-results/navigation-conversations-${viewport.width}.png` });
      await rows.filter({ hasText: "Ask" }).click();
      assert.equal(await view(), "ask");
      await back();
      assert.equal(await view(), "conversations");
      await rows.filter({ hasText: "Look around." }).click();
      assert.equal(await view(), "run");
      await back();
      await back();
      assert.equal(await view(), "details");

      // An instruction is saved on the map; Details leads to the instructions there.
      await page.locator('[data-compose="comments"]').click();
      await page.getByLabel("What should change, and why").fill("Rename route.");
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      assert.equal(await view(), "details", "Saving keeps the map");
      await page.locator(".instructions-here", { hasText: "2 instructions here" }).click();
      assert.equal(await view(), "instructions");
      assert.match(await page.locator("#tabBody").innerText(), /Rename route\./);
      await back();
      assert.equal(await view(), "details");

      // Down to nothing: the selection clears, then the map goes up, then the app is left.
      await back();
      assert.equal(await front.locator(".node.sel").count(), 0);
      assert.ok(page.url().startsWith(f.server.url));
      assert.deepEqual(errors, []);
      console.log(`PASS navigation ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
