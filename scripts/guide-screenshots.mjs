#!/usr/bin/env node
/** @module Regenerates the user-guide screenshots and icon images. Starts a private,
 * temporary Strata instance on this repository (temporary state, loopback only), drives
 * each interface state in Chromium, overlays numbered markers on the elements the guide
 * describes, and writes docs/guide/*.jpg, docs/guide/icons/*.svg and the README
 * screenshots. Never writes to the inspected checkout. Requires `npm run build:rust`. */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const guide = join(root, "docs/guide");
const icons = join(guide, "icons");
const readmeShots = join(root, "docs/screenshots");
const state = await mkdtemp(join(tmpdir(), "strata-guide-"));
const port = Number(process.env.STRATA_GUIDE_PORT || 4398);

const server = spawn(
  join(root, "target/release/strata"),
  [root, "--host", "127.0.0.1", "--port", String(port), "--state-dir", state],
  { stdio: ["ignore", "pipe", "pipe"], env: withoutToken() },
);
/** A generated pairing token keeps this instance private; never reuse the owner's. */
function withoutToken() {
  const env = { ...process.env };
  delete env.STRATA_TOKEN;
  return env;
}
const url = await new Promise((done, fail) => {
  let output = "";
  const timer = setTimeout(() => fail(new Error("Strata did not start")), 60000);
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
      const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=\S+/);
      if (link) {
        clearTimeout(timer);
        done(link[0]);
      }
    });
  server.on("exit", (code) =>
    fail(new Error(`Strata exited (${code}): ${output.slice(-400)}`)),
  );
});

const browser = await chromium.launch();
const missing = [];

/** Places numbered markers on elements; returns nothing, records selectors it cannot find. */
async function mark(page, items) {
  const absent = await page.evaluate((items) => {
    document.querySelectorAll(".guide-marker").forEach((node) => node.remove());
    const lost = [];
    for (const [selector, label, corner = "tl"] of items) {
      const target = [...document.querySelectorAll(selector)].find(
        (node) => node.getClientRects().length,
      );
      if (!target) {
        lost.push(selector);
        continue;
      }
      const box = target.getBoundingClientRect(),
        marker = document.createElement("div");
      marker.className = "guide-marker";
      marker.textContent = label;
      const x = corner.includes("r") ? box.right - 14 : box.left - 8,
        y = corner.includes("b") ? box.bottom - 14 : box.top - 8;
      Object.assign(marker.style, {
        position: "fixed",
        zIndex: 99999,
        left: Math.max(2, Math.min(innerWidth - 24, x)) + "px",
        top: Math.max(2, Math.min(innerHeight - 24, y)) + "px",
        width: "22px",
        height: "22px",
        borderRadius: "11px",
        background: "#ff9f0a",
        color: "#1c1c1e",
        font: "700 12px/22px -apple-system, system-ui, sans-serif",
        textAlign: "center",
        boxShadow: "0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.45)",
        pointerEvents: "none",
      });
      document.body.append(marker);
    }
    return lost;
  }, items);
  missing.push(...absent);
}
const shot = async (page, name, items = []) => {
  await page.waitForTimeout(450);
  await mark(page, items);
  await page.screenshot({ path: join(guide, name + ".jpg"), type: "jpeg", quality: 82 });
  await mark(page, []);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector("#panel").dataset.settling);
async function height(page, key) {
  await page.locator("#sheetHandle").focus();
  await page.keyboard.press(key);
  await settle(page);
  // Keyboard focus would draw a focus ring across the sheet in the screenshot.
  await page.locator("#sheetHandle").blur();
}
async function openFile(page, path) {
  await height(page, "ArrowUp");
  await page.locator('#helperTools [data-tab="changes"]').click();
  await page.locator("#search").fill(path);
  await page.locator("#changes .row").first().click();
  await page.locator('.sheet[data-front="true"] .node[data-kind="symbol"]').first().waitFor();
  await page.waitForTimeout(400);
}
async function pick(page, key) {
  const node = page.locator(`.sheet[data-front="true"] .node[data-key="${key}"]`);
  await node.focus();
  await page.keyboard.press("Enter");
}

