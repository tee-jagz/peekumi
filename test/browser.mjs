import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { Repository } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";

const repo = new Repository(process.env.STRATA_TEST_REPO || process.cwd(), {
  python:
    process.env.STRATA_PYTHON ||
    (process.platform === "darwin" ? "/usr/bin/python3" : "python3"),
});
const head = await repo.resolve("HEAD");
let base;
try {
  base = await repo.resolve(process.env.STRATA_TEST_BASE || "HEAD~1");
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
  ...(process.env.STRATA_BROWSER_CHANNEL
    ? { channel: process.env.STRATA_BROWSER_CHANNEL }
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
    (process.env.STRATA_TEST_FILE &&
      data.files.find((f) => f.path === process.env.STRATA_TEST_FILE)) ||
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
    if (process.env.STRATA_TEST_BASE) {
      await page.locator("#revisionDetails > summary").click();
      await page.locator("#base").selectOption(base);
      await page.locator("#notice").waitFor({ state: "hidden" });
      await page.locator("#revisionDetails > summary").click();
    }
    assert.equal(await page.evaluate(() => location.hash), "");
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
    const canvas = front.locator("svg.map-canvas");
    assert.equal(await canvas.count(), 1);
    const transform = () =>
      canvas.locator(":scope > g").getAttribute("transform");
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
    await page.mouse.move(rect.x + 10, rect.y + 30);
    await page.mouse.down();
    await page.mouse.move(rect.x + 40, rect.y + 80, { steps: 5 });
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
      if (process.env.STRATA_TEST_DIRECTORY_DOC)
        assert.ok(
          (
            await page
              .locator(".directory-details .code-description")
              .textContent()
          ).includes(process.env.STRATA_TEST_DIRECTORY_DOC),
        );
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
    const symbol = front
      .locator('.node[data-kind="symbol"]')
      .filter({
        has: page.locator(".n-name", { hasText: selectedSymbol.name }),
      })
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
      assert.equal(
        await page.locator('#selectionContract [aria-label="Outputs"]').count(),
        1,
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
    await page.locator('[data-tab="source"]').click();
    await page.locator('[data-tab="details"]').click();
    await page.locator(".code-metadata .signature").waitFor();
    assert.match(
      await page.locator(".adapter-details summary").textContent(),
      /adapter/,
    );
    assert.ok(
      (await page.locator(".metadata-return").textContent()).includes(
        "Returns:",
      ),
    );
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
        await page.locator(".code-metadata > h3").textContent(),
        /Before/,
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
    await page
      .locator(".crumbs button")
      .filter({ hasText: (await repo.metadata()).name })
      .click();
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
    await page.locator("#base").selectOption(peekSha);
    await page.locator("#notice").waitFor({ state: "hidden" });
    await page.locator("#helperTools").evaluate((node) => {
      node.open = true;
    });
    await page.locator('[data-tab="changes"]').click();
    await page.waitForFunction(
      () => document.querySelector("#change-summary")?.dataset.count === "0",
    );
    await page.locator("#search").fill("strata-no-such-file-000");
    assert.ok(await page.locator("#changes .empty").isVisible());
    await page.locator("#search").fill("");
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
    if (process.env.STRATA_TEST_DIRECTORY_DOC) {
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
          process.env.STRATA_TEST_DIRECTORY_DOC,
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
