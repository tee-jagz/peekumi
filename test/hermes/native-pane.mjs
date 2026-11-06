/** @module Smoke-test the plugin in a real Electron Desktop with an isolated home and no real account. */
import { _electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { createScenario } from "./native-scenario.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const source = process.env.HERMES_SOURCE;
if (!source)
  throw Error("Set HERMES_SOURCE to the pinned built Hermes checkout");
const sandbox = await mkdtemp(path.join(tmpdir(), "peekumi-native-pane-"));
const home = path.join(sandbox, "home"),
  hermesHome = path.join(home, ".hermes"),
  userData = path.join(sandbox, "user-data"),
  bin = path.join(sandbox, "bin");
const artifacts = path.join(root, "test-results/hermes");
for (const folder of [hermesHome, userData, bin, artifacts])
  await mkdir(folder, { recursive: true, mode: 0o700 });
const scenario = process.env.PEEKUMI_NATIVE_SCENARIO
  ? await createScenario(root, artifacts)
  : null;
if (scenario)
  await writeFile(
    path.join(userData, "project-dir.json"),
    JSON.stringify({ dir: scenario.repository }),
  );
await writeFile(
  path.join(bin, "gh"),
  '#!/bin/sh\necho "no fixture credentials" >&2\nexit 1\n',
  { mode: 0o755 },
);
await writeFile(
  path.join(userData, "window-state.json"),
  JSON.stringify({ x: 0, y: 0, width: 1280, height: 900, isMaximized: false }),
);
await writeFile(
  path.join(userData, "zoom-state.json"),
  JSON.stringify({ zoomLevel: 0 }),
);
await cp(
  path.join(root, "integrations/hermes"),
  path.join(hermesHome, "plugins/peekumi-risk-map"),
  { recursive: true, filter: (source) => !source.includes("__pycache__") },
);
await mkdir(path.join(hermesHome, "desktop-plugins/peekumi-risk-map"), {
  recursive: true,
});
await cp(
  path.join(root, "integrations/hermes/desktop/plugin.js"),
  path.join(hermesHome, "desktop-plugins/peekumi-risk-map/plugin.js"),
);
const settings = scenario
  ? {
      repository_id: scenario.repo,
      repository_path: scenario.repository,
      peekumi_url: scenario.url,
      coverage_command: [
        scenario.python,
        "-m",
        "coverage",
        "run",
        "-m",
        "pytest",
        "-q",
      ],
      report_command: [
        scenario.python,
        "-m",
        "coverage",
        "lcov",
        "-o",
        "lcov.info",
      ],
    }
  : {};
await writeFile(
  path.join(hermesHome, "config.yaml"),
  JSON.stringify({
    model: { default: "refund-fixture", provider: "mock" },
    providers: {
      mock: {
        api: scenario?.providerUrl || "http://127.0.0.1:9/v1",
        name: "Scripted fixture",
        api_mode: "chat_completions",
        key_env: "MOCK_API_KEY",
        models: { "refund-fixture": {} },
        context_length: 64000,
      },
    },
    terminal: { cwd: scenario?.repository || home },
    auxiliary: { title_generation: { enabled: false } },
    agent: { max_verify_nudges: 3, verify_on_stop: false },
    approvals: { mode: "off" },
    plugins: {
      enabled: ["peekumi-risk-map"],
      entries: { "peekumi-risk-map": { settings } },
    },
  }),
);
await writeFile(
  path.join(hermesHome, ".env"),
  "MOCK_API_KEY=fixture-only\nPEEKUMI_TOKEN=" +
    (scenario?.token || "fixture-only") +
    "\n",
  { mode: 0o600 },
);
const env = {};
for (const [key, value] of Object.entries(process.env))
  if (
    value &&
    !/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_PRIVATE_KEY|_BASE_URL)$/.test(
      key,
    ) &&
    !/^_?HERMES_|^PEEKUMI_/.test(key) &&
    key !== "VIRTUAL_ENV"
  )
    env[key] = value;
Object.assign(env, {
  HOME: home,
  HERMES_HOME: hermesHome,
  PATH: bin + path.delimiter + env.PATH,
  HERMES_DESKTOP_USER_DATA_DIR: userData,
  HERMES_DESKTOP_IGNORE_EXISTING: "1",
  HERMES_DESKTOP_HERMES_ROOT: source,
  HERMES_DESKTOP_PYTHON: path.join(source, ".venv/bin/python"),
  HERMES_DESKTOP_APP_NAME: "PeekumiPluginFixture",
  HERMES_DESKTOP_SKIP_QUIT_CONFIRM: "1",
  HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: "1",
  HERMES_DESKTOP_CDP_PORT: "off",
  GIT_NO_LAZY_FETCH: "1",
});
if (scenario) env.HERMES_DESKTOP_CWD = scenario.repository;
const require = createRequire(path.join(source, "package.json"));
const electron = require("electron");
let app;
try {
  app = await _electron.launch({
    executablePath: electron,
    args: [path.join(source, "apps/desktop"), "--disable-gpu", "--no-sandbox"],
    cwd: path.join(source, "apps/desktop"),
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) =>
    console.log("Renderer error: " + error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log(
        "Renderer console: " +
          message.text().replace(/(token|ticket)=[^&\s]+/g, "$1=fixture"),
      );
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      "hermes.desktop.pluginDecisions.v2",
      JSON.stringify({ "peekumi-risk-map": true }),
    ),
  );
  await page.reload();
  try {
    const right = page.getByRole("button", {
      name: "Show right sidebar",
      exact: true,
    });
    await right.waitFor({ timeout: 30000 });
    await right.click();
    const tab = page.getByText("Risk Map", { exact: true }).first();
    if (await tab.isVisible()) await tab.click();
    await page
      .getByRole("region", { name: "Peekumi Risk Map" })
      .waitFor({ timeout: 20000 });
  } catch {
    const decline = page.getByText("No thanks", { exact: true });
    if (await decline.isVisible()) await decline.click();
    console.log(
      "Controls: " +
        JSON.stringify(
          await page.getByRole("button").evaluateAll((nodes) =>
            nodes.map((node) => ({
              text: node.textContent?.trim().slice(0, 80),
              label: node.getAttribute("aria-label"),
              title: node.getAttribute("title"),
            })),
          ),
        ),
    );
    const capabilities = page.getByText("Capabilities", { exact: true });
    if (await capabilities.isVisible()) await capabilities.click();
    const plugins = page.getByRole("tab", { name: "Plugins", exact: true });
    if (await plugins.isVisible()) await plugins.click();
    await page.screenshot({
      path: path.join(artifacts, "native-desktop-startup.png"),
    });
    console.log((await page.locator("body").innerText()).slice(0, 4000));
    throw Error(
      "Native pane did not become visible; inspect the startup screenshot",
    );
  }
  await page.screenshot({
    path: path.join(artifacts, "native-desktop-pane.png"),
  });
  console.log(
    "Native Desktop loaded the pane with the real SDK. No paid model is used. Screenshot: " +
      path.join(artifacts, "native-desktop-pane.png"),
  );
  if (scenario) await scenario.run(page);
} finally {
  await app?.close();
  await new Promise((resolve) => {
    const child = spawn(
      path.join(source, ".venv/bin/python"),
      ["-m", "hermes_cli.main", "gateway", "stop"],
      { cwd: source, env, stdio: "ignore" },
    );
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  await scenario?.close();
  if (process.env.PEEKUMI_KEEP_NATIVE_FIXTURE)
    console.log("Native fixture retained at " + sandbox);
  else
    await rm(sandbox, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
}
