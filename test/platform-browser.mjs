/** Platform behaviour in the browser: a phone on its side keeps the header; a file without
 * readable source says why in every view; the keyboard opens what it selects; a read-only
 * device sees no owner actions; a reload and a second access link keep the owner's place;
 * the commands switch shows only for an agent that asks before commands. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixture } from "./workflow-support.mjs";
let browser;
const f = await fixture({
  files: {
    "backend/lookup.py": "def route():\n    return 1\n",
    "backend/graph.py": "def fold():\n    return 3\n",
    ".npmrc": "//registry.npmjs.org/:_authToken=not-a-real-token\n",
  },
});
try {
  browser = await chromium.launch({ headless: true });
  const link = f.server.url + "/#token=" + f.server.token;
  const front = (page) => page.locator('.sheet[data-front="true"]');
  const errors = [];
  const open = async (options) => {
    const page = await browser.newPage(options);
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  };

  // A phone on its side: the header stays, with Time, Diff and Tasks.
  const side = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  await side.goto(link);
  await front(side).locator(".node").first().waitFor();
  assert.ok(await side.locator("header.top").isVisible(), "The header shows in landscape");
  assert.ok(await side.locator("#openTasks").isVisible());
  await side.screenshot({ path: "test-results/platform-landscape.png" });
  await side.close();

  const page = await open({ viewport: { width: 1366, height: 768 } });
  await page.goto(link);
  await front(page).locator(".node").first().waitFor();

  // The keyboard: Enter selects a card, Enter again opens it, and the focus stays on the map.
  const backend = front(page).locator('.node[data-path="backend"]');
  await backend.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), "backend", "The selected card keeps the focus");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /backend/.test(document.querySelector(".crumbs")?.textContent || ""));
  assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest("#deck .node"))), "The new level's first card has the focus");

  // A reload opens the same place, with the same selection.
  await front(page).locator('.node[data-path="backend/lookup.py"]').click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("item") === "backend/lookup.py");
  await page.reload();
  await page.waitForFunction(() => /backend/.test(document.querySelector(".crumbs")?.textContent || ""));
  await front(page).locator('.node.sel[data-path="backend/lookup.py"]').waitFor();

  // A file whose name often holds secrets: Source says why it shows nothing, in each view.
  await page.goto(f.server.url + "/?at=file:.npmrc");
  await page.waitForFunction(() => /npmrc/.test(document.querySelector(".crumbs")?.textContent || ""));
  await page.locator('#helperTools [data-tab="source"]').click();
  for (const view of ["Diff", "After", "Before"]) {
    await page.locator(`[data-source-view="${view.toLowerCase()}"]`).click();
    await page.locator(".patch .empty", { hasText: "Source hidden" }).waitFor();
  }
  assert.doesNotMatch(await page.locator("#reviewScroll").innerText(), /authToken/);

  // Sessions with Codex: no commands switch, because Codex never asks before commands.
  await page.evaluate(() => localStorage.setItem("peekumi.agents.default", JSON.stringify({ task: { agent: "codex" } })));
  await page.reload();
  await front(page).locator(".node").first().waitFor();
  await page.locator('[data-compose="session"]').click();
  await page.getByLabel("What do you want to work on?").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#composerHost .session-mode").isVisible(), false, "No switch for Codex");
  await page.close();

  // A read-only device: no owner actions in the menu, and the header says why.
  const reader = (await readFile(path.join(f.state, "read-only/access-token"), "utf8")).trim();
  const readOnly = await open({ viewport: { width: 390, height: 844 } });
  const agentsCalls = [];
  readOnly.on("request", (r) => r.url().includes("/api/agents") && agentsCalls.push(r.url()));
  await readOnly.goto(f.server.url + "/#token=" + reader);
  await front(readOnly).locator(".node").first().waitFor();
  assert.equal(await readOnly.locator(".access-note").innerText(), "Read-only device");
  await front(readOnly).locator('.node[data-path="backend"]').click({ button: "right" });
  const items = await readOnly.locator('.context-menu [role="menuitem"] span').allTextContents();
  assert.ok(items.includes("Open") && items.includes("Copy path"));
  for (const owner of ["Ask about this", "Add instruction", "Start a session here"])
    assert.ok(!items.includes(owner), `No ${owner} on a read-only device`);
  assert.deepEqual(agentsCalls, [], "A read-only device does not ask for the agent list");
  await readOnly.close();

  // A second access link in the same tab pairs, though only the part after # changes.
  const second = await open({ viewport: { width: 390, height: 844 } });
  await second.goto(f.server.url + "/#token=wrong");
  await second.locator("#connect").waitFor();
  await second.evaluate((token) => (location.hash = "token=" + token), f.server.token);
  await front(second).locator(".node").first().waitFor();
  await second.close();

  assert.deepEqual(errors, []);
  console.log("PASS platform: landscape, file labels, keyboard, reload, read-only, second link");
} finally {
  await browser?.close();
  await f.close();
}