try {
  await mkdir(icons, { recursive: true });
  await mkdir(readmeShots, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await page.goto(url);
  const front = page.locator('.sheet[data-front="true"]');
  await front.locator(".node").first().waitFor({ timeout: 120000 });
  await page.locator("#notice").waitFor({ state: "hidden" });

  // 1. Header and map at peek.
  await shot(page, "01-map", [
    ["#repo-name", "1", "tr"],
    ["#revisionDetails > summary", "2", "tr"],
    [".icon-seg", "3"],
    ["#openTasks", "4"],
    ["#baSeg", "5", "tr"],
    ['.node[data-kind="folder"].c-changed', "6"],
    ['.node[data-kind="folder"].c-changed .n-counts', "7", "tr"],
    [".crumbs", "8"],
    [".change-filter", "9"],
    ['.map-tools button[aria-label="Zoom out"]', "10"],
    ['.map-tools button[aria-label="Zoom in"]', "11"],
    ['.map-tools button[aria-label="Fit map"]', "12"],
    ['.map-tools button[aria-label="Reset map view"]', "13"],
    ["#mapLegend > summary", "14", "tr"],
    ["#sheetHandle span", "15", "tr"],
    ["#selectionSummary", "16", "tr"],
    ["#tabs", "17"],
    ["#dockContext", "18", "tr"],
    ["#composerHost textarea", "19", "tr"],
    ["#composerHost .icon-action", "20"],
  ]);
  await page.screenshot({ path: join(readmeShots, "mobile-map.png") });

  // 2. Map key.
  await page.locator("#mapLegend > summary").click();
  await shot(page, "02-key", [
    [".legend-lens .seg", "1"],
    ["#legendContent .legend-inline", "2", "tr"],
    ["#legendContent .legend-lines", "3", "tr"],
  ]);
  await page.keyboard.press("Escape");

  // 3. Comparison popover and a frosted select menu.
  await page.locator("#revisionDetails > summary").click();
  await shot(page, "03-comparison", [
    ["#branchPicker + .frost-select", "1", "tr"],
    ["#loadPrs", "2", "tr"],
    ["#commitHead", "3", "tr"],
    ["#headRevision + .frost-select", "4", "tr"],
    ["#base + .frost-select", "5", "tr"],
    ["#refresh", "6"],
    ["#closeRevision", "7"],
  ]);
  await page.locator("#base + .frost-select").click();
  await shot(page, "04-select-menu", [[".frost-option[aria-selected=true]", "1"]]);
  await page.keyboard.press("Escape");
  await page.locator("#closeRevision").click();

  // 4. Time mode.
  await page.locator('button[data-mode="time"]').click();
  await page.locator("#notice").waitFor({ state: "hidden" });
  await shot(page, "05-time", [
    ["#timeRail .chip[aria-selected=true]", "1"],
    ["#timeRail .chip:not([aria-selected=true]):nth-last-child(2)", "2"],
  ]);
  await page.screenshot({ path: join(readmeShots, "mobile-history.png") });
  await page.locator('button[data-mode="diff"]').click();
  await page.locator("#notice").waitFor({ state: "hidden" });

  // 5. A file: declaration selected at peek, then Details, Source, Changes, Relations.
  await openFile(page, "frontend/canvas.js");
  await pick(page, "symbol:mountCanvas");
  await height(page, "Home");
  await shot(page, "06-selection-peek", [
    ['.node[data-key="symbol:mountCanvas"]', "1"],
    ["#reviewScope", "2", "tr"],
    ["#selectionSummary", "3", "tr"],
    [".contract-line", "4", "tr"],
    [".crumbs .back", "5"],
  ]);
  await height(page, "ArrowUp");
  await page.locator('#helperTools [data-tab="details"]').click();
  await shot(page, "07-details", [
    ['#helperTools [data-tab="details"]', "1"],
    ['#helperTools [data-tab="source"]', "2"],
    ['#helperTools [data-tab="changes"]', "3"],
    ['#helperTools [data-tab="dependencies"]', "4"],
    ["#showDiscussion", "5"],
    [".selection-facts", "6"],
    [".selection-facts .btn.primary", "7"],
    ["#reviewScope .x", "8"],
  ]);
  await page.locator('#helperTools [data-tab="source"]').click();
  await page.locator('[data-source-view="after"]').click();
  await shot(page, "08-source", [
    [".source-tools .seg", "1", "tr"],
    [".source-tools .read-note", "2", "tr"],
    ["#source-code", "3", "tr"],
    [".code-line.highlight", "4"],
  ]);
  await height(page, "End");
  await page.locator('#helperTools [data-tab="dependencies"]').click();
  await shot(page, "10-relations", [
    [".rule-summary", "1"],
    [".relationship-controls .frost-select", "2"],
    [".relationship-controls > .btn", "3"],
    [".relation-list .row", "4"],
    [".relationship-evidence", "5"],
    [".unresolved-relations", "6"],
  ]);

  // Changes is clearest at the repository level, where the latest commit's files appear.
  await height(page, "Home");
  await page.locator(".crumbs .crumb-home").click();
  await page.locator('.sheet[data-front="true"] .node[data-kind="folder"]').first().waitFor();
  await height(page, "End");
  await page.locator('#helperTools [data-tab="changes"]').click();
  await page.locator("#search").fill("");
  await shot(page, "09-changes", [
    [".change-overview", "1"],
    ["#search", "2", "tr"],
    ["#changes .row", "3"],
  ]);
  // 6. Comment draft and Tasks.
  await height(page, "Home");
  await page.locator("#newComment").click();
  await page.locator("#composerHost textarea").fill("Document the momentum constants.");
  await shot(page, "11-comment", [
    ["#newComment", "1"],
    ["#dockContext", "2"],
    ["#composerHost textarea", "3"],
    ['#composerHost .icon-action[aria-label="Cancel"]', "4"],
    ['#composerHost .icon-action[aria-label="Save draft"]', "5"],
  ]);
  await page.locator('#composerHost .icon-action[aria-label="Save draft"]').click();
  await page.locator("#openTasks").click();
  await page.waitForTimeout(500);
  await shot(page, "12-tasks", [
    ["#tabBody .btn.primary", "1"],
    ["#tabBody .workflow-card", "2"],
  ]);
  await page.screenshot({ path: join(readmeShots, "mobile-tasks.png") });

  // 7. Typing with the keyboard open (resizes-content shrinks the window).
  await page.locator('[data-compose="ask"]').click();
  await height(page, "Home");
  await page.locator("#composerHost textarea").focus();
  await page.setViewportSize({ width: 390, height: 470 });
  await page.waitForFunction(() =>
    document.documentElement.classList.contains("keyboard-open"),
  );
  await shot(page, "13-keyboard", [["#composerHost textarea", "1"]]);
  await page.locator("#composerHost textarea").blur();
  await page.setViewportSize({ width: 390, height: 844 });

  // 8. Desktop layout, dark.
  const desk = await browser.newPage({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await desk.goto(url);
  await desk.locator('.sheet[data-front="true"] .node').first().waitFor({ timeout: 120000 });
  await desk.locator("#notice").waitFor({ state: "hidden" });
  await shot(desk, "14-desktop", [
    ["#repo-name", "1", "tr"],
    ["#stage", "2"],
    ["#panel", "3", "tr"],
  ]);

  // Icon reference images, taken from the running interface so they always match.
  const data = await page.evaluate(async () => {
    const m = await import("/icons.js");
    const d = (node) => node.querySelector("path").getAttribute("d");
    const glyphs = [
      "time", "diff", "tasks", "branch", "before", "after", "home", "up",
      "filter", "zoomOut", "zoomIn", "fit", "reset", "key", "details", "source",
      "changes", "relations", "discussion", "ask", "comment", "send", "pin",
      "check", "close", "refresh",
    ];
    const result = glyphs.map((name) => ["glyph-" + name, d(m.glyph(name)), ""]);
    for (const status of ["added", "changed", "removed", "unchanged"])
      result.push(["status-" + status, d(m.statusIcon(status)), status]);
    for (const kind of ["code", "document", "data", "image", "sealed", "file"])
      result.push(["file-" + kind, d(m.fileKindIcon(kind)), ""]);
    const objects = [
      ["folder", { kind: "folder" }],
      ["files", { kind: "rootfiles" }],
      ["class", { kind: "symbol", symbolKind: "class" }],
      ["function", { kind: "symbol", symbolKind: "function" }],
      ["interface", { kind: "symbol", symbolKind: "interface" }],
      ["enum", { kind: "symbol", symbolKind: "enum" }],
    ];
    for (const [label, node] of objects)
      result.push(["object-" + label, d(m.objectTypeIcon(node)), ""]);
    for (const direction of ["In", "Out", "Fields"])
      result.push(["contract-" + direction.toLowerCase(), d(m.interfaceIcon(direction)), ""]);
    return result;
  });
  const tones = {
    added: "#2f9e44",
    changed: "#d9770b",
    removed: "#e5484d",
    unchanged: "#8e8e93",
  };
  for (const [name, path, status] of data)
    await writeFile(
      join(icons, name + ".svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${tones[status] || "#8e8e93"}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>\n`,
    );
  if (missing.length) throw new Error("Guide markers not found: " + missing.join(", "));
  console.log("Wrote docs/guide screenshots, icons and README screenshots.");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await rm(state, { recursive: true, force: true });
}
