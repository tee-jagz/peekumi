/** Dependency rules in the browser: a task that adds a rule break says so before Approve; the
 * rule summary shows the breaks a comparison adds and each rule's coverage; a card counts its
 * breaks, and the sheet names them in one line; and "Forbid this dependency" on a
 * relationship starts an instruction that asks for a rule. Phone and desktop. */
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
    const f = await fixture({
      files: {
        ".peekumi.json": JSON.stringify({
          version: 1,
          groups: { ui: ["ui/**"], db: ["db/**"] },
          rules: [
            {
              id: "ui-no-db",
              from: "ui",
              to: ["db"],
              kinds: ["imports", "calls"],
              message: "The UI goes through services.",
            },
          ],
        }),
        "ui/__init__.py": "",
        "ui/view.py": "def show():\n    return 1\n",
        "db/__init__.py": "",
        "db/store.py": "def save():\n    return 2\n",
      },
    });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      // A task whose commit makes ui/view.py import db/store.py.
      const c = await f.req("/api/comments", {
        text: "Write the result file. CHECK_RULES",
        sha: f.sha,
        anchor: { kind: "repo", path: "" },
      });
      const p = await f.req("/api/runs/preview", {
        commentIds: [c.id],
        using: { agent: "claude" },
      });
      await f.req("/api/runs", { previewId: p.id });
      await waitFor(
        async () => (await f.req("/api/runs/" + p.id)).status === "completed",
      );
      await page.goto(f.server.url + "/#token=" + f.server.token);
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".node").first().waitFor();

      // The task names the break before Approve.
      await page.locator("#openTasks").click();
      await page.locator(".task-link").first().click();
      const note = page.locator(".rule-added-note");
      await note.waitFor();
      assert.match(
        await note.innerText(),
        /adds 1 dependency rule break: ui-no-db \(view\.py → store\.py\)/,
      );
      await page.screenshot({
        path: `test-results/rules-task-${viewport.width}.png`,
      });

      // On the task's branch, the rule summary shows the added break and the coverage.
      await page
        .getByRole("button", { name: "Explore changes", exact: true })
        .click();
      await page.locator("#taskReturn:not([hidden])").waitFor();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="dependencies"]').click();
      const summary = page.locator(".rule-summary > summary");
      await summary.waitFor();
      assert.match(
        await summary.innerText(),
        /^1 new rule break · 1 rule violation · 1 rule/,
      );
      await summary.click();
      assert.match(
        await page.locator(".rule-summary .rule-added").first().innerText(),
        /ui-no-db: ui\/view\.py → db\/store\.py \(imports\)/,
      );
      assert.match(
        await page.locator(".rule-summary .rule-coverage").first().innerText(),
        /^ui-no-db: checked \d+, broke 1, unresolved \d+$/,
      );

      // The card that breaks the rule counts its breaks in its own row (no badge), and the
      // sheet says what it breaks in one line, which opens only the breaks.
      const ui = front.locator('.node[data-path="ui"]');
      assert.equal(
        await ui.locator(".n-breaks").getAttribute("aria-label"),
        "1 dependency rule break",
      );
      assert.equal(await page.locator(".rule-badge").count(), 0);
      await ui.click();
      const line = page.locator("#reviewScope .review-breaks");
      assert.match(
        await line.innerText(),
        /^Breaks ui-no-db · 1 import of store\.py/,
      );
      await line.click();
      assert.equal(
        await page.evaluate(
          () => document.querySelector("#panel").dataset.view,
        ),
        "dependencies",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Violations only" })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.screenshot({
        path: `test-results/rules-breaks-${viewport.width}.png`,
      });

      // "Forbid this dependency" on the relationship starts an instruction draft.
      await page.evaluate(() =>
        document
          .querySelector('.sheet[data-front="true"] path.hit')
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="details"]').click();
      await page
        .getByRole("button", { name: /Forbid this dependency/ })
        .click();
      const box = page.getByLabel("What should change, and why");
      await box.waitFor();
      assert.match(
        await box.inputValue(),
        /^Add a rule to \.peekumi\.json that forbids imports from ui\/\*\* to db\/\*\*/,
      );
      await page.screenshot({
        path: `test-results/rules-forbid-${viewport.width}.png`,
      });

      // Proposed fixes: from Relations, one fix for the break; it can be cleared, edited and
      // sent; the task form opens with that draft selected.
      await page
        .locator("#composerHost")
        .getByRole("button", { name: "Cancel" })
        .click()
        .catch(() => {});
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="dependencies"]').click();
      await page
        .getByRole("button", { name: /^Propose fixes for 1 rule break/ })
        .click();
      const rows = page.locator(".fix-row");
      await rows.first().waitFor();
      assert.equal(await rows.count(), 1);
      assert.equal(
        await page.locator("#viewHead .view-meta").innerText(),
        "1 rule break in 1 place",
      );
      // The agent read the code and proposed the fix; Peekumi's group is its context.
      assert.match(
        await page.locator("#tabBody .read-note").first().innerText(),
        /^Claude Code read the code and proposed these fixes/,
      );
      assert.equal(
        await rows.first().locator("strong").innerText(),
        "Reach the store through a service",
      );
      assert.match(
        await rows.first().locator("textarea").inputValue(),
        /^Create services\/store\.py/,
      );
      assert.equal(await page.locator(".fix-context").count(), 1);
      const send = page.locator(".fix-buttons .primary");
      assert.equal(await send.innerText(), "Send 1 fix to an agent");
      await rows.first().locator("input[type=checkbox]").uncheck();
      assert.ok(await send.isDisabled(), "Nothing selected, nothing to send");
      await rows.first().locator("input[type=checkbox]").check();
      await rows
        .first()
        .locator("textarea")
        .fill("Move save behind a service in a new services/ folder.");
      await page.screenshot({
        path: `test-results/rules-fixes-${viewport.width}.png`,
      });
      await send.click();
      await page.waitForFunction(
        () => document.querySelector("#panel").dataset.view === "prepare",
      );
      const picked = page.locator(".workflow-pick", {
        hasText: "Move save behind a service",
      });
      await picked.waitFor();
      assert.ok(await picked.locator("input").isChecked());
      assert.equal(
        await page.locator(".workflow-pick input:checked").count(),
        1,
        "Only the sent fix is selected",
      );

      // Proposed rules: the agent audits the architecture; the rules show under their
      // principles with what they check now, and none is selected at first. Proposals that
      // the current rule already covers are left out. An edit is tried again, an invalid rule
      // cannot be selected, and each sent rule is one draft on .peekumi.json.
      await page.reload();
      await front.locator(".node").first().waitFor();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="dependencies"]').click();
      await page
        .getByRole("button", { name: "Propose rules", exact: true })
        .click();
      const audits = page.locator(".audit-row");
      await audits.first().waitFor();
      assert.equal(await audits.count(), 2);
      assert.deepEqual(
        await page.locator("#tabBody h3.workflow-group").allInnerTexts(),
        ["Dependency inversion", "Layering"],
      );
      assert.equal(
        await page.locator("#viewHead .view-meta").innerText(),
        "2 rules under 2 principles",
      );
      assert.match(
        await audits.first().locator("small").innerText(),
        /^ui-imports-no-db · /,
      );
      const layers = page.locator(".audit-row", { hasText: "app-layers" });
      assert.match(
        await layers.innerText(),
        /Group "services" matches no file/,
      );
      await page.locator(".fix-context summary").click();
      assert.match(
        await page.locator(".fix-context").innerText(),
        /^The last audit left out 4 proposals[^]*Narrower: The rule "ui-no-db" already covers it/,
      );
      const add = page.locator(".fix-buttons .primary");
      assert.equal(
        await page.locator(".audit-row input[type=checkbox]:checked").count(),
        0,
        "No rule is selected at first",
      );
      assert.ok(await add.isDisabled());
      await layers.locator("input[type=checkbox]").check();
      assert.equal(await add.innerText(), "Add 1 rule with an agent");
      await layers.locator("summary", { hasText: "Edit rule" }).click();
      const ruleText = layers.locator("textarea");
      const original = await ruleText.inputValue();
      await ruleText.fill(original.replace('"calls"', '"reads"'));
      await ruleText.blur();
      await layers
        .locator(".rule-error", { hasText: "Unknown relationship kind reads" })
        .waitFor();
      assert.ok(await layers.locator("input[type=checkbox]").isDisabled());
      assert.ok(await add.isDisabled(), "A refused rule cannot be sent");
      await page.screenshot({
        path: `test-results/rules-audit-${viewport.width}.png`,
      });
      await layers.locator("textarea").fill(original);
      await layers.locator("textarea").blur();
      await page.waitForFunction(
        () => !document.querySelector(".audit-row .rule-error"),
      );
      assert.ok(
        await layers.locator("input[type=checkbox]").isChecked(),
        "The selection stays",
      );
      assert.equal(
        await page.locator(".fix-buttons .primary").innerText(),
        "Add 1 rule with an agent",
      );
      await page.locator(".fix-buttons .primary").click();
      await page.waitForFunction(
        () => document.querySelector("#panel").dataset.view === "prepare",
      );
      const rulePick = page.locator(".workflow-pick", {
        hasText: 'Add the dependency rule "app-layers" to .peekumi.json',
      });
      await rulePick.waitFor();
      assert.ok(await rulePick.locator("input").isChecked());
      assert.equal(
        await page.locator(".workflow-pick input:checked").count(),
        1,
        "Only the sent rule is selected",
      );
      // The choices stay on the server: after a reload, the list is the same (no new audit),
      // the other rule is still not selected and the sent rule is drafted.
      await page.reload();
      await front.locator(".node").first().waitFor();
      if (!(await page.locator("#helperTools").isVisible()))
        await page.locator("#sheetHandle").click();
      await page.locator('#helperTools [data-tab="dependencies"]').click();
      await page
        .getByRole("button", { name: "Propose rules", exact: true })
        .click();
      await page.locator(".audit-row").first().waitFor();
      assert.equal(await page.locator(".audit-row").count(), 2);
      assert.equal(
        await page
          .locator(".audit-row", { hasText: "ui-imports-no-db" })
          .locator("input[type=checkbox]")
          .isChecked(),
        false,
      );
      assert.match(
        await page
          .locator(".audit-row", { hasText: "app-layers" })
          .locator("small")
          .innerText(),
        / · drafted$/,
      );
      assert.deepEqual(errors, []);
      console.log(`PASS rules ${viewport.width}`);
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
