/** @module Record actual native Hermes interactions for the narrated motion edit. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Record one real agent turn, user selections and cursor actions in an isolated Desktop. */
export async function recordMotion(page, { artifacts, release, receipt }) {
  const folder = path.join(artifacts, "motion-capture");
  await mkdir(folder, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const pane = page.getByRole("region", { name: "Peekumi Risk Map" });
  for (const name of ["No thanks", "Hide sidebar", "Hide terminal"]) {
    const control = page.getByRole("button", { name, exact: true }).first();
    if (await control.isVisible()) await control.click();
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Peekumi Risk Map"]')
        .getBoundingClientRect().width >= 600,
  );
  await pane.getByRole("button", { name: "Zoom out", exact: true }).click();
  // Playwright's recording annotation follows real pointer actions. It does not change plugin data.
  await page.screencast.showActions({
    duration: 1200,
    position: "bottom-left",
    fontSize: 13,
    cursor: "pointer",
  });
  const frames = [],
    writes = [],
    chapters = [];
  cdp.on("Page.screencastFrame", (event) => {
    void cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {});
    const filename = path.join(
      folder,
      `frame-${String(frames.length).padStart(6, "0")}.jpg`,
    );
    frames.push({ filename, time: Date.now() });
    writes.push(writeFile(filename, Buffer.from(event.data, "base64")));
  });
  const wait = (ms) => page.waitForTimeout(ms);
  const button = (name) => pane.getByRole("button", { name, exact: true });
  const refund = () => button("shop/ui/cart.py::refund");
  const edge = () =>
    pane.getByRole("button", { name: /Rule ui-no-db at line 1/ });
  const boxOf = async (locator) =>
    locator.evaluate((node) => {
      const element = node.getBoundingClientRect();
      if (
        node.matches('[role="button"], [role="img"], button, svg') ||
        node.querySelector("svg")
      )
        return {
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        };
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      const box = r.width > 0 && r.height > 0 ? r : element;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  const targets = async (locators) => {
    const boxes = {};
    for (const [name, locator] of Object.entries(locators)) {
      const box = await boxOf(locator);
      if (!box || box.width <= 0 || box.height <= 0)
        throw Error("Missing motion target: " + name);
      boxes[name] = box;
    }
    return boxes;
  };
  const chapter = async (id, action) => {
    const start = Date.now();
    const boxes = await action();
    chapters.push({ id, start, end: Date.now(), targets: boxes || {} });
    console.log("Recorded native motion: " + id);
  };
  const point = async (locator) => {
    const box = await boxOf(locator);
    if (!box) throw Error("Missing pointer target");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 24,
    });
    await locator.hover();
  };
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: 3200,
    maxHeight: 2000,
    everyNthFrame: 1,
  });
  try {
    await chapter("add", async () => {
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
      await wait(800);
      return targets({
        chat: page.locator('[data-slot="composer-root"]').first(),
        graph: pane
          .getByRole("img", { name: "Repository dependency map" })
          .locator(".."),
      });
    });
    await chapter("intro", async () => {
      await point(button("shop/ui/cart.py"));
      await wait(1400);
      await point(refund());
      await wait(1800);
      await point(edge());
      await wait(1800);
      return targets({
        graph: pane
          .getByRole("img", { name: "Repository dependency map" })
          .locator(".."),
        refund: refund(),
      });
    });
    await chapter("risk", async () => {
      await point(refund());
      await refund().click();
      await pane.getByText("CC 6 · coverage 0%", { exact: true }).waitFor();
      await wait(1400);
      const metrics = pane.getByText("CC 6 · coverage 0%", { exact: true });
      await point(metrics);
      await wait(2800);
      const score = pane.getByText("42", { exact: true }).last();
      await point(score);
      await wait(1600);
      return targets({ refund: refund(), metrics, score });
    });
    await chapter("rule", async () => {
      await point(edge());
      await wait(1200);
      await edge().click();
      await pane.getByText("FROZEN RULE EVIDENCE", { exact: true }).waitFor();
      await wait(1500);
      const imported = pane.locator("pre").first();
      await point(imported);
      await wait(2300);
      return targets({
        edge: edge(),
        rule: pane.getByText("ui-no-db", { exact: true }),
        import: imported,
      });
    });
    await chapter("repair", async () => {
      await refund().click();
      release();
      await pane
        .getByText("passed", { exact: true })
        .waitFor({ timeout: 60000 });
      const measure = page.getByText("Peekumi Measure", { exact: true }).last();
      await measure.scrollIntoViewIfNeeded();
      await point(measure);
      await wait(1800);
      return targets({ measure });
    });
    await chapter("verify", async () => {
      await point(refund());
      await refund().click();
      const metrics = pane.getByText("CC 6 · coverage 100%", { exact: true });
      await metrics.waitFor();
      await wait(1600);
      await point(metrics);
      await wait(2300);
      const status = pane.getByText("passed", { exact: true });
      await point(status);
      await wait(1300);
      const source = pane.getByText("Source", { exact: true }).locator("..");
      await point(source);
      await wait(1600);
      return targets({
        refund: refund(),
        metrics,
        status,
        source,
        run: pane.getByText("Run", { exact: true }).locator(".."),
      });
    });
    await chapter("unknown", async () => {
      const file = button("view.ts");
      await file.scrollIntoViewIfNeeded();
      await point(file);
      await file.click();
      const reason = pane
        .getByText("CRAP not available for this language", { exact: true })
        .first();
      await reason.waitFor();
      await wait(1500);
      await point(reason);
      await wait(2000);
      return targets({ file, reason });
    });
    await chapter("close", async () => {
      await refund().click();
      await wait(1000);
      await point(pane.getByRole("img", { name: "Repository dependency map" }));
      await wait(2200);
      return targets({
        graph: pane
          .getByRole("img", { name: "Repository dependency map" })
          .locator(".."),
        refund: refund(),
      });
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
        "Motion demo requires the real gate and two successful measurements",
      );
    console.log(
      "Native motion turn passed: real tools, gate, two measurements and actual UI selections.",
    );
  } finally {
    release();
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    await writeFile(
      path.join(folder, "recording.json"),
      JSON.stringify(
        {
          viewport: { width: 1600, height: 1000 },
          frames,
          chapters,
          ...receipt(),
          cursor: "Playwright action annotation over real native interactions",
        },
        null,
        2,
      ) + "\n",
    );
  }
}
