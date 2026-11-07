/** @module Record clean native footage and real pointer events at narration-paced intervals. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Record the actual Hermes turn. The editor draws a cursor from the recorded input events. */
export async function recordFramework(page, { artifacts, release, receipt }) {
  const folder = path.join(artifacts, "framework-demo");
  await mkdir(folder, { recursive: true });
  const speech = JSON.parse(
    await readFile(path.join(artifacts, "benefit-demo/chapters.json"), "utf8"),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  const pane = page.getByRole("region", { name: "Peekumi Risk Map" });
  for (const name of ["No thanks", "Hide sidebar", "Hide terminal"]) {
    const button = page.getByRole("button", { name, exact: true }).first();
    if (await button.isVisible()) await button.click();
  }
  const node = (name) => pane.getByRole("button", { name, exact: true });
  const refund = () => node("shop/ui/cart.py::refund");
  const edge = () =>
    pane.getByRole("button", { name: /Rule ui-no-db at line 1/ });
  const graph = () =>
    pane.getByRole("img", { name: "Repository dependency map" }).locator("..");
  await node("Zoom out").click();
  await page.screencast.hideActions();
  const chapters = [],
    actions = [];
  let firstFrameTime = 0,
    sourceFrames = 0;
  await page.screencast.start({
    path: path.join(folder, "native.webm"),
    size: { width: 1600, height: 1000 },
    quality: 95,
    onFrame: () => {
      firstFrameTime ||= Date.now();
      sourceFrames++;
    },
  });
  const boxOf = (locator) =>
    locator.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box =
        element.matches('[role="button"],button,svg') ||
        element.querySelector("svg") ||
        !text.width
          ? bounds
          : text;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  const move = async (locator) => {
    const box = await boxOf(locator);
    if (!box.width || !box.height) throw Error("Missing native pointer target");
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    actions.push({ time: Date.now(), type: "move", x, y });
    await page.mouse.move(x, y);
  };
  const click = async (locator) => {
    await move(locator);
    const box = await boxOf(locator);
    actions.push({
      time: Date.now(),
      type: "click",
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    await locator.click();
  };
  const targets = async (locators) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(locators).map(async ([key, locator]) => [
          key,
          await boxOf(locator),
        ]),
      ),
    );
  const chapter = async (id, callback) => {
    const start = Date.now();
    const seconds = speech.clips.find((clip) => clip.id === id)?.seconds || 0;
    const at = async (time, action) => {
      await page.waitForTimeout(Math.max(0, start + time * 1000 - Date.now()));
      if (action) await action();
    };
    const boxes = await callback(at);
    await at(seconds);
    chapters.push({ id, start, end: Date.now(), targets: boxes });
    console.log("Clean native chapter: " + id);
  };
  try {
    const composer = page
      .locator('[data-slot="composer-root"] [contenteditable="true"]')
      .first();
    await composer.fill(
      "Scripted fixture: add refunds, measure risk, then repair after Peekumi's gate. PEEKUMI_NATIVE_FIXTURE",
    );
    await composer.press("Enter");
    await pane
      .getByText("findings", { exact: true })
      .waitFor({ timeout: 60000 });
    await chapter("intro", async (at) => {
      await at(1.0, () => move(node("shop/ui/cart.py")));
      await at(4.5, () => move(refund()));
      return targets({ graph: graph(), refund: refund() });
    });
    await chapter("overview", async (at) => {
      await at(0.8, () => click(node("Zoom out")));
      await at(2.7, () => move(node("shop/ui/cart.py")));
      await at(5.4, () => click(node("Zoom in")));
      return targets({ graph: graph(), file: node("shop/ui/cart.py") });
    });
    await chapter("drill", async (at) => {
      const file = node("shop/ui/cart.py");
      await at(0.7, () => click(file));
      await at(2.7, () => click(refund()));
      const metrics = pane.getByText("CC 6 · coverage 0%", { exact: true });
      await metrics.waitFor();
      const diff = page.getByText("def refund", { exact: false }).last();
      await at(5.2, () => move(diff));
      return targets({ file, refund: refund(), metrics, diff });
    });
    await chapter("rule", async (at) => {
      await at(0.5, () => move(refund()));
      await at(2.7, () => move(edge()));
      await at(4.7, () => click(edge()));
      const imported = pane.locator("pre").first();
      await imported.waitFor();
      await at(6.2, () => move(imported));
      return targets({
        graph: graph(),
        refund: refund(),
        edge: edge(),
        import: imported,
      });
    });
    await chapter("repair", async (at) => {
      await at(0.2, () => click(refund()));
      await at(0.4, () => release());
      await pane
        .getByText("passed", { exact: true })
        .waitFor({ timeout: 60000 });
      const measure = page.getByText("Peekumi Measure", { exact: true }).last();
      await measure.scrollIntoViewIfNeeded();
      await at(6.2, () => move(measure));
      return targets({ measure });
    });
    await chapter("verify", async (at) => {
      await at(0.6, () => click(refund()));
      const metrics = pane.getByText("CC 6 · coverage 100%", { exact: true });
      await metrics.waitFor();
      await at(2.1, () => move(metrics));
      const status = pane.getByText("passed", { exact: true });
      await at(6.7, () => move(status));
      return targets({ graph: graph(), refund: refund(), metrics, status });
    });
    await chapter("close", async (at) => {
      await at(0.7, () => move(graph()));
      return targets({ graph: graph(), refund: refund() });
    });
    const proof = receipt();
    if (
      !proof.nudge_received ||
      proof.measurements.length !== 2 ||
      proof.measurements.some(
        (run) => run.test_exit !== 0 || run.export_exit !== 0,
      )
    )
      throw Error(
        "The clean recording requires the real gate and two measurements",
      );
    console.log(
      "Clean native turn passed: real tools, gate, measurements and file/function selections.",
    );
  } finally {
    release();
    await page.screencast.stop();
    await writeFile(
      path.join(folder, "capture.json"),
      JSON.stringify(
        {
          firstFrameTime,
          sourceFrames,
          viewport: { width: 1600, height: 1000 },
          chapters,
          actions,
          ...receipt(),
        },
        null,
        2,
      ) + "\n",
    );
  }
}
