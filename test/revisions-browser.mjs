import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startRust } from "./rust-support.mjs";
const run = promisify(execFile);
const repo = await mkdtemp(path.join(os.tmpdir(), "peekumi-revisions-"));
const git = async (...args) =>
  (await run("git", ["-C", repo, ...args])).stdout.trim();
let server, browser;
try {
  await git("init", "-b", "main");
  await git("config", "user.name", "Peekumi tests");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(repo, "README.md"), "# Root\n");
  await git("add", ".");
  await git("commit", "-m", "Root");
  const root = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "side");
  await writeFile(path.join(repo, "side.txt"), "side\n");
  await git("add", ".");
  await git("commit", "-m", "Side");
  await git("checkout", "main");
  await writeFile(path.join(repo, "README.md"), "# Main\n");
  await git("add", ".");
  await git("commit", "-m", "Main");
  const parent = await git("rev-parse", "HEAD");
  await git("merge", "--no-ff", "side", "-m", "Merge");
  const head = await git("rev-parse", "HEAD");
  // Deliberately launch with a distant base: it must not silently pin the UI.
  server = await startRust(repo, { base: root });
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const comparisons = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/compare")
      comparisons.push([
        u.searchParams.get("base"),
        u.searchParams.get("head"),
      ]);
  });
  await page.goto(server.url + "/#token=" + server.token);
  await page.locator('.sheet[data-front="true"] .pk-card').first().waitFor();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.deepEqual(
    comparisons.at(-1),
    [parent, head],
    "Merge uses its first parent, not the configured launch base",
  );
  // Four choices, named by the question. The head and base selects wait behind the last.
  await page.locator("#revisionDetails > summary").click();
  const choices = page.getByRole("radiogroup", { name: "Compare" });
  assert.deepEqual(await choices.locator(".pk-row-title").allInnerTexts(), [
    "The last commit",
    "Since my last look",
    "This branch against main",
    "Choose commits…",
  ]);
  const choice = (name) =>
    choices.getByRole("radio", { name: new RegExp(`^${name}`) });
  assert.equal(
    await choice("The last commit").getAttribute("aria-checked"),
    "true",
  );
  assert.ok(await choice("This branch against main").isDisabled(), "On main");
  assert.match(await choice("Since my last look").innerText(), /next visit/);
  assert.equal(await page.locator("#commitBar").isVisible(), false);
  await choice("Choose commits…").click();
  assert.equal(await page.locator("#base").inputValue(), "__previous__");
  await page.locator("#headRevision").selectOption(parent);
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.deepEqual(
    comparisons.at(-1),
    [root, parent],
    "Base follows a newly selected head",
  );
  await page.locator("#base").selectOption(head);
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.locator("#headRevision").selectOption(root);
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.deepEqual(
    comparisons.at(-1),
    [head, root],
    "Manual base stays pinned across head changes",
  );
  await page.locator('[data-mode="time"]').click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#revisionDetails").evaluate((el) => el.open),
    false,
    "The comparison popover closes when the owner works elsewhere",
  );
  await page.locator("#revisionDetails > summary").click();
  assert.match(await page.locator("#commitHead").innerText(), /manual base/);
  await page
    .getByRole("button", { name: "Use previous commit", exact: true })
    .click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.deepEqual(
    comparisons.at(-1),
    [root, root],
    "Root commit has no parent and compares with itself",
  );
  await page.locator("#revisionDetails > summary").click();
  await page.locator(`#timeRail .chip[data-sha="${head}"]`).click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.locator('[data-mode="diff"]').click();
  await page.locator("#revisionDetails > summary").click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#base").inputValue(), "__previous__");
  assert.match(
    await page.locator("#commitHead").innerText(),
    new RegExp(parent.slice(0, 7)),
  );
  await choice("Choose commits…").click();
  await page.locator("#base").selectOption(root);
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.locator("#refresh").click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#base").inputValue(),
    root,
    "Refresh preserves the explicit base",
  );
  await page.locator("#base").selectOption("__previous__");
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.match(
    await page.locator("#commitHead").innerText(),
    /previous commit \(automatic\)/,
  );
  // Since my last look: the device keeps the newest commit that it showed. A look at the root
  // compares the root with the newest commit. (The reload saves the newest commit as it leaves,
  // so the older look is put back before the page starts.)
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const lookKey = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("peekumi-look:")),
  );
  assert.ok(lookKey, "The page keeps the look");
  await page.addInitScript(
    ([key, sha]) =>
      localStorage.setItem(key, JSON.stringify({ sha, time: Date.now() })),
    [lookKey, root],
  );
  await page.reload();
  await page.locator('.sheet[data-front="true"] .pk-card').first().waitFor();
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.locator("#revisionDetails > summary").click();
  assert.match(
    await choice("Since my last look").innerText(),
    /2 new commits since/,
  );
  await choice("Since my last look").click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  assert.deepEqual(comparisons.at(-1), [root, head], "Since the last look");
  await page.locator("#revisionDetails > summary").click();
  assert.match(
    await page.locator("#commitHead").innerText(),
    /since your last look/,
  );
  console.log(
    "PASS revision defaults: first parent, manual override, Time/Diff, refresh, reset and root commit",
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(repo, { recursive: true, force: true });
}
