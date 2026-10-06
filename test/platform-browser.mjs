/** Platform behaviour in the browser: a phone on its side keeps the header and has the
 * side-by-side layout; the map's cards start above its controls, which keep one row on a
 * small phone; a file without readable source says why in every view; the keyboard opens
 * what it selects, and Escape keeps the focus on the map; a read-only
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
  const side = await open({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });
  await side.goto(link);
  await front(side).locator(".node").first().waitFor();
  assert.ok(
    await side.locator("header.top").isVisible(),
    "The header shows in landscape",
  );
  assert.ok(await side.locator("#openTasks").isVisible());
  // It has the desktop layout: the sheet at the right of the map, and a tall map.
  const [stage, sheet] = await side.evaluate(() =>
    ["#stage", "#panel"].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { left: r.left, right: r.right, height: r.height };
    }),
  );
  assert.ok(
    sheet.left >= stage.right - 1,
    "The sheet is at the right of the map",
  );
  assert.ok(stage.height > 250, `The map has the height: ${stage.height}px`);
  await side.screenshot({ path: "test-results/platform-landscape.png" });
  await side.close();

  // The visible map is the part above its floating controls: at peek and at half height, on
  // a 390 and a 360 phone, the cards start there, and the controls keep one row.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    const phone = await open({ viewport });
    await phone.goto(link);
    await front(phone).locator(".node").first().waitFor();
    for (const height of ["peek", "half"]) {
      if (height === "half") {
        await phone.locator("#sheetHandle").click();
        await phone.waitForFunction(
          () => document.querySelector("#panel").dataset.height === "half",
        );
        await phone.waitForTimeout(500);
      }
      const shape = await phone.evaluate(() => {
        const sheet = document.querySelector('.sheet[data-front="true"]');
        const canvas = sheet
          .querySelector(".map-canvas")
          .getBoundingClientRect();
        const groups = [...sheet.querySelectorAll(".canvas-controls > *")].map(
          (g) => Math.round(g.getBoundingClientRect().top),
        );
        const top = Math.min(
          ...[...sheet.querySelectorAll(".node")].map(
            (n) => n.getBoundingClientRect().top,
          ),
        );
        return {
          canvasTop: canvas.top,
          toolsTop: Math.min(...groups),
          rows: new Set(groups).size,
          top,
        };
      });
      assert.equal(
        shape.rows,
        1,
        `${viewport.width} ${height}: the controls keep one row`,
      );
      assert.ok(
        shape.top >= shape.canvasTop && shape.top < shape.toolsTop,
        `${viewport.width} ${height}: the cards start in view, ${JSON.stringify(shape)}`,
      );
    }
    await phone.close();
  }

  // A phone that cannot reach the server: the header keeps the name on one line, and the
  // waiting text has its own row.
  const away = await open({ viewport: { width: 390, height: 844 } });
  await away.goto(link);
  await front(away).locator(".node").first().waitFor();
  await away.route("**/api/**", (r) => r.abort());
  await away.reload();
  await away.waitForTimeout(1500);
  const name = await away.locator("#repo-name").boundingBox();
  assert.ok(name.height < 32, `The name stays on one line: ${name.height}px`);
  await away.screenshot({ path: "test-results/platform-unreachable.png" });
  await away.close();

  const page = await open({ viewport: { width: 1366, height: 768 } });
  await page.goto(link);
  await front(page).locator(".node").first().waitFor();

  // The keyboard: Enter selects a card, Enter again opens it, and the focus stays on the map.
  const backend = front(page).locator('.node[data-path="backend"]');
  await backend.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.path),
    "backend",
    "The selected card keeps the focus",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    /backend/.test(document.querySelector(".crumbs")?.textContent || ""),
  );
  assert.ok(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest("#deck .node")),
    ),
    "The new level's first card has the focus",
  );
  // Escape steps back, and the focus stays on the map (it does not drop to the page).
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.ok(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest("#deck")),
    ),
    "Escape keeps the focus on the map",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.ok(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest("#deck")),
    ),
    "A second Escape keeps it too",
  );
  // The second Escape went up to the top level; open backend again.
  await backend.click();
  await backend.click();
  await page.waitForFunction(() =>
    /backend/.test(document.querySelector(".crumbs")?.textContent || ""),
  );

  // A reload opens the same place, with the same selection.
  await front(page).locator('.node[data-path="backend/lookup.py"]').click();
  await page.waitForFunction(
    () =>
      new URL(location.href).searchParams.get("item") === "backend/lookup.py",
  );
  await page.reload();
  await page.waitForFunction(() =>
    /backend/.test(document.querySelector(".crumbs")?.textContent || ""),
  );
  await front(page)
    .locator('.node.sel[data-path="backend/lookup.py"]')
    .waitFor();

  // A file whose name often holds secrets: Source says why it shows nothing, in each view.
  await page.goto(f.server.url + "/?at=file:.npmrc");
  await page.waitForFunction(() =>
    /npmrc/.test(document.querySelector(".crumbs")?.textContent || ""),
  );
  await page.locator('#helperTools [data-tab="source"]').click();
  for (const view of ["Diff", "After", "Before"]) {
    await page.locator(`[data-source-view="${view.toLowerCase()}"]`).click();
    await page.locator(".patch .empty", { hasText: "Source hidden" }).waitFor();
  }
  assert.doesNotMatch(
    await page.locator("#reviewScroll").innerText(),
    /authToken/,
  );

  // Sessions with Codex: no commands switch, because Codex never asks before commands.
  await page.evaluate(() =>
    localStorage.setItem(
      "peekumi.agents.default",
      JSON.stringify({ task: { agent: "codex" } }),
    ),
  );
  await page.reload();
  await front(page).locator(".node").first().waitFor();
  await page.locator('[data-compose="session"]').click();
  await page.getByLabel("What do you want to work on?").waitFor();
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator("#composerHost .session-mode").isVisible(),
    false,
    "No switch for Codex",
  );
  await page.close();

  // A read-only device: no owner actions in the menu, and the header says why.
  const reader = (
    await readFile(path.join(f.state, "read-only/access-token"), "utf8")
  ).trim();
  const readOnly = await open({ viewport: { width: 390, height: 844 } });
  const agentsCalls = [];
  readOnly.on(
    "request",
    (r) => r.url().includes("/api/agents") && agentsCalls.push(r.url()),
  );
  await readOnly.goto(f.server.url + "/#token=" + reader);
  await front(readOnly).locator(".node").first().waitFor();
  assert.equal(
    await readOnly.locator(".access-note").innerText(),
    "Read-only device",
  );
  await front(readOnly)
    .locator('.node[data-path="backend"]')
    .click({ button: "right" });
  const items = await readOnly
    .locator('.context-menu [role="menuitem"] span')
    .allTextContents();
  assert.ok(items.includes("Open") && items.includes("Copy path"));
  for (const owner of [
    "Ask about this",
    "Add instruction",
    "Start a session here",
  ])
    assert.ok(!items.includes(owner), `No ${owner} on a read-only device`);
  assert.deepEqual(
    agentsCalls,
    [],
    "A read-only device does not ask for the agent list",
  );
  await readOnly.close();

  // A second access link in the same tab pairs, though only the part after # changes.
  const second = await open({ viewport: { width: 390, height: 844 } });
  await second.goto(f.server.url + "/#token=wrong");
  await second.locator("#connect").waitFor();
  await second.evaluate(
    (token) => (location.hash = "token=" + token),
    f.server.token,
  );
  await front(second).locator(".node").first().waitFor();
  await second.close();

  assert.deepEqual(errors, []);
  console.log(
    "PASS platform: landscape, file labels, keyboard, reload, read-only, second link",
  );
} finally {
  await browser?.close();
  await f.close();
}
