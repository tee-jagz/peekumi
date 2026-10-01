import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startRust } from "./rust-support.mjs";
const temp = await mkdtemp(join(tmpdir(), "strata-pwa-"));
const second = join(temp, "second");
await mkdir(second);
const git = (...args) =>
  execFileSync("git", ["-C", second, ...args], { stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
await writeFile(join(second, "README.md"), "Second repository");
git("add", ".");
git("commit", "-m", "initial");
const server = await startRust(process.cwd(), { repositories: [second] });
const browser = await chromium.launch();
try {
  for (const width of [390, 1366]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("PAGE", e.message));
    await page.goto(server.url + "/#token=" + server.token);
    await page
      .locator('.sheet[data-front="true"] .node')
      .first()
      .waitFor({ timeout: 45000 })
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        await page.screenshot({ path: "test-results/setup-failure.png" });
        throw e;
      });
    await page.locator("#revisionDetails > summary").click();
    await page
      .getByLabel("Repository", { exact: true })
      .waitFor({ state: "visible" });
    await page.screenshot({ path: `test-results/usability-${width}.png` });
    const id = await page
      .locator("#repositoryPicker option")
      .filter({ hasText: "second" })
      .getAttribute("value");
    // PR context should reuse the actual canvas. Mock the network boundary, not UI internals.
    const repo = await (
      await page.request.get(server.url + "/api/repo")
    ).json();
    await page.route("**/api/prs", (r) =>
      r.fulfill({ json: [{ number: 7, title: "Review setup" }] }),
    );
    await page.route("**/api/prs/open", (r) =>
      r.fulfill({
        json: {
          base: repo.initialHead,
          head: repo.initialHead,
          pr: {
            title: "Review setup",
            url: "https://github.com/example/repo/pull/7",
            body: "Keep the existing canvas.",
            comments: [],
            reviews: [],
            statusCheckRollup: [{ name: "Tests", conclusion: "SUCCESS" }],
          },
        },
      }),
    );
    await page.locator("#loadPrs").click();
    await page.locator("#prPicker").selectOption("7");
    await page.locator("#prContext a").waitFor();
    assert.match(
      await page.locator("#prContext").innerText(),
      /Tests: SUCCESS/,
    );
    await page.locator("#repositoryPicker").selectOption(id);
    await page.waitForURL("**/?repo=" + id);
    await page.locator('.sheet[data-front="true"] .node').first().waitFor();
    assert.match(await page.title(), /second/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // API requests happened, but Cache Storage contains only application assets.
    const cached = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys())
        for (const req of await (await caches.open(k)).keys())
          out.push(req.url);
      return out;
    });
    assert.ok(cached.length > 5);
    assert.ok(
      cached.every((url) => !url.includes("/api/") && !url.includes("token=")),
    );
    await context.setOffline(true);
    await page.reload();
    await page.getByRole("status").filter({ hasText: "Offline" }).waitFor();
    assert.equal(
      await page.locator(".node").count(),
      0,
      "Offline reload must not restore private repository data",
    );
    await context.close();
    console.log(
      `PASS ${width}: multi-repo picker, PR context and shell-only offline PWA`,
    );
  }
  const page = await browser.newPage();
  const reader = (
    await readFile(join(server.state, "read-only/access-token"), "utf8")
  ).trim();
  await page.goto(server.url + "/#token=" + reader);
  await page.locator('.sheet[data-front="true"] .node').first().waitFor();
  assert.equal(await page.locator("#conversationDock").isVisible(), false);
  await page.close();
} finally {
  await browser.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
