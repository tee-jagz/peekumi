/** @module Render the production pane with real fixture responses and a public-SDK test adapter. */
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, "test-results/hermes");
const deps =
  process.env.PEEKUMI_PANE_DEPS ||
  path.join(homedir(), ".local/share/peekumi-hackathon/pane-preview");
const require = createRequire(path.join(deps, "package.json"));
const { build } = require("esbuild");
const temporary = await mkdtemp(path.join(tmpdir(), "peekumi-pane-"));
await mkdir(artifacts, { recursive: true });
let phase = "before";
let bundle;
let browser;
const errors = [];
const server = createServer(async (req, res) => {
  if (req.url === "/pane.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end(bundle);
  }
  if (req.url === "/data.json") {
    res.setHeader("content-type", "application/json");
    return res.end(await readFile(path.join(artifacts, phase + ".json")));
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset="utf-8"><title>Peekumi Risk Map pane preview</title><style>
  :root{--ui-text-primary:#e7ebf1;--ui-text-secondary:#a8b1c2;--ui-text-tertiary:#7f8a9e;--ui-stroke-secondary:#273145;--ui-bg-chrome:#121a28;--ui-accent:#77b8f5;--ui-red:#e75e78;--ui-green:#55a583;--ui-yellow:#d7b06a;color-scheme:dark}
  *{box-sizing:border-box}body{margin:0;background:#0d1420;color:var(--ui-text-primary);font-family:system-ui,-apple-system,sans-serif}.preview{height:100vh;padding:20px 24px}.caption{font-size:10px;letter-spacing:1.2px;color:var(--ui-text-tertiary);height:24px}#root{height:calc(100% - 24px);border:1px solid var(--ui-stroke-secondary);border-radius:13px;overflow:hidden}.sdk-button{border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;color:var(--ui-text-secondary);padding:4px 9px;font:inherit;font-size:11px;cursor:pointer}.empty{padding:25px;color:var(--ui-text-tertiary);text-align:center}a{color:var(--ui-accent)}
  </style><div class="preview"><div class="caption">PANE PREVIEW · SDK ADAPTER · REAL PEEKUMI FIXTURE EVIDENCE</div><div id="root"></div></div><script type="module" src="/pane.js"></script>`);
});
try {
  await writeFile(
    path.join(temporary, "sdk.js"),
    `import React from 'react';
    const atom=(value)=>({get:()=>value});
    export const host={state:{focusedStoredSessionId:atom('test'),activeSessionId:atom('test'),profile:atom('fixture')}};
    export const useValue=(value)=>value.get();
    export const Button=({children,variant,size,...props})=>React.createElement('button',{...props,className:'sdk-button',type:'button'},children);
    export const EmptyState=({title,description})=>React.createElement('div',{className:'empty'},React.createElement('strong',null,title),React.createElement('p',null,description));`,
  );
  await writeFile(
    path.join(temporary, "entry.js"),
    `import React from 'react';import{createRoot}from'react-dom/client';import{RiskPane}from${JSON.stringify(path.join(root, "integrations/hermes/desktop/plugin.js"))};const ctx={rest:()=>fetch('/data.json').then(r=>r.json())};createRoot(document.getElementById('root')).render(React.createElement(RiskPane,{ctx}));`,
  );
  const result = await build({
    entryPoints: [path.join(temporary, "entry.js")],
    bundle: true,
    write: false,
    format: "esm",
    nodePaths: [path.join(deps, "node_modules")],
    alias: { "@hermes/plugin-sdk": path.join(temporary, "sdk.js") },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  bundle = result.outputFiles[0].contents;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("findings", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
    .click();
  await page.getByText("CC 6 · coverage 0%", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "pane-findings.png") });
  await page.getByRole("button", { name: /Rule ui-no-db at line 1/ }).click();
  await page.getByText("FROZEN RULE EVIDENCE", { exact: true }).waitFor();
  await page.waitForTimeout(3500);
  if (
    !(await page.getByText("FROZEN RULE EVIDENCE", { exact: true }).isVisible())
  )
    throw Error("Automatic map refresh cleared the selected rule edge");
  await page.screenshot({ path: path.join(artifacts, "pane-rule.png") });
  await page
    .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
    .click();
  phase = "after";
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await page.getByText("passed", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
    .click();
  await page.getByText("CC 6 · coverage 100%", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "pane-passed.png") });
  await page.getByRole("button", { name: "view.ts", exact: true }).click();
  await page
    .getByText("CRAP not available for this language", { exact: true })
    .first()
    .waitFor();
  await page.screenshot({ path: path.join(artifacts, "pane-unsupported.png") });
  for (const [name, label] of [
    ["image.png", "binary · source omitted"],
    ["large.ts", "large file · source omitted"],
    ["link.ts", "symlink · not followed"],
    [".env", "restricted · source hidden"],
    ["vendor", "submodule · not expanded"],
  ]) {
    const node = page.getByRole("button", { name, exact: true });
    if (!(await node.getByText(label, { exact: true }).isVisible()))
      throw Error("Missing graph label: " + label);
    await node.click();
    await page.getByText(label, { exact: true }).last().waitFor();
  }
  await page.screenshot({
    path: path.join(artifacts, "pane-special-files.png"),
  });
  // A cold analysis may take longer than two poll intervals. Do not queue more.
  const waiting = [];
  await page.route("**/data.json", (route) => {
    waiting.push(route);
    if (waiting.length > 1) return route.continue();
  });
  await page.waitForRequest("**/data.json");
  await page.waitForTimeout(6500);
  if (waiting.length !== 1)
    throw Error(`Slow analysis queued ${waiting.length} overlapping requests`);
  for (let click = 0; click < 3; click++)
    await page.getByRole("button", { name: "Refresh evidence" }).click();
  await page.waitForTimeout(200);
  if (waiting.length !== 1)
    throw Error("Manual refresh queued overlapping requests");
  const refreshed = page.waitForResponse("**/data.json");
  await waiting[0].continue();
  await refreshed;
  await page.getByText("passed", { exact: true }).waitFor();
  await page.unroute("**/data.json");
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await page.getByText("passed", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
    .click();
  await page.screenshot({ path: path.join(artifacts, "pane-narrow.png") });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Pane causes page overflow");
  if (errors.length) throw Error(errors.join("\n"));
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(artifacts, "pane-fixture-replay.webm"));
  console.log(
    "Pane checks pass. Screenshots and labelled fixture replay: " + artifacts,
  );
} finally {
  await browser?.close();
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
