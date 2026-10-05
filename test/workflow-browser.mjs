import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
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
    const f = await fixture();
    // Each viewport starts with no saved conversation from the previous one.
    await f.req("/api/ask/history", { messages: [] }, "PUT");
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(f.server.url + "/#token=" + f.server.token);
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      assert.ok(await page.locator("#timeRail").isHidden());
      assert.equal(await page.locator(".sheet.peek").count(), 0);
      if (viewport.width < 900) {
        assert.equal(
          await page.locator("#panel").getAttribute("data-height"),
          "peek",
        );
        const map = await page.locator("#stage").boundingBox();
        assert.ok(
          map.height > viewport.height * 0.5,
          "Peek leaves most of the phone for the map",
        );
        await page.screenshot({ path: "test-results/sheet-peek.png" });
        await page
          .getByLabel("Your question")
          .fill("Keep my question while resizing");
        const anchor = await page.locator("#dockContext").textContent();
        const handle = page.locator("#sheetHandle");
        const bounds = await handle.boundingBox();
        await page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        const startHeight = (await page.locator("#panel").boundingBox()).height;
        await page
          .locator(".map-canvas")
          .evaluate((el) => (el.dataset.dragIdentity = "preserved"));
        const originalTransform = await page
          .locator(".map-canvas > .map-layer")
          .evaluate((el) => el.style.transform);
        await page.mouse.down();
        await page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2 - 30,
          { steps: 3 },
        );
        assert.equal(
          await page.locator("#helperTools").isVisible(),
          false,
          "Inspection controls remain hidden during a small drag out of peek",
        );
        const midHeight = (await page.locator("#panel").boundingBox()).height;
        assert.ok(
          Math.abs(midHeight - startHeight - 30) < 3,
          "Sheet follows the pointer before release",
        );
        assert.equal(
          await page
            .locator(".map-canvas")
            .getAttribute("data-drag-identity"),
          "preserved",
        );
        assert.equal(
          await page
            .locator(".map-canvas > .map-layer")
            .evaluate((el) => el.style.transform),
          originalTransform,
        );

        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 70, {
          steps: 6,
        });
        await page.mouse.up();
        assert.equal(
          await page.locator("#panel").getAttribute("data-height"),
          "half",
        );
        await page.screenshot({ path: "test-results/sheet-half.png" });
        await handle.focus();
        await page.keyboard.press("End");
        assert.equal(
          await page.locator("#panel").getAttribute("data-height"),
          "full",
        );
        await page.screenshot({ path: "test-results/sheet-full.png" });
        assert.equal(
          await page.getByLabel("Your question").inputValue(),
          "Keep my question while resizing",
        );
        assert.equal(await page.locator("#dockContext").textContent(), anchor);
        await page.keyboard.press("Home");
        // Losing pointer capture restores the original snap point without a stuck drag.
        const cancelBounds = await handle.boundingBox();
        await page.mouse.move(
          cancelBounds.x + cancelBounds.width / 2,
          cancelBounds.y + cancelBounds.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          cancelBounds.x + cancelBounds.width / 2,
          cancelBounds.y - 60,
          { steps: 3 },
        );
        await handle.evaluate((el) => el.releasePointerCapture(1));
        await page.mouse.up();
        await page.waitForFunction(
          () => !document.querySelector("#panel").dataset.dragging,
        );
        assert.equal(
          await page.locator("#panel").getAttribute("data-height"),
          "peek",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await handle.focus();
        await page.keyboard.press("End");
        assert.ok(
          await page
            .locator("#panel")
            .evaluate((el) =>
              el.getAnimations().some((a) => a.playState === "running"),
            ),
          "Release and keyboard transitions animate",
        );
        await page.waitForFunction(
          () => !document.querySelector("#panel").dataset.settling,
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.keyboard.press("Home");
        assert.equal(
          await page
            .locator("#panel")
            .evaluate((el) => el.getAnimations().length),
          0,
          "Reduced motion skips settling animation",
        );
        await page.getByLabel("Your question").fill("");
      }
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      const save = page.getByRole("button", { name: "Save draft", exact: true });
      assert.equal(await save.isDisabled(), true, "An empty instruction cannot be saved");
      const box = page.getByLabel("What should change, and why");
      const oneLine = await box.evaluate((t) => t.offsetHeight);
      await box.fill("One\nTwo\nThree\nFour\nFive\nSix");
      const grown = await box.evaluate((t) => t.offsetHeight);
      assert.ok(grown > oneLine * 1.8, "The box grows with its text");
      assert.ok(grown < oneLine * 3.2, "and stops at about four lines");
      await box.fill("Make the implementation easier to review.");
      assert.equal(await save.isDisabled(), false);
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.locator(".workflow-card[data-comment-id]").waitFor();
      assert.equal(
        await page.locator(".workflow-card[data-comment-id]").count(),
        1,
      );
      assert.equal(
        await page.locator("#helperTools").isVisible(),
        true,
        "A saved instruction stays with its selection instead of jumping to Tasks",
      );
      assert.equal(
        await page.locator("#showDiscussion").getAttribute("aria-pressed"),
        "true",
      );
      await page.screenshot({
        path: `test-results/workflow-comments-${viewport.width}.png`,
      });
      await page.locator("#openTasks").click();
      assert.equal(await page.locator("#helperTools").isVisible(), false);
      await page
        .getByRole("button", { name: "Review task · 1 draft", exact: true })
        .click();
      await page
        .getByLabel("Extra instructions (optional)")
        .fill("Keep the current behavior. Explain your checks.");
      await page
        .getByRole("button", { name: "Preview task", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Start task", exact: true })
        .waitFor();
      assert.match(
        await page.locator(".task-preview").innerText(),
        /Make the implementation easier to review/,
      );
      assert.equal(
        await page.locator(".taskpre").isVisible(),
        false,
        "Generated prompt is hidden by default",
      );
      await page.screenshot({
        path: `test-results/workflow-preview-${viewport.width}.png`,
      });
      // The fixture agent keeps running while this file exists.
      await writeFile(f.state + "/hold", "");
      await page
        .getByRole("button", { name: "Start task", exact: true })
        .click();
      // While the agent works, Peek works in the Tasks button, visible from every view, and
      // tapping it opens that task.
      const tasks = page.locator("#openTasks");
      await page.locator('#openTasks[data-cue="working"] .peek-mark[data-state="working"]').waitFor({ timeout: 15000 });
      assert.equal(await tasks.getAttribute("aria-label"), "Codex is working on a task");
      assert.equal(
        await page.locator('.task-head .task-peek[data-state="working"]').count(),
        1,
        "The running task shows Peek working too",
      );
      // Starting left the task open: the first tap closes Tasks, the second goes straight
      // back to the running task rather than the list.
      await tasks.click();
      await tasks.click();
      await page.locator('.task-head .task-peek[data-state="working"]').waitFor();
      await page.screenshot({ path: `test-results/tasks-working-${viewport.width}.png` });
      await rm(f.state + "/hold", { force: true });
      // When it finishes, Peek hops once and the usual icon returns in the accent colour.
      await page.locator('#openTasks[data-cue="ready"]').waitFor({ timeout: 20000 });
      await page.waitForFunction(
        () => !document.querySelector("#openTasks .peek-mark") && document.querySelector("#openTasks svg"),
        null,
        { timeout: 5000 },
      );
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      assert.ok(await page.getByLabel("Your question").isVisible());
      assert.ok(
        await page
          .getByRole("button", { name: "Back to tasks", exact: true })
          .isVisible(),
      );
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      // Keeping diagnostics open must not freeze the terminal state or review actions.
      await page.locator(".diagnostics > summary").click();
      await page
        .getByRole("button", { name: "Approve", exact: true })
        .waitFor({ timeout: 20000 });
      assert.equal(
        await page.locator(".diagnostics").evaluate((d) => d.open),
        true,
      );
      assert.equal(
        await page.locator(".diagnostics .taskpre").first().isVisible(),
        false,
      );
      await page.locator(".diagnostics > summary").click();
      assert.equal(
        await page.locator("#openTasks").getAttribute("data-ready"),
        "true",
      );
      const completed = (await f.req("/api/workflow")).runs.find(
        (r) => r.status === "completed",
      );
      // Explore changes shows the agent's whole branch on the map, compared with where the
      // task started, and a chip leads back to the task and the previous view.
      const explore = async () => {
        await page
          .getByRole("button", { name: "Explore changes", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            !document.querySelector("#branchPicker").disabled &&
            document
              .querySelector("#branchPicker")
              .value.startsWith("refs/heads/peekumi/"),
        );
      };
      await explore();
      assert.equal(
        await page.locator("#branchPicker").inputValue(),
        "refs/heads/" + completed.branch,
      );
      // The long run branch name shortens; it never runs under the header buttons, and
      // the compared commits stay fully visible.
      const header = await page.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const line = box("#revisionDetails > summary"),
          actions = box(".top-actions"),
          compare = box("#revisionSummary .rev-compare"),
          summary = box("#revisionSummary");
        return { clear: line.right <= actions.left + 1, whole: compare.right <= summary.right + 1 };
      });
      assert.deepEqual(header, { clear: true, whole: true });
      assert.equal((await f.git("rev-parse", "HEAD")).toString().trim(), f.sha);
      await page.locator("#taskReturn").waitFor();
      assert.ok(
        (await page.locator('.sheet[data-front="true"] .node:not([data-status="unchanged"])').count()) > 0,
        "The agent's changes are coloured on the map",
      );
      await page.screenshot({
        path: `test-results/agent-branch-${viewport.width}.png`,
      });
      // While exploring, changes are collected for this task's next round, not new drafts
      // from main, and exploring carries on.
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.getByLabel("Your question").fill("What would improve this change?");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Send question", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add to requested changes", exact: true })
        .click();
      await page.getByText("Added to requested changes", { exact: true }).waitFor();
      assert.equal(await page.locator("#taskReturn").innerText(), "Back to task · 1 to send");
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      await page.getByLabel("What should change, and why").fill("Keep the result file short.");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Add to requested changes", exact: true })
        .click();
      await page.locator("#taskReturn", { hasText: "2 to send" }).waitFor();
      assert.equal(
        await page.locator("#branchPicker").inputValue(),
        "refs/heads/" + completed.branch,
        "Collecting a change does not leave the agent's work",
      );
      await page.locator("#taskReturn").click();
      await page.getByText("Requested changes · 2", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Approve", exact: true })
        .waitFor();
      assert.equal(await page.locator("#branchPicker").inputValue(), "refs/heads/main");
      assert.equal(await page.locator("#taskReturn").isVisible(), false);
      await explore();
      await page.reload();
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      assert.equal(
        await page.locator("#branchPicker").inputValue(),
        "refs/heads/" + completed.branch,
      );
      await page.locator("#revisionDetails > summary").click();
      await page.locator("#branchPicker").selectOption("refs/heads/main");
      await page.locator("#notice").waitFor({ state: "hidden" });
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      // The note is optional: the phone run approves without one.
      if (viewport.width > 600) {
        await page.getByRole("button", { name: "Add note", exact: true }).click();
        await page
          .getByLabel("Review note")
          .fill("Inspected the result commit and the agent's reported checks.");
      }
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await page.screenshot({
        path: `test-results/workflow-task-${viewport.width}.png`,
      });
      // The Tasks button toggles back to the map selection, and so does empty map space.
      await page.locator("#openTasks").click();
      assert.equal(await page.locator("#openTasks").getAttribute("aria-pressed"), "false");
      await page.locator("#openTasks").click();
      assert.equal(await page.locator("#openTasks").getAttribute("aria-pressed"), "true");
      await page.locator(".task-link").first().click();
      // On the task, the bottom box adds to its list too, and one button sends the list to
      // the agent as round 2; there is no second box to fill in.
      assert.equal(await page.getByLabel("Anything else? (optional)").count(), 0);
      await page.getByLabel("What should change, and why").fill("Also say which round made the change.");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Add to requested changes", exact: true })
        .click();
      const send = page.getByRole("button", { name: "Send 3 changes to Codex", exact: true });
      await send.waitFor();
      await page.screenshot({
        path: `test-results/workflow-request-${viewport.width}.png`,
      });
      await send.click();
      await page.locator(".task-meta", { hasText: /round 2$/ }).waitFor();
      assert.equal(await page.getByText(/^Requested changes/).count(), 0, "The list went with round 2");
      await page
        .getByRole("button", { name: "Approve", exact: true })
        .waitFor({ timeout: 20000 });
      await page.locator("#openTasks").click();
      await page.locator("#openTasks").click();
      assert.equal(
        await page.locator(".task-link").count(),
        1,
        "Earlier rounds are part of the task, not separate tasks",
      );
      await page.locator(".task-link").first().click();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByText("Approved by you", { exact: false }).first().waitFor();
      await page
        .getByText("Approved · ready to merge", { exact: true })
        .waitFor();
      // A mistaken approval can be undone while the work is not on main.
      await page.getByRole("button", { name: "Reopen review", exact: true }).click();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByText("Approved · ready to merge", { exact: true }).waitFor();
      // After approval the task offers the merge itself, fast-forward only.
      await page.locator('.merge-step[data-state="ready"]').waitFor();
      assert.ok(await page.locator("#mergeTask").isVisible());
      assert.equal(await page.locator("#mergeTask").innerText(), "Merge into main");
      await page.waitForFunction(() => {
        const step = document.querySelector(".apply-step").getBoundingClientRect(),
          view = document.querySelector("#reviewScroll").getBoundingClientRect();
        return step.top >= view.top - 1 && step.top < view.bottom - 40;
      }, null, { timeout: 3000 });
      await page.screenshot({
        path: `test-results/workflow-verified-${viewport.width}.png`,
      });
      // In the Tasks list an approved task is quiet, under Done, not with work that needs you.
      await page.locator("#openTasks").click();
      if ((await page.locator("#openTasks").getAttribute("aria-pressed")) !== "true")
        await page.locator("#openTasks").click();
      await page.getByText("Done · waiting to merge", { exact: true }).waitFor();
      assert.equal(await page.locator(".task-link.quiet").count(), 1);
      assert.equal(await page.getByText("Needs you", { exact: true }).count(), 0);
      if (viewport.width < 900) {
        await page.locator("#sheetHandle").focus();
        await page.keyboard.press("Home");
      }
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".node").first().focus();
      await front.locator(".node").first().click();
      await front.locator(".node").first().click();
      await front.locator('.node[data-path="module.py"]').click();
      await front.locator('.node[data-path="module.py"]').click();
      await front.locator('.node[data-kind="symbol"]').first().click();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('[data-tab="source"]').click();
      await page.locator('[data-source-view="before"]').click();
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      await page.locator("#openTasks").click();
      await page
        .getByLabel("What should change, and why")
        .fill("Check this earlier declaration");
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      const anchored = await waitFor(async () => {
        const state = await f.req("/api/workflow");
        return state.comments.find(
          (c) => c.text === "Check this earlier declaration",
        );
      });
      assert.equal(anchored.sha, f.sha);
      assert.equal(anchored.anchor.kind, "symbol");
      assert.equal(anchored.anchor.path, "module.py");
      assert.equal(anchored.anchor.symbol, "run");
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page
        .getByLabel("Your question")
        .fill("What would improve this function?");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Send question", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Save as draft instruction", exact: true })
        .last()
        .waitFor();
      const countBefore = (await f.req("/api/workflow")).comments.length;
      await page.screenshot({ path: `test-results/ask-${viewport.width}.png` });
      await page
        .getByRole("button", { name: "Save as draft instruction", exact: true })
        .last()
        .click();
      await waitFor(
        async () =>
          (await f.req("/api/workflow")).comments.length === countBefore + 1,
      );
      await page
        .locator('[role="tab"][aria-label="Instruction"][aria-selected="true"]')
        .waitFor({ timeout: 5000 });
      await page
        .locator("#reviewScroll")
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      for (const selector of ["#newComment", '#tabs [data-compose="ask"]']) {
        const bounds = await page.locator(selector).boundingBox();
        const panel = await page.locator("#panel").boundingBox();
        assert.ok(
          bounds.y >= panel.y &&
            bounds.y + bounds.height <= panel.y + panel.height,
          "Primary action stays inside visible panel",
        );
      }
      assert.equal(await page.locator('#tabs [role="tab"]').count(), 2);
      // A name in an answer links to the map; following it keeps the conversation in view.
      const home = page.locator(".crumbs .crumb-home");
      if (await home.isEnabled()) await home.click();
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.getByLabel("Your question").fill("Name references.");
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Send question", exact: true })
        .click();
      const runLink = page.locator(".ask-message .code-link", { hasText: /^run$/ });
      await runLink.waitFor();
      assert.equal(
        await page.locator(".ask-message .code-link", { hasText: "nowhere_at_all" }).count(),
        0,
        "Unknown names stay plain text",
      );
      await page.screenshot({ path: `test-results/ask-links-${viewport.width}.png` });
      await runLink.click();
      await page.waitForFunction(
        () => document.querySelector("#reviewScope .review-name")?.textContent === "run",
      );
      assert.equal(
        await page.locator('.sheet[data-front="true"] .node.sel').getAttribute("data-key"),
        "symbol:run",
        "The linked declaration is selected on the map",
      );
      assert.ok(
        await page.locator(".ask-message.from-user", { hasText: "Name references." }).isVisible(),
        "The conversation stays in view after following a link",
      );
      assert.equal(
        await page.getByLabel("Your question").getAttribute("placeholder"),
        "Ask about run",
        "The next question is about the new selection",
      );
      // Moving around the map keeps the one conversation in view, at the same reading position.
      const review = page.locator("#reviewScroll");
      await review.evaluate((el) => (el.scrollTop = el.scrollHeight));
      const reading = await review.evaluate((el) => el.scrollTop);
      if (await home.isEnabled()) await home.click();
      await page.locator(".ask-message.from-user", { hasText: "Name references." }).waitFor();
      assert.equal(await page.locator("#panel").getAttribute("data-view"), "ask");
      assert.ok(
        await review.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
        "A reader at the end of the chat stays at the end after navigating",
      );
      assert.ok(reading > 0);
      // Coming back to Discussion resumes at the end of the latest message.
      await review.evaluate((el) => (el.scrollTop = 0));
      if (!(await page.locator("#helperTools").isVisible())) await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="details"]').click();
      await page.locator("#showDiscussion").click();
      await page.waitForFunction(() => {
        const el = document.querySelector("#reviewScroll");
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      });
      await page.screenshot({ path: `test-results/ask-link-followed-${viewport.width}.png` });
      await page.screenshot({
        path: `test-results/persistent-review-${viewport.width}.png`,
      });
      // Reloading (as an app update does) brings the conversation back.
      await page.reload();
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      if (!(await page.locator("#showDiscussion").isVisible())) await page.locator("#sheetHandle").click();
      await page.locator("#showDiscussion").click();
      await page.locator(".ask-message.from-user", { hasText: "Name references." }).waitFor();
      assert.ok(
        await page.locator(".ask-message.from-user", { hasText: "What would improve this function?" }).isVisible(),
        "The whole conversation is restored after a reload",
      );
      assert.equal(
        await page.locator(".ask-message", { hasText: "What would improve this change?" }).count(),
        0,
        "A question asked on the agent's branch stays in that branch's conversation",
      );
      // Inputs must remain reachable at the viewport edge, not merely inside a panel.
      const assertDockVisible = async () => {
        const dock = await page.locator("#conversationDock").boundingBox();
        const size = page.viewportSize();
        assert.ok(dock.y >= 0 && dock.y + dock.height <= size.height + 1);
        assert.ok(
          size.height - (dock.y + dock.height) < 24,
          "Dock stays at the bottom edge",
        );
        const input = await page
          .locator("#composerHost textarea")
          .boundingBox();
        assert.ok(input.y >= dock.y && input.y + input.height <= size.height);
      };
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page
        .locator("#reviewScroll")
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      await assertDockVisible();
      await page.screenshot({
        path: `test-results/bottom-ask-${viewport.width}.png`,
      });
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      await page.locator("#openTasks").click();
      await page
        .getByLabel("What should change, and why")
        .fill("Keep this unfinished comment anchored.");
      await assertDockVisible();
      await page.screenshot({
        path: `test-results/bottom-comment-${viewport.width}.png`,
      });
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      await page.locator("#openTasks").click();
      assert.equal(
        await page.getByLabel("What should change, and why").inputValue(),
        "Keep this unfinished comment anchored.",
      );
      if (viewport.width < 900) {
        await page.setViewportSize({ width: viewport.width, height: 460 });
        await page.waitForFunction(
          () =>
            Math.abs(
              parseFloat(
                document.documentElement.style.getPropertyValue(
                  "--viewer-height",
                ),
              ) - window.visualViewport.height,
            ) < 1,
        );
        await page.screenshot({ path: "test-results/bottom-short-debug.png" });
        await assertDockVisible();
        await page.screenshot({
          path: "test-results/bottom-short-viewport.png",
        });
        await page.setViewportSize(viewport);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false);
      // Once merged, the task leaves the Tasks list for History, where it is a settled record:
      // no review actions, and Follow up starts a new instruction at the same place.
      let latest = (await f.req("/api/workflow")).runs.find(
        (r) => r.status === "completed" && !r.revisedBy,
      );
      if ((await page.locator("#openTasks").getAttribute("aria-pressed")) !== "true")
        await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      // The merge asks first, with the files it changes; it can be undone, then done again.
      await page.locator("#mergeTask").click();
      const sheet = page.locator("dialog.merge-dialog");
      await sheet.waitFor();
      assert.match(await sheet.innerText(), /Merge 2 commits into main\?[^]*agent-result\.txt[^]*Nothing is pushed/);
      await page.screenshot({ path: `test-results/workflow-merge-confirm-${viewport.width}.png` });
      await page.locator("#confirmMerge").click();
      await page.locator('.merge-step[data-state="merged"]').waitFor();
      assert.equal((await f.git("rev-parse", "main")).toString().trim(), (await f.git("rev-parse", latest.branch)).toString().trim());
      await page.screenshot({ path: `test-results/workflow-merged-${viewport.width}.png` });
      await page.locator("#undoMerge").click();
      await page.locator('.merge-step[data-state="ready"]').waitFor();
      assert.equal((await f.git("rev-parse", "main")).toString().trim(), f.sha);
      // The owner's uncommitted file is in the way: the refused merge shows it, the owner
      // commits it with the agent's message, and the conflict goes to the agent as a round.
      await writeFile(path.join(f.dir, "agent-result.txt"), "The owner's own notes.\n");
      await page.locator("#mergeTask").click();
      await page.locator("#confirmMerge").click();
      await page.locator('.merge-step[data-state="blocked"]').waitFor();
      assert.match(await page.locator(".merge-step").innerText(), /1 of your files is in the way[^]*agent-result\.txt/);
      await page.screenshot({ path: `test-results/workflow-blocked-${viewport.width}.png` });
      await page.locator("#commitFirst").click();
      const message = page.getByLabel("Commit message · written by the agent, you can edit it");
      await message.waitFor();
      assert.equal(await message.inputValue(), "Record the owner's own result notes");
      await page.screenshot({ path: `test-results/workflow-commit-mine-${viewport.width}.png` });
      await page.locator("#commitMine").click();
      await page.locator(".workflow-card.requested", { hasText: "Update with main" }).waitFor({ timeout: 30000 });
      assert.equal((await f.git("log", "-1", "--format=%s", "main")).toString().trim(), "Record the owner's own result notes");
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.locator('.merge-step[data-state="ready"]').waitFor();
      await page.locator("#mergeTask").click();
      await page.locator("#confirmMerge").click();
      await page.locator('.merge-step[data-state="merged"]').waitFor();
      await page.locator("#openTasks").click();
      if ((await page.locator("#openTasks").getAttribute("aria-pressed")) !== "true")
        await page.locator("#openTasks").click();
      const historyLink = page.locator(".history-link");
      await historyLink.waitFor();
      assert.match(await historyLink.innerText(), /^History · \d+$/);
      assert.equal(await page.getByText("Done · waiting to merge", { exact: true }).count(), 0);
      await historyLink.click();
      await page.locator(".task-link.quiet").first().click();
      await page.getByText("Merged into main", { exact: true }).first().waitFor();
      for (const name of ["Approve", "Request changes", "Reopen review"])
        assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
      await page.getByRole("button", { name: "Follow up", exact: true }).click();
      assert.match(await page.locator("#dockContext").innerText(), /main$/);
      // Agents: two jobs, each one short list from the server, kept on this device.
      await page.reload();
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      await page.locator("#openTasks").click();
      await page.locator(".tasks-uses", { hasText: "New tasks use Codex · Default" }).waitFor();
      await page.locator("#openAgents").click();
      const agentsSheet = page.locator("dialog.agents-dialog");
      await agentsSheet.locator(".agents-row", { hasText: /^Ask/ }).waitFor();
      assert.match(await agentsSheet.innerText(), /Ask[^]*Claude · Sonnet · low[^]*Tasks[^]*Codex · Default/);
      await agentsSheet.locator(".agents-row", { hasText: /^Tasks/ }).click();
      // Provider, then its models as the provider reports them, then that model's efforts.
      assert.match(await agentsSheet.innerText(), /Provider[^]*Model[^]*Default[^]*Fixture Large[^]*Fixture Small[^]*Other model[^]*Effort/);
      await agentsSheet.getByRole("button", { name: "Claude Code", exact: true }).click();
      await agentsSheet.getByText("Opus", { exact: true }).click();
      assert.deepEqual(
        await agentsSheet.locator(".agents-effort").allInnerTexts(),
        ["Auto", "Low", "Medium", "High", "Max"],
      );
      await agentsSheet.getByRole("button", { name: "High", exact: true }).click();
      await agentsSheet.getByText("Other model", { exact: true }).click();
      await agentsSheet.getByLabel("Model name").fill("--bad");
      await agentsSheet.getByRole("button", { name: "Use", exact: true }).click();
      await agentsSheet.getByText("Use only letters", { exact: false }).waitFor();
      await page.screenshot({ path: `test-results/agents-${viewport.width}.png` });
      await agentsSheet.getByRole("button", { name: "Back to Agents" }).click();
      assert.match(await agentsSheet.innerText(), /Tasks[^]*Claude · Opus · high/);
      await agentsSheet.getByRole("button", { name: "Close" }).click();
      await page.locator(".tasks-uses", { hasText: "New tasks use Claude · Opus · high" }).waitFor();
      await page.reload();
      await page.locator('.sheet[data-front="true"] .node').first().waitFor();
      assert.deepEqual(
        await page.evaluate(() => JSON.parse(localStorage.getItem("peekumi.agents.default")).task),
        { agent: "claude", model: "opus", effort: "high" },
        "The choice stays on this device",
      );
      // The composer's chip names what the current mode uses and opens that list.
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.locator("#dockAgent", { hasText: "Claude · Sonnet · low" }).waitFor();
      await page.locator("#dockAgent").click();
      await page.locator("dialog.agents-dialog h2", { hasText: "Ask uses" }).waitFor();
      await page.screenshot({ path: `test-results/agents-ask-${viewport.width}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Instruction", exact: true }).click();
      await page.locator("#dockAgent", { hasText: "Claude · Opus · high" }).waitFor();
      assert.deepEqual(errors, []);
      console.log(
        `Workflow browser ${viewport.width}: draft → preview → dispatch → MCP report → inspect → verify passed`,
      );
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
