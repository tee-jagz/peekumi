import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { command } from "./reference/engine.mjs";
import { startRust } from "./rust-support.mjs";
const dir = await mkdtemp(path.join(os.tmpdir(), "peekumi-rel-browser-"));
const git = (...args) => command("git", ["-C", dir, ...args]);
let server, browser;
try {
  await mkdir(path.join(dir, "web"));
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(
    path.join(dir, "web/provider.ts"),
    "export interface Port {}\nexport function helper(){return 1;}",
  );
  await writeFile(
    path.join(dir, "web/consumer.ts"),
    'import {Port,helper} from "./provider";\nexport class Client implements Port {}\n/** Calls a declared helper and an unknown receiver. */\nexport function run(receiver:any){ helper(); receiver.unknown(); }',
  );
  await git("add", ".");
  await git("commit", "-m", "Code");
  const base = (await git("rev-parse", "HEAD")).toString().trim();
  await writeFile(
    path.join(dir, ".peekumi.json"),
    JSON.stringify({
      version: 1,
      groups: { consumer: ["web/consumer.ts"], provider: ["web/provider.ts"] },
      rules: [
        {
          id: "boundary",
          from: "consumer",
          to: ["provider"],
          kinds: ["imports", "calls", "implements"],
          message: "Use the approved boundary",
        },
      ],
    }),
  );
  await git("add", ".");
  await git("commit", "-m", "Rules only");
  server = await startRust(dir, { base });
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
    await page
      .locator('.sheet[data-front="true"] .node[data-path="web"]')
      .waitFor();
    const front = page.locator('.sheet[data-front="true"]'),
      web = front.locator('.node[data-path="web"]');
    assert.ok(await web.locator(".rule-badge").count());
    await page
      .getByRole("button", { name: "Changes only", exact: true })
      .click();
    assert.ok(
      await web.isVisible(),
      "Rule-only changes retain the containing folder",
    );
    await web.click();
    await web.click();
    const consumer = front.locator('.node[data-path="web/consumer.ts"]');
    await consumer.waitFor();
    assert.ok(await consumer.locator(".rule-badge").count());
    assert.ok(await front.locator("path.e.violation").count());
    await page.locator('[data-ba="before"]').click();
    assert.equal(await front.locator(".rule-badge").count(), 0);
    await page.locator('[data-ba="after"]').click();
    await consumer.click();
    await consumer.click();
    await front.locator('.node[data-key="symbol:run"]').waitFor();
    await front.locator('.node[data-key="symbol:run"]').click();
    // Selecting a declaration emphasises its own connections and quiets the rest.
    assert.ok(
      await front.locator("path.e.hl.out").count(),
      "The selection's outgoing relationships are emphasised",
    );
    assert.equal(
      await front.locator('.node[data-key="symbol:run"].faded').count(),
      0,
    );
    if (await front.locator('.node[data-key="symbol:Client"]').count())
      assert.ok(
        await front.locator('.node.faded[data-key="symbol:Client"]').count(),
        "An unrelated declaration recedes",
      );
    if (!(await page.locator("#helperTools").isVisible()))
      await page.locator("#sheetHandle").click();
    await page.locator('[data-tab="dependencies"]').click();
    await page.locator('select[aria-label="Relationship kind"]').selectOption("calls");
    assert.ok(await front.locator("path.e.calls.violation").count());
    await page.locator(".unresolved-relations summary").click();
    assert.match(
      await page.locator(".unresolved-relations").textContent(),
      /receiver.unknown/,
    );
    await page.locator(".relationship-evidence summary").click();
    assert.match(
      await page.locator(".relationship-evidence").textContent(),
      /boundary/,
    );
    await page.screenshot({
      path: `test-results/${viewport.width}-relationships.png`,
    });
    await page.locator(".relationship-evidence button").first().click();
    await page.locator("#source-code").waitFor();
    assert.match(await page.locator("#source-code").textContent(), /helper/);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `PASS ${viewport.width}: rule-only badges, Before/After, call edge, unresolved evidence and source navigation`,
    );
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await rm(dir, { recursive: true, force: true });
}
