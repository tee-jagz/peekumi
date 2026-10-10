import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { startRust } from "./rust-support.mjs";
import { changesRepo } from "./changes-fixture.mjs";

// A modified declaration says which parts changed, on its card and in the sheet.
const dir = await changesRepo();
let server, browser;
try {
  server = await startRust(dir);
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url + "/#token=" + server.token);
    const front = page.locator('.sheet[data-front="true"]'),
      group = front.locator('.pk-card[data-kind="rootfiles"]'),
      file = front.locator('.pk-card[data-path="lib.rs"]');
    // Root-level files sit inside the "Repository files" group.
    await group.waitFor();
    await group.click();
    await group.click();
    await file.waitFor();
    await file.click();
    await file.click();
    const imp = front.locator('.pk-card[data-key="symbol:imp"]');
    await imp.waitFor();
    assert.deepEqual(
      await front
        .locator('.pk-card[data-key="symbol:sig"] .part-icon')
        .evaluateAll((icons) => icons.map((i) => i.getAttribute("aria-label"))),
      ["Signature changed"],
    );
    assert.match(
      await imp.getAttribute("aria-label"),
      /Modified: implementation/,
    );
    await imp.click();
    assert.match(
      await page.locator("#reviewScope .review-parts").textContent(),
      /Implementation changed/,
    );
    await page.screenshot({
      path: `test-results/${viewport.width}-change-parts.png`,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS change parts on cards and in the sheet");
} finally {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
