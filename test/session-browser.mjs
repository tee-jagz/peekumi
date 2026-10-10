/** Sessions in the browser: start one from the send sheet (With me), answer a command
 * request, follow the agent's steps, reply, and send the work to the normal review. Phone and
 * desktop. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
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
    await page.addInitScript(() =>
      localStorage.setItem(
        "peekumi.agents.default",
        JSON.stringify({ task: { agent: "claude" } }),
      ),
    );
    try {
      await page.goto(f.server.url + "/#token=" + f.server.token);
      await page
        .locator('.sheet[data-front="true"] .pk-card')
        .first()
        .waitFor();
      // A session is how a change runs: the change goes to the tray, and With me in the send
      // sheet starts a session with it.
      await page
        .getByLabel("Ask, or describe a change")
        .fill("Make the change.");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Add as a change", exact: true })
        .click();
      await page.locator("#reviewActions .pk-tray").click();
      await page.locator('#panel[data-view="prepare"]').waitFor();
      const how = page.getByRole("group", { name: "How it runs" });
      await how.getByRole("button", { name: "With me", exact: true }).click();
      assert.equal(
        await how
          .getByRole("button", { name: "With me", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      // The send sheet names the agent that the session uses (once the list loads).
      await page
        .locator(".pk-facts > div", { hasText: /^Agent\s*Claude/ })
        .waitFor({ timeout: 60000 });
      // Claude Code asks before commands: Allow all commands is off by default.
      const allowAll = page.getByLabel("Allow all commands");
      await allowAll.waitFor();
      assert.equal(await allowAll.isChecked(), false);
      // With me needs no frozen preview: the session's first message is the change.
      assert.equal(
        await page.getByText("The exact task", { exact: true }).count(),
        0,
      );
      await page
        .getByLabel("Extra instructions (optional)")
        .fill("RUN: npm install left-pad");
      await page.screenshot({
        path: `test-results/session-send-${viewport.width}.png`,
      });
      // One tap starts the session, straight after the owner types in the field.
      const startSession = page.locator("#dispatchRun");
      assert.equal(await startSession.innerText(), "Start session");
      await startSession.click();
      // The command waits for the owner, in the conversation.
      const approval = page.getByRole("region", {
        name: "The agent asks to run a command",
      });
      await approval.waitFor();
      assert.match(
        await approval.locator(".pk-command").textContent(),
        /npm install left-pad/,
      );
      // The note goes with Deny, so it comes before the buttons.
      assert.ok(
        await approval.evaluate((card) =>
          Boolean(
            card
              .querySelector("label")
              .compareDocumentPosition(card.querySelector(".pk-actions")) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
        "The note comes first",
      );
      await page.screenshot({
        path: `test-results/session-approval-${viewport.width}.png`,
      });
      // The first message is the picked change, then the extra instructions.
      const first = JSON.parse(
        await readFile(f.state + "/session-turn-1.json", "utf8"),
      );
      assert.match(
        first.task,
        /\nMake the change\.\nRUN: npm install left-pad/,
      );
      // The session carries the change now, so it leaves the tray.
      assert.equal(
        (await f.req("/api/workflow")).comments.filter(
          (c) => c.status === "draft",
        ).length,
        0,
        "The sent change is no longer a draft",
      );
      await page
        .getByRole("button", { name: "Allow npm install in this session" })
        .click();
      const log = page.getByRole("log", { name: "Session conversation" });
      await log.getByText("Turn 1 is done.").waitFor();
      await page
        .locator("#viewHead .pk-status", { hasText: "Your turn" })
        .waitFor();
      const steps = log.locator(".pk-step");
      assert.ok((await steps.count()) >= 2, "The agent's steps show");
      assert.match(
        await steps.first().locator("summary").textContent(),
        /Ran\s*npm test/,
      );
      await steps.first().locator("summary").click();
      assert.match(
        await steps.first().locator(".pk-command").textContent(),
        /78 passed/,
      );
      const edit = steps
        .filter({ hasText: "Edited session-notes.txt" })
        .first();
      await edit.locator("summary").click();
      await edit
        .getByRole("button", { name: "Show session-notes.txt on the map" })
        .waitFor();
      // Names in the agent's text link to their place; the session stays on screen.
      const name = log.getByRole("button", { name: "module.py" }).first();
      await name.waitFor();
      await name.click();
      await page.waitForFunction(() =>
        /module\.py/.test(document.querySelector(".crumbs")?.textContent || ""),
      );
      assert.ok(await log.isVisible(), "The session stays on screen");
      assert.ok(
        await log.getByRole("button", { name: "run", exact: true }).count(),
        "A declaration links too",
      );
      await page.screenshot({
        path: `test-results/session-live-${viewport.width}.png`,
      });
      // The session's commands switch: ask before commands, or allow all.
      await page.getByRole("button", { name: "Commands: ask first" }).click();
      await page
        .getByRole("button", { name: "Commands: all allowed" })
        .waitFor();
      await page.getByRole("button", { name: "Commands: all allowed" }).click();
      await page.getByRole("button", { name: "Commands: ask first" }).waitFor();
      // Outside its view, the Conversations button shows the session's state, and nothing else
      // on the sheet changes: the selection's description stays.
      await page
        .locator("#viewHead")
        .getByRole("button", { name: "Back", exact: true })
        .click();
      // Outside its view, the sheet's handle row shows Peek and one word; a tap opens it.
      const live = page.locator("#liveLine");
      await live.waitFor();
      assert.equal(await live.innerText(), "Your turn");
      assert.match(
        await live.getAttribute("aria-label"),
        // The session is named by its first message: the change with its place.
        /^Session Make the change\. · Your turn: Turn 1 is done\./,
      );
      // On the title's line, at its right: no row of its own.
      const [title, mark] = [
        await page.locator("#reviewScope .review-name").boundingBox(),
        await live.boundingBox(),
      ];
      assert.ok(
        Math.abs(title.y + title.height / 2 - (mark.y + mark.height / 2)) < 6,
        "On the same line as the title",
      );
      assert.ok(mark.x > title.x + title.width, "At the right of the title");
      if (viewport.width < 900) {
        await page.locator("#sheetHandle").focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(
          () => document.querySelector("#panel").dataset.height === "peek",
        );
        assert.ok(
          await page.locator("#reviewScope").isVisible(),
          "The description stays",
        );
      }
      await page.screenshot({
        path: `test-results/session-peek-${viewport.width}.png`,
      });
      // Opening a card redraws the sheet; the button keeps the session's state.
      const homeCrumb = page.locator(".crumbs .crumb-home");
      if (await homeCrumb.isEnabled()) await homeCrumb.click();
      const card = page.locator('.sheet[data-front="true"] .pk-card').first();
      await card.click();
      await card.click();
      await page.waitForFunction(
        () =>
          document.querySelector(".crumbs .crumb-home") &&
          !document.querySelector(".crumbs .crumb-home").disabled,
      );
      await live.click();
      await log.getByText("Turn 1 is done.").waitFor();
      assert.ok(await live.isHidden(), "Hidden while its session is on screen");
      // Closing the sheet on the session itself keeps its header row in view.
      if (viewport.width < 900) {
        await page.locator("#sheetHandle").focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(
          () => document.querySelector("#panel").dataset.height === "peek",
        );
        assert.ok(
          await page.locator("#viewHead .pk-page-header").isVisible(),
          "The closed session shows its header",
        );
        assert.match(
          await page.locator("#viewHead .pk-status").textContent(),
          /Your turn/,
        );
        await page.screenshot({ path: "test-results/session-closed-390.png" });
        await page.locator("#sheetHandle").click();
        await page.waitForFunction(
          () => document.querySelector("#panel").dataset.height !== "peek",
        );
        await log.getByText("Turn 1 is done.").waitFor();
      }
      // The dock replies to the session.
      await page.getByLabel("Reply to the agent").fill("Again, please.");
      await page.getByRole("button", { name: "Send to the agent" }).click();
      await log.getByText("Turn 2 is done.").waitFor();
      await page
        .locator("#viewHead .pk-status", { hasText: "Your turn" })
        .waitFor();
      assert.match(
        await log.locator(".pk-message.is-user").last().textContent(),
        /Again, please\./,
      );
      // A link in the conversation moves the map; the conversation keeps its place.
      // The test reads from the middle: the sheet scrolls to half way, and the test taps the
      // link nearest the middle of the view (the rule keeps a reader at the end at the end).
      await page
        .locator("#reviewScroll")
        .evaluate((n) => (n.scrollTop = (n.scrollHeight - n.clientHeight) / 2));
      const later = log.getByRole("button", { name: "module.py" }).last();
      // A redraw can replace the link while the test scrolls to it (its names become links
      // once their places are found); try again on the new one.
      for (let i = 0; ; i++)
        try {
          await later.evaluate((link) =>
            link.scrollIntoView({ block: "nearest" }),
          );
          break;
        } catch (e) {
          if (i === 4) throw e;
          await page.waitForTimeout(200);
        }
      const kept = await page
        .locator("#reviewScroll")
        .evaluate((n) => n.scrollTop);
      // A click in the page: Playwright's own click can scroll a few pixels to reach the link.
      await later.evaluate((link) => link.click());
      await page.waitForFunction(() =>
        /module\.py/.test(document.querySelector(".crumbs")?.textContent || ""),
      );
      await page.waitForTimeout(300);
      const now = await page
        .locator("#reviewScroll")
        .evaluate((n) => n.scrollTop);
      assert.ok(
        Math.abs(now - kept) < 4,
        `The session keeps its place after a link: ${kept} → ${now}`,
      );
      if (viewport.width < 900)
        assert.ok(
          kept > 0,
          "The test reads from the middle of a long conversation",
        );
      // While the agent works, the closed sheet shows Peek at work and what it does now, and
      // the map marks the agent's file.
      await page
        .getByLabel("Reply to the agent")
        .fill("One more. WAIT_FOR_STOP");
      await page.getByRole("button", { name: "Send to the agent" }).click();
      await log
        .locator(".pk-step")
        .filter({ hasText: "Edited session-notes.txt" })
        .nth(2)
        .waitFor();
      await page
        .locator("#viewHead")
        .getByRole("button", { name: "Back", exact: true })
        .click();
      const working = page.locator('#liveLine[data-state="running"]');
      // Peek shows the activity: the last step edited a file.
      await working.locator('.peek-mark[data-state="editing"]').waitFor();
      await page.waitForFunction(() =>
        /Editing: Edited session-notes\.txt/.test(
          document.querySelector("#liveLine").getAttribute("aria-label"),
        ),
      );
      // The map was moved into module.py by the link; at the top level the agent's file shows.
      const home = page.locator(".crumbs .crumb-home");
      if (await home.isEnabled()) await home.click();
      await page.locator(".pk-card.is-agent .pk-card-peek").waitFor();
      await page.screenshot({
        path: `test-results/session-working-${viewport.width}.png`,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: `test-results/session-working-dark-${viewport.width}.png`,
      });
      await working.click();
      await page.screenshot({
        path: `test-results/session-view-dark-${viewport.width}.png`,
      });
      await page.emulateMedia({ colorScheme: "light" });
      await page.getByRole("button", { name: "Stop" }).click();
      await page
        .locator("#viewHead .pk-status", { hasText: "Your turn" })
        .waitFor();
      assert.equal(
        await page.locator(".pk-card.is-agent").count(),
        0,
        "The mark leaves the map once the agent stops",
      );
      // Conversations list the open session; it opens from there (Back returns to the list
      // when the session was opened from it).
      await page
        .locator("#viewHead")
        .getByRole("button", { name: "Back", exact: true })
        .click();
      if (
        (await page.locator("#panel").getAttribute("data-view")) !==
        "conversations"
      )
        await page.locator("#openConversations").click();
      await page
        .locator(".conversation-row", { hasText: "Make the change." })
        .click();
      await log.getByText("Turn 2 is done.").waitFor();
      // A session opens at its latest message, and its header stays in view.
      await page.waitForFunction(() => {
        const s = document.querySelector("#reviewScroll");
        return (
          s.scrollHeight <= s.clientHeight + 2 ||
          s.scrollTop + s.clientHeight >= s.scrollHeight - 30
        );
      });
      // The header sits above the scrolling conversation, so scrolling never moves it.
      // Measured in one step in the page: a redraw replaces the header element between calls.
      await page.locator("#viewHead .pk-page-header").waitFor();
      const [before, after, scroller] = await page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r && r.height ? { y: r.y, height: r.height } : null;
        };
        const first = box("#viewHead .pk-page-header");
        document.querySelector("#reviewScroll").scrollTop = 0;
        return [first, box("#viewHead .pk-page-header"), box("#reviewScroll")];
      });
      assert.ok(
        before &&
          after &&
          Math.abs(before.y - after.y) < 1 &&
          after.y + after.height <= scroller.y + 1,
        "The header stays above the conversation",
      );
      assert.equal(
        await page.locator("#reviewScroll .pk-page-header").count(),
        0,
      );
      // Ending sends the branch to the normal review.
      await page.getByRole("button", { name: "End session" }).click();
      await page.getByRole("region", { name: "End the session" }).waitFor();
      await page.screenshot({
        path: `test-results/session-end-${viewport.width}.png`,
      });
      await page.getByRole("button", { name: "Send to review" }).click();
      await page
        .locator("#viewHead .view-title", { hasText: "Ready for review" })
        .waitFor();
      // The conversation stays with the work.
      await page.getByText("Session conversation").click();
      await page
        .locator(".session-record [role=log]")
        .getByText("Turn 2 is done.")
        .waitFor();
      await page.screenshot({
        path: `test-results/session-review-${viewport.width}.png`,
      });
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
