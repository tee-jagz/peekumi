import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startRust } from "./rust-support.mjs";
const temp = await mkdtemp(join(tmpdir(), "peekumi-pwa-"));
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
    // Until the first map is drawn, Peek loads in the map area and names the current step.
    let release;
    const held = new Promise((done) => (release = done));
    await page.route("**/api/compare?*", async (r) => {
      await held;
      await r.continue();
    });
    await page.goto(server.url + "/#token=" + server.token);
    await page.locator("#startLoading .peek-mark[data-state=loading]").waitFor();
    await page.locator("#startStep", { hasText: "Reading the repository structure…" }).waitFor();
    assert.equal(await page.locator("#panel").isVisible(), false, "The sheet stays out of view while Peekumi starts");
    release(); // Later comparisons pass straight through.
    await page.locator("#panel").waitFor({ state: "visible" });
    await page
      .locator('.sheet[data-front="true"] .node')
      .first()
      .waitFor({ timeout: 45000 })
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        await page.screenshot({ path: "test-results/setup-failure.png" });
        throw e;
      });
    // PR context should reuse the actual canvas. Mock the network boundary, not UI internals.
    await page.route("**/api/prs", (r) =>
      r.fulfill({
        json: [
          { number: 7, title: "Review setup", state: "OPEN", author: { login: "octo" } },
          { number: 5, title: "Earlier work", state: "MERGED" },
        ],
      }),
    );
    await page.route("**/api/prs/open", async (r) => {
      const repo = await (await page.request.get(server.url + "/api/repo")).json();
      await r.fulfill({
        json: {
          base: repo.initialHead,
          head: repo.initialHead,
          pr: {
            number: 7,
            title: "Review setup",
            state: "OPEN",
            author: { login: "octo" },
            createdAt: "2026-03-30T11:20:20Z",
            additions: 12,
            deletions: 3,
            changedFiles: 2,
            headRefName: "setup",
            baseRefName: "main",
            url: "https://github.com/example/repo/pull/7",
            body: "## Summary\n\nKeep the existing canvas and show the PR in the sheet.\n\n- One\n- Two",
            comments: [],
            reviews: [{ author: { login: "rev" }, state: "APPROVED", body: "" }],
            statusCheckRollup: [{ name: "Tests", conclusion: "SUCCESS" }],
          },
        },
      });
    });
    await page.locator("#revisionDetails > summary").click();
    await page
      .getByLabel("Repository", { exact: true })
      .waitFor({ state: "visible" });
    await page.screenshot({ path: `test-results/usability-${width}.png` });
    // A long list opens at its current entry and has a filter with a count.
    await page.locator("#headRevision + .frost-select").click();
    const menu = page.locator(".frost-menu");
    await menu.locator(".frost-filter").waitFor();
    const opened = await menu.evaluate((m) => {
      const item = m.querySelector('.frost-option[aria-selected="true"]').getBoundingClientRect(),
        box = m.getBoundingClientRect();
      return item.top >= box.top && item.bottom <= box.bottom;
    });
    assert.ok(opened, "The current entry is in view when the list opens");
    assert.match(await menu.locator(".frost-count").innerText(), /^\d+ commits$/);
    await menu.locator(".frost-filter").fill("no commit has this text");
    assert.match(await menu.locator(".frost-count").innerText(), /^0 of \d+ match$/);
    assert.equal(await menu.locator(".frost-option:visible").count(), 0);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    const id = await page
      .locator("#repositoryPicker option")
      .filter({ hasText: "second" })
      .getAttribute("value");
    // Pull requests have their own side of the Comparison panel, as rows to tap.
    await page.locator('#viewKind [data-kind="pr"]').click();
    assert.equal(await page.locator("#branchView").isVisible(), false);
    await page.locator(".pr-pick").first().waitFor();
    assert.deepEqual(
      await page.locator("#prRows .pr-group").allInnerTexts(),
      ["Open", "Recently merged"],
    );
    assert.match(await page.locator(".pr-pick").first().innerText(), /#7 Review setup[\s\S]*Open · octo/);
    await page.locator(".pr-pick", { hasText: "#7" }).click();
    await page.locator("#reviewScope .pr-head").waitFor();
    assert.match(await page.locator("#reviewScope").innerText(), /Open[\s\S]*PR #7 · setup → main[\s\S]*Review setup[\s\S]*octo/);
    assert.match(await page.locator("#revisionSummary").innerText(), /PR #7/);
    assert.match(await page.locator(".pr-card").innerText(), /Keep the existing canvas[\s\S]*All 1 passed[\s\S]*1 approved[\s\S]*Open on GitHub/);
    assert.equal(new URL(page.url()).searchParams.get("pr"), "7");
    // A reload keeps the PR: its details come back without a new fetch.
    await page.route("**/api/prs/7", (r) =>
      r.fulfill({ json: { number: 7, title: "Review setup", state: "OPEN", body: "", url: "https://github.com/example/repo/pull/7" } }),
    );
    await page.reload();
    await page.locator("#reviewScope .pr-head").waitFor();
    assert.match(await page.locator(".pr-card").innerText(), /No description\.[\s\S]*None reported/);
    // The ✕ beside the PR name goes back to the checkout's branch.
    await page.locator("#revisionSummary .rev-leave").click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("pr"));
    await page.waitForFunction(() => !document.querySelector("#reviewScope .pr-head"));
    assert.doesNotMatch(await page.locator("#revisionSummary").innerText(), /PR #7/);
    await page.locator("#revisionDetails > summary").click();
    await page.getByLabel("Repository", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#branchView").isVisible(), true);
    assert.equal(await page.locator('#viewKind [data-kind="branch"]').getAttribute("aria-pressed"), "true");
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
