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
    const f = await fixture();
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
          .locator("svg.map-canvas")
          .evaluate((el) => (el.dataset.dragIdentity = "preserved"));
        const originalTransform = await page
          .locator("svg.map-canvas > g")
          .getAttribute("transform");
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
            .locator("svg.map-canvas")
            .getAttribute("data-drag-identity"),
          "preserved",
        );
        assert.equal(
          await page.locator("svg.map-canvas > g").getAttribute("transform"),
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
      await page.getByRole("tab", { name: "Comment", exact: true }).click();
      await page
        .getByLabel("What should change, and why")
        .fill("Make the implementation easier to review.");
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.locator(".workflow-card[data-comment-id]").waitFor();
      assert.equal(
        await page.locator(".workflow-card[data-comment-id]").count(),
        1,
      );
      assert.equal(await page.locator("#helperTools").isVisible(), false);
      await page.screenshot({
        path: `test-results/workflow-comments-${viewport.width}.png`,
      });
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
      await page
        .getByRole("button", { name: "Start task", exact: true })
        .click();
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      assert.ok(await page.getByLabel("Your question").isVisible());
      assert.ok(
        await page
          .getByRole("button", { name: "Back to tasks", exact: true })
          .isVisible(),
      );
      await page.getByRole("tab", { name: "Comment", exact: true }).click();
      // Keeping diagnostics open must not freeze the terminal state or review actions.
      await page.locator(".diagnostics > summary").click();
      await page
        .getByRole("button", { name: "Mark task reviewed", exact: true })
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
      await page
        .getByRole("button", { name: "Review all changes", exact: true })
        .click();
      await page.getByLabel("Changed file").waitFor();
      await page.locator(".readable-diff .addition").first().waitFor();
      assert.ok(
        (await page.locator(".readable-diff .line-number").count()) > 0,
      );
      assert.ok(
        !(await page.locator(".readable-diff").innerText()).includes(
          "diff --git",
        ),
      );
      await page.screenshot({
        path: `test-results/workflow-diff-${viewport.width}.png`,
      });
      await page
        .getByRole("button", { name: "Back to result", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Mark task reviewed", exact: true })
        .click();
      await page
        .getByLabel("Review note")
        .fill("Inspected the result commit and the agent's reported checks.");
      await page
        .getByRole("button", { name: "Confirm review", exact: true })
        .click();
      await page.getByText("Reviewed by you:", { exact: false }).waitFor();
      await page
        .getByText("Reviewed · not applied to main", { exact: true })
        .waitFor();
      await page.screenshot({
        path: `test-results/workflow-verified-${viewport.width}.png`,
      });
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
      await page.getByRole("tab", { name: "Comment", exact: true }).click();
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
        .getByRole("button", { name: "Ask", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Make draft comment", exact: true })
        .waitFor();
      const countBefore = (await f.req("/api/workflow")).comments.length;
      await page.screenshot({ path: `test-results/ask-${viewport.width}.png` });
      await page
        .getByRole("button", { name: "Make draft comment", exact: true })
        .click();
      await waitFor(
        async () =>
          (await f.req("/api/workflow")).comments.length === countBefore + 1,
      );
      assert.equal(
        await page
          .getByRole("tab", { name: "Comment", exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
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
      await page.screenshot({
        path: `test-results/persistent-review-${viewport.width}.png`,
      });
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
      await page.getByRole("tab", { name: "Comment", exact: true }).click();
      await page.locator("#openTasks").click();
      await page
        .getByLabel("What should change, and why")
        .fill("Keep this unfinished comment anchored.");
      await assertDockVisible();
      await page.screenshot({
        path: `test-results/bottom-comment-${viewport.width}.png`,
      });
      await page.getByRole("tab", { name: "Ask", exact: true }).click();
      await page.getByRole("tab", { name: "Comment", exact: true }).click();
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
