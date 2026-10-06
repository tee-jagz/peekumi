import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { Repository } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";

const repo = new Repository(process.env.PEEKUMI_TEST_REPO || process.cwd(), {
  python:
    process.env.PEEKUMI_PYTHON ||
    (process.platform === "darwin" ? "/usr/bin/python3" : "python3"),
});
const head = await repo.resolve("HEAD");
let base;
try {
  base = await repo.resolve(process.env.PEEKUMI_TEST_BASE || "HEAD~1");
} catch {
  base = head;
}
const token = "browser-test-token";
const server = await startRust(repo.directory, {
  token,
  base,
  python: repo.python,
});
const url = server.url;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PEEKUMI_BROWSER_CHANNEL
    ? { channel: process.env.PEEKUMI_BROWSER_CHANNEL }
    : {}),
});
await mkdir("test-results", { recursive: true });
try {
  const data = await (
    await fetch(url + `/api/compare?base=${base}&head=${head}`, {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  const target =
    (process.env.PEEKUMI_TEST_FILE &&
      data.files.find((f) => f.path === process.env.PEEKUMI_TEST_FILE)) ||
    data.files.find(
      (f) =>
        f.status === "changed" && f.symbols.length && f.path.endsWith(".py"),
    ) ||
    data.files.find((f) => f.symbols.length);
  assert.ok(target, "An analysable file is required");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: "light" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(url);
    await page.locator("#connect").waitFor({ state: "visible" });
    errors.length = 0;
    await page.goto(url + "/#token=" + token);
    await page.reload();
    const front = page.locator('.sheet[data-front="true"]');
    await front.locator(".node").first().waitFor({ timeout: 45000 });
    await page.locator("#notice").waitFor({ state: "hidden" });
    if (process.env.PEEKUMI_TEST_BASE) {
      await page.locator("#revisionDetails > summary").click();
      await page.locator("#base").selectOption(base);
      await page.locator("#notice").waitFor({ state: "hidden" });
      await page.locator("#revisionDetails > summary").click();
    }
    assert.equal(await page.evaluate(() => location.hash), "");
    assert.equal(await front.locator(".node .dot, .node .kid i").count(), 0);
    assert.equal(
      await front.locator(".node .object-type-icon").count(),
      await front.locator(".node").count(),
    );
    assert.ok(
      await front.locator('.object-type-icon[aria-label="Directory"]').count(),
    );

    await page.locator("#mapLegend > summary").click();
    assert.equal(await page.locator(".canvas-controls #mapLegend").count(), 1);
    assert.match(
      await page.locator("#legendContent").innerText(),
      /Change colours/,
    );
    assert.match(
      await page.locator("#legendContent").innerText(),
      /Dependency rule violation/,
    );
    await page.screenshot({
      path: `test-results/${viewport.width}-legend.png`,
    });
    await page.locator('[data-lens="structure"]').click();
    assert.match(
      await page.locator("#legendContent").innerText(),
      /Git change colours are hidden/,
    );
    await page.locator('[data-lens="changes"]').click();
    await page
      .getByRole("button", { name: "Close legend", exact: true })
      .click();

    if (!(await page.locator("#helperTools").isVisible()))
      await page.locator("#sheetHandle").click();
    await page.locator('[data-tab="changes"]').click();
    assert.equal(
      await page.locator("#change-summary").getAttribute("data-count"),
      String(data.files.filter((f) => f.status !== "unchanged").length),
    );
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
      "App stays within viewport",
    );
    assert.equal(
      await page.locator("#revisionDetails").evaluate((el) => el.open),
      false,
    );
    const stage = await page.locator("#stage").boundingBox(),
      panel = await page.locator("#panel").boundingBox();
    if (viewport.width === 390) {
      assert.ok(stage.height > viewport.height * 0.25);
      assert.ok(panel.y >= stage.y + stage.height - 1);
    } else assert.ok(panel.x > stage.x + stage.width - 1);
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim()
          .toLowerCase(),
      ),
      "#007aff",
    );
    await page.screenshot({
      path: `test-results/${viewport.width}-overview.png`,
      fullPage: true,
    });
    const rootColumns = await front
      .locator(".node")
      .evaluateAll((nodes) => new Set(nodes.map((n) => n.style.left)).size);
    assert.ok(
      rootColumns > 1,
      "Repository graph uses multiple node columns, not a vertical stack",
    );
    const canvas = front.locator(".map-canvas");
    assert.equal(await canvas.count(), 1);
    const transform = () =>
      canvas.locator(":scope > .map-layer").evaluate((el) => el.style.transform);
    const initialTransform = await transform();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    assert.notEqual(await transform(), initialTransform);
    await page
      .getByRole("button", { name: "Reset map view", exact: true })
      .click();
    await canvas.hover({ position: { x: 10, y: 10 } });
    await page.mouse.wheel(0, 160);
    await page.waitForTimeout(50);
    assert.notEqual(await transform(), initialTransform);
    await page.getByRole("button", { name: "Fit map", exact: true }).click();
    const fitted = await transform();
    const rect = await canvas.boundingBox();
    // Start in the empty right margin; the top-left corner holds Before/After.
    await page.mouse.move(rect.x + rect.width - 6, rect.y + 70);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 40, rect.y + 120, {
      steps: 5,
    });
    await page.mouse.up();
    assert.notEqual(await transform(), fitted);
    assert.equal(
      await page.locator(".sel-name").count(),
      0,
      "Dragging does not select cards",
    );
    const cdp = await page.context().newCDPSession(page);
    const points = (distance) => [
      { x: rect.x + 130 - distance / 2, y: rect.y + 90, id: 1 },
      { x: rect.x + 130 + distance / 2, y: rect.y + 90, id: 2 },
    ];
    const beforePinch = await transform();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(60),
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(100),
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    assert.notEqual(await transform(), beforePinch, "Pinch changes map scale");
    assert.equal(
      await page.locator(".sel-name").count(),
      0,
      "Pinching does not select cards",
    );
    await cdp.detach();
    await page
      .getByRole("button", { name: "Changes only", exact: true })
      .click();
    assert.equal(
      await front
        .locator(
          '.node:not(.stub):not(.boundary)[data-status="unchanged"]:not([data-relationship-changed="true"])',
        )
        .count(),
      0,
    );
    assert.ok(
      await front
        .locator('.node[data-status="changed"],.node[data-status="added"]')
        .count(),
    );
    await page.screenshot({
      path: "test-results/" + viewport.width + "-filtered.png",
    });
    await page
      .getByRole("button", { name: "Changes only", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reset map view", exact: true })
      .click();
    const folder = target.path.split("/")[0];
    if (target.path.includes("/")) {
      const card = front
        .locator('.node[data-kind="folder"]')
        .filter({ has: page.locator(".n-name", { hasText: folder }) })
        .first();
      await card.focus();
      await card.click();
      if (process.env.PEEKUMI_TEST_DIRECTORY_DOC)
        assert.ok(
          (
            await page
              .locator(".directory-details .code-description")
              .textContent()
          ).includes(process.env.PEEKUMI_TEST_DIRECTORY_DOC),
        );
      assert.equal(await page.locator(".sel-name").textContent(), folder);
      // A tap on empty map space clears the selection; a drag on it does not.
      const empty = await page.evaluate(() => {
        const box = document
          .querySelector('.sheet[data-front="true"] .map-canvas')
          .getBoundingClientRect();
        for (let y = box.top + 20; y < box.bottom - 20; y += 12)
          for (let x = box.left + 20; x < box.right - 20; x += 12) {
            const hit = document.elementFromPoint(x, y);
            if (
              hit?.closest(".map-canvas") &&
              !hit.closest('.node, [role="button"], button, a, summary, details, input, select')
            )
              return { x, y };
          }
      });
      assert.ok(empty, "The map has empty space to tap");
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.down();
      await page.mouse.move(empty.x + 40, empty.y + 30, { steps: 5 });
      await page.mouse.up();
      assert.equal(await page.locator(".sel-name").textContent(), folder, "A drag keeps the selection");
      await page.mouse.click(empty.x + 40, empty.y + 30);
      await page.locator(".sel-name").waitFor({ state: "detached" });
      await card.click();
      assert.equal(await page.locator(".sel-name").textContent(), folder);
      assert.equal(
        await page.locator(".crumbs [aria-current]").textContent(),
        (await repo.metadata()).name,
      );
      await card.click();
      await page.waitForFunction(
        (folder) =>
          document.querySelector(".crumbs [aria-current]")?.textContent ===
          folder,
        folder,
      );
      await page.waitForTimeout(350);
      await page.screenshot({
        path: `test-results/${viewport.width}-component.png`,
        fullPage: true,
      });
    }
    if (!(await page.locator("#helperTools").isVisible()))
      await page.locator("#sheetHandle").click();
    await page.locator('[data-tab="changes"]').click();
    await page.locator("#search").fill(target.path);
    await page.locator("#changes .row").first().click();
    await page.waitForFunction(
      (path) =>
        document.querySelector(".crumbs [aria-current]")?.textContent ===
        path.split("/").at(-1),
      target.path,
    );
    await front.locator('.node[data-kind="symbol"]').first().waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: `test-results/${viewport.width}-module.png`,
      fullPage: true,
    });
    const selectedSymbol =
      target.symbols.find(
        (s) =>
          s.status === "changed" && ["function", "method"].includes(s.kind),
      ) || target.symbols.find((s) => ["function", "method"].includes(s.kind));
    assert.ok(selectedSymbol);
    // A method's card may drop its class's name, so the full name is in the card's title.
    const symbol = front
      .locator(`.node[data-kind="symbol"][title="${selectedSymbol.name}"]`)
      .first();
    await symbol.focus();
    await symbol.click();
    if (viewport.width === 390) {
      await page.locator("#sheetHandle").focus();
      await page.keyboard.press("Home");
      await page.locator("#selectionContract").waitFor({ state: "visible" });
      assert.equal(
        await page.locator('#selectionContract [aria-label="Inputs"]').count(),
        1,
      );
      assert.ok(
        (await page
          .locator('#selectionContract [aria-label="Outputs"]')
          .count()) <= 1,
      );
      assert.doesNotMatch(
        await page.locator("#selectionContract").innerText(),
        /unspecified/,
        "Peek omits missing annotations; Details labels them",
      );
      assert.equal(
        await page
          .locator("#reviewScope .status-icon")
          .getAttribute("aria-label"),
        {
          added: "Added",
          changed: "Modified",
          removed: "Removed",
          unchanged: "Unchanged",
        }[selectedSymbol.status],
      );
      assert.equal(
        await page.locator("#reviewScope .status-icon svg").count(),
        1,
      );
      assert.equal(
        await page
          .locator("#reviewScope .status-icon")
          .evaluate((el) => getComputedStyle(el).borderTopWidth),
        "0px",
      );
      assert.equal(await page.locator("#helperTools").isVisible(), false);
      assert.equal(await page.locator("#reviewScope .x").isVisible(), false);
      await page.waitForFunction(
        () => !document.querySelector("#panel").dataset.settling,
      );
      await page.screenshot({ path: "test-results/390-peek-contract.png" });
    }
    if (!(await page.locator("#helperTools").isVisible()))
      await page.locator("#sheetHandle").click();
    if (viewport.width === 390) {
      await page.locator("#sheetHandle").focus();
      await page.keyboard.press("End");
      await page.locator('[data-tab="source"]').click();
      assert.equal(
        await page.locator("#panel").getAttribute("data-height"),
        "full",
        "Changing inspection views keeps a full sheet full",
      );
      await page.locator("#sheetHandle").focus();
      await page.keyboard.press("ArrowDown");
    }
    await page.locator('[data-tab="source"]').click();
    await page.locator('[data-tab="details"]').click();
    await page.locator(".code-metadata .contract-lines").waitFor();
    assert.match(
      await page.locator(".adapter-note summary").textContent(),
      /adapter/,
    );
    // Return types appear only when declared; missing annotations are not listed.
    const returns = page.locator(".metadata-return");
    if (await returns.count())
      assert.match(await returns.textContent(), /^Returns /);
    assert.doesNotMatch(await page.locator("#selStrip").innerText(), /Unannotated/);
    await page.locator("#selStrip").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/" + viewport.width + "-metadata.png",
    });
    await page.locator('[data-tab="source"]').click();
    await page.locator("#source-code").waitFor();
    if (selectedSymbol.status === "changed")
      assert.ok(
        (await page
          .locator(".code-line.addition,.code-line.deletion")
          .count()) > 0,
      );
    await page.locator('[data-source-view="after"]').click();
    assert.ok((await page.locator(".code-line.highlight").count()) > 0);
    await page.screenshot({
      path: `test-results/${viewport.width}-source.png`,
      fullPage: true,
    });
    await page
      .locator("#panel")
      .screenshot({ path: `test-results/${viewport.width}-source-detail.png` });
    await page.locator('[data-source-view="before"]').click();
    assert.equal(
      await page
        .locator('[data-source-view="before"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    if (target.status !== "added")
      assert.match(
        await page.locator(".code-metadata .metadata-source").textContent(),
        /before/,
      );
    await page.locator('[data-tab="dependencies"]').click();
    assert.ok(await page.locator("#tabBody .list").isVisible());
    const edge = front.locator("path.hit").first();
    if (await edge.count()) {
      await edge.focus();
      await page.keyboard.press("Enter");
      assert.ok(
        /Static (import dependency|(?:calls|implements|inherits) relationship)/.test(
          await page.locator(".sel-kind").textContent(),
        ),
      );
    }
    await page.locator('[data-ba="before"]').click();
    assert.equal(
      await page.locator('[data-ba="before"]').getAttribute("aria-pressed"),
      "true",
    );
    await page.locator('[data-ba="after"]').click();
    await page.locator('[data-mode="time"]').click();
    await page.locator("#notice").waitFor({ state: "hidden" });
    assert.ok(await page.locator("#baSeg").isHidden());
    assert.equal(await page.locator(".sheet.peek").count(), 0);
    assert.ok(await page.locator("#timeRail").isVisible());
    const peek = page.locator('#timeRail .chip[aria-selected="false"]').first(),
      peekSha = await peek.getAttribute("data-sha");
    await peek.focus();
    await page.keyboard.press("Enter");
    await page.locator("#notice").waitFor({ state: "hidden" });
    await page.waitForFunction(
      (sha) =>
        document.querySelector('.chip[aria-selected="true"]')?.dataset.sha ===
        sha,
      peekSha,
    );
    // Home is disabled when the map is already at the repository root.
    const home = page
      .locator(".crumbs button")
      .filter({ hasText: (await repo.metadata()).name });
    if (await home.isEnabled()) await home.click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".crumbs [aria-current]").length === 1 &&
        document.querySelector(".crumbs [aria-current]")?.textContent ===
          document.querySelector("#repo-name").textContent,
    );
    await page.locator('[data-mode="diff"]').click();
    await page.locator("#notice").waitFor({ state: "hidden" });
    await page.locator("#revisionDetails").evaluate((node) => {
      node.open = true;
    });
    const baseTrigger = page.locator("#base + .frost-select");
    await baseTrigger.click();
    const menu = page.getByRole("listbox", { name: "Compare with revision" });
    await menu.waitFor();
    assert.equal(
      await menu.getByRole("option").count(),
      await page.locator("#base option").count(),
      "The frosted menu lists every native option",
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(
      await page.locator("#revisionDetails").evaluate((el) => el.open),
      true,
      "Closing a select menu keeps its popover open",
    );
    await page.locator("#base").selectOption(peekSha);
    await page.locator("#notice").waitFor({ state: "hidden" });
    assert.match(await baseTrigger.textContent(), new RegExp(peekSha.slice(0, 7)));
    await page.locator("#closeRevision").click();
    assert.equal(
      await page.locator("#revisionDetails").evaluate((el) => el.open),
      false,
    );
    await page.locator('[data-tab="changes"]').click();
    await page.waitForFunction(
      () => document.querySelector("#change-summary")?.dataset.count === "0",
    );
    await page.locator("#search").fill("peekumi-no-such-file-000");
    await page.locator("#changes .empty").waitFor({ state: "visible" });
    await page.locator("#search").fill("");
    if (viewport.width === 390) {
      // Simulate a phone keyboard: resizes-content shrinks the window while a field has focus.
      await page.locator("#sheetHandle").focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(
        () => !document.querySelector("#panel").dataset.settling,
      );
      await page.locator("#composerHost textarea").focus();
      await page.setViewportSize({ width: 390, height: 470 });
      await page.waitForFunction(() =>
        document.documentElement.classList.contains("keyboard-open"),
      );
      const field = await page.locator("#composerHost textarea").boundingBox(),
        sheet = await page.locator("#panel").boundingBox();
      assert.ok(
        field.y + field.height <= 470,
        "The question field stays above the keyboard",
      );
      assert.ok(sheet.height < 470 * 0.7, "Peek keeps its own size while typing");
      assert.equal(await page.locator(".canvas-controls").isVisible(), false);
      await page.screenshot({ path: "test-results/390-keyboard.png" });
      await page.locator("#composerHost textarea").blur();
      await page.setViewportSize(viewport);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("keyboard-open"),
      );
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `test-results/${viewport.width}-dark.png`,
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No page overflow",
    );
    if (process.env.PEEKUMI_TEST_DIRECTORY_DOC) {
      await page.reload();
      await page.locator("#notice").waitFor({ state: "hidden" });
      const card = page.locator(
        '.sheet[data-front="true"] .node[data-path="backend"]',
      );
      await card.waitFor();
      await card.click();
      await page.locator(".documentation-link").click();
      await page.locator("#source-code").waitFor();
      assert.ok(
        (await page.locator("#source-code").textContent()).includes(
          process.env.PEEKUMI_TEST_DIRECTORY_DOC,
        ),
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `PASS ${viewport.width}×${viewport.height}: reference layout, select/open, zoom drill-down, source, dependency selection, Time/mini cards, Diff, filters, dark theme, viewport`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
