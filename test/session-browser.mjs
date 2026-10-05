/** Sessions in the browser: start one from the dock, answer a command request, follow the
 * agent's steps, reply, and send the work to the normal review. Phone and desktop. */
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
    const f = await fixture();
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Sessions use the device's choice for tasks: Claude Code here, which asks before commands.
    await page.addInitScript(() => localStorage.setItem("peekumi.agents.default", JSON.stringify({ task: { agent: "claude" } })));
    try {
      await page.goto(f.server.url + "/#token=" + f.server.token);
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      await page.locator('[data-compose="session"]').click();
      assert.equal(await page.locator('[data-compose="session"]').getAttribute("aria-selected"), "true");
      const start = page.getByLabel("What do you want to work on?");
      await start.fill("Make the change.\nRUN: npm install left-pad");
      await page.getByRole("button", { name: "Start session" }).click();
      // The command waits for the owner, in the conversation.
      const approval = page.locator(".session-approval");
      await approval.waitFor();
      assert.match(await approval.locator(".session-command").textContent(), /npm install left-pad/);
      await page.screenshot({ path: `test-results/session-approval-${viewport.width}.png` });
      // The chip beside the dock names the agent that sessions use (once the list loads).
      await page.waitForFunction(() => /Sessions use Claude/.test(document.querySelector("#dockAgent")?.title || ""), null, { timeout: 60000 });
      await page.getByRole("button", { name: "Allow npm install in this session" }).click();
      const log = page.locator(".session-log");
      await log.getByText("Turn 1 is done.").waitFor();
      await page.locator(".session-status", { hasText: "Your turn" }).waitFor();
      const steps = log.locator(".session-step");
      assert.ok((await steps.count()) >= 2, "The agent's steps show");
      assert.match(await steps.first().locator("summary").textContent(), /Ran\s*npm test/);
      await steps.first().locator("summary").click();
      assert.match(await steps.first().locator(".session-output").textContent(), /78 passed/);
      const edit = steps.filter({ hasText: "Edited session-notes.txt" }).first();
      await edit.locator("summary").click();
      await edit.getByRole("button", { name: "Show session-notes.txt on the map" }).waitFor();
      // Names in the agent's text link to their place; the session stays on screen.
      const name = log.getByRole("button", { name: "module.py" }).first();
      await name.waitFor();
      await name.click();
      await page.waitForFunction(() => /module\.py/.test(document.querySelector(".crumbs")?.textContent || ""));
      assert.ok(await log.isVisible(), "The session stays on screen");
      assert.ok(await log.getByRole("button", { name: "run", exact: true }).count(), "A declaration links too");
      await page.screenshot({ path: `test-results/session-live-${viewport.width}.png` });
      // The session's commands switch: ask before commands, or allow all.
      await page.getByRole("button", { name: "Commands: ask first" }).click();
      await page.getByRole("button", { name: "Commands: all allowed" }).waitFor();
      await page.getByRole("button", { name: "Commands: all allowed" }).click();
      await page.getByRole("button", { name: "Commands: ask first" }).waitFor();
      // Outside its view, a small Peek switches the sheet between the selection's description
      // and one line on the session, on every sheet height.
      await page.getByRole("button", { name: "Back to tasks" }).click();
      await page.locator("#openTasks").click();
      const toggle = page.locator("#peekToggle");
      const line = page.locator("#sessionLine");
      await line.waitFor();
      assert.match(await line.textContent(), /Your turn\s*Turn 1 is done\./);
      assert.equal(await toggle.locator('.peek-mark[data-state="ready"]').count(), 1);
      assert.ok((await line.boundingBox()).height <= 40, "One line");
      if (viewport.width < 900) {
        await page.locator("#sheetHandle").focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(() => document.querySelector("#panel").dataset.height === "peek");
        assert.ok(await line.isVisible(), "The session shows on the closed sheet");
        assert.ok(await page.locator("#reviewScope").isHidden(), "In place of the description");
      }
      await page.screenshot({ path: `test-results/session-peek-${viewport.width}.png` });
      await toggle.click();
      assert.ok(await line.isHidden());
      assert.ok(await page.locator("#reviewScope").isVisible(), "The description comes back");
      assert.ok(await toggle.isVisible(), "Peek stays to switch back");
      await toggle.click();
      await line.click();
      await log.getByText("Turn 1 is done.").waitFor();
      assert.ok(await toggle.isHidden(), "Peek hides while the session is on screen");
      // Closing the sheet on the session itself shows its line, not the selection's description.
      if (viewport.width < 900) {
        await page.locator("#sheetHandle").focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(() => document.querySelector("#panel").dataset.height === "peek");
        await line.waitFor();
        assert.match(await line.textContent(), /Your turn/);
        assert.ok(await page.locator("#reviewScope").isHidden(), "No description on the closed session");
        assert.equal(await page.locator('#peekToggle[aria-label="Open the session"] .peek-mark').count(), 1, "Peek shows the session");
        await page.screenshot({ path: "test-results/session-closed-390.png" });
        await line.click();
        await page.waitForFunction(() => document.querySelector("#panel").dataset.height !== "peek");
        await log.getByText("Turn 1 is done.").waitFor();
        assert.ok(await line.isHidden(), "The line hides once the session shows again");
      }
      // The dock replies to the session.
      await page.getByLabel("Reply to the agent").fill("Again, please.");
      await page.getByRole("button", { name: "Send to the agent" }).click();
      await log.getByText("Turn 2 is done.").waitFor();
      await page.locator(".session-status", { hasText: "Your turn" }).waitFor();
      assert.match(await log.locator(".session-owner").last().textContent(), /Again, please\./);
      // A link in the conversation moves the map; the conversation keeps its place.
      const later = log.getByRole("button", { name: "module.py" }).last();
      await later.scrollIntoViewIfNeeded();
      const kept = await page.locator("#reviewScroll").evaluate((n) => n.scrollTop);
      await later.click();
      await page.waitForFunction(() => /module\.py/.test(document.querySelector(".crumbs")?.textContent || ""));
      await page.waitForTimeout(300);
      const now = await page.locator("#reviewScroll").evaluate((n) => n.scrollTop);
      assert.ok(Math.abs(now - kept) < 4, `The session keeps its place after a link: ${kept} → ${now}`);
      if (viewport.width < 900) assert.ok(kept > 0, "The test reads from the middle of a long conversation");
      // While the agent works, the closed sheet shows Peek at work and what it does now, and
      // the map marks the agent's file.
      await page.getByLabel("Reply to the agent").fill("One more. WAIT_FOR_STOP");
      await page.getByRole("button", { name: "Send to the agent" }).click();
      await log.locator(".session-step").filter({ hasText: "Edited session-notes.txt" }).nth(2).waitFor();
      await page.getByRole("button", { name: "Back to tasks" }).click();
      await page.locator("#openTasks").click();
      const working = page.locator('#sessionLine[data-state="running"]');
      await working.filter({ hasText: "Edited session-notes.txt" }).waitFor();
      assert.match(await working.textContent(), /Working\s*Edited session-notes\.txt/);
      assert.equal(await page.locator('#peekToggle .peek-mark[data-state="working"]').count(), 1);
      // The map was moved into module.py by the link; at the top level the agent's file shows.
      const home = page.locator(".crumbs .crumb-home");
      if (await home.isEnabled()) await home.click();
      await page.locator(".node.agent-here .agent-badge").waitFor();
      await page.screenshot({ path: `test-results/session-working-${viewport.width}.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `test-results/session-working-dark-${viewport.width}.png` });
      await working.click();
      await page.screenshot({ path: `test-results/session-view-dark-${viewport.width}.png` });
      await page.emulateMedia({ colorScheme: "light" });
      await page.getByRole("button", { name: "Stop" }).click();
      await page.locator(".session-status", { hasText: "Your turn" }).waitFor();
      assert.equal(await page.locator(".node.agent-here").count(), 0, "The mark leaves the map once the agent stops");
      // The Tasks list shows the session in its own group.
      await page.getByRole("button", { name: "Back to tasks" }).click();
      const group = page.locator(".workflow-group", { hasText: "Sessions" });
      await group.waitFor();
      await page.getByRole("button", { name: /Session · Make the change\./ }).click();
      await log.getByText("Turn 2 is done.").waitFor();
      // A session opens at its latest message, and its header stays in view.
      await page.waitForFunction(() => {
        const s = document.querySelector("#reviewScroll");
        return s.scrollHeight <= s.clientHeight + 2 || s.scrollTop + s.clientHeight >= s.scrollHeight - 30;
      });
      // The header sits above the scrolling conversation, so scrolling never moves it.
      await page.locator(".session-head").waitFor();
      const before = await page.locator(".session-head").boundingBox();
      await page.locator("#reviewScroll").evaluate((n) => (n.scrollTop = 0));
      const after = await page.locator(".session-head").boundingBox();
      const scroller = await page.locator("#reviewScroll").boundingBox();
      assert.ok(before && after && Math.abs(before.y - after.y) < 1 && after.y + after.height <= scroller.y + 1, "The header stays above the conversation");
      assert.equal(await page.locator("#reviewScroll .session-head").count(), 0);
      // Ending sends the branch to the normal review.
      await page.getByRole("button", { name: "End session" }).click();
      await page.locator(".session-end").waitFor();
      await page.screenshot({ path: `test-results/session-end-${viewport.width}.png` });
      await page.getByRole("button", { name: "Send to review" }).click();
      await page.locator(".task-heading", { hasText: "Ready for review" }).waitFor();
      // The conversation stays with the work.
      await page.getByText("Session conversation").click();
      await page.locator(".session-record .session-log").getByText("Turn 2 is done.").waitFor();
      await page.screenshot({ path: `test-results/session-review-${viewport.width}.png` });
      assert.deepEqual(errors, []);
      console.log(`PASS session ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
