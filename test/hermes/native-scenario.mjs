/** @module A labelled local provider drives the real Hermes loop; measurements and hooks are real. */
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createScenario(root, artifacts) {
  const python = process.env.PEEKUMI_TEST_CRAPPER_PYTHON;
  if (!python)
    throw Error(
      "Set PEEKUMI_TEST_CRAPPER_PYTHON to the isolated test interpreter",
    );
  const fixture = spawn(
    python,
    [path.join(root, "test/hermes/native_fixture_server.py")],
    { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let errors = "";
  fixture.stderr.on("data", (chunk) => (errors += chunk));
  const lines = createInterface({ input: fixture.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    new Promise((_, reject) =>
      fixture.once("exit", () =>
        reject(Error("Fixture startup failed: " + errors)),
      ),
    ),
  ]);
  const data = JSON.parse(line);
  let phase = 0,
    nudgeSeen = false,
    release;
  const repairGate = new Promise((resolve) => (release = resolve));
  const requests = [];
  const measurements = [];
  let gateFeedback = "";
  const cart = path.join(data.repository, "shop/ui/cart.py");
  const tests = path.join(data.repository, "test_shop.py");
  const steps = [
    { calls: [{ name: "read_file", args: { path: cart } }] },
    {
      text: "I will add the refund path and measure the change.",
      calls: [
        {
          name: "write_file",
          args: {
            path: cart,
            content:
              "from shop.db.orders import save\n" + data.cart + data.refund,
          },
        },
      ],
    },
    {
      calls: [
        {
          name: "tool_call",
          args: { calls: [{ name: "peekumi_measure", arguments: {} }] },
        },
      ],
    },
    { text: "The refund path is added. The existing tests pass." },
    {
      text: "\n\nPeekumi found uncovered complexity and a UI-to-database import. I will repair both.",
      calls: [{ name: "read_file", args: { path: tests } }],
    },
    {
      calls: [
        {
          name: "write_file",
          args: { path: cart, content: data.cart + data.refund },
        },
        {
          name: "write_file",
          args: {
            path: tests,
            content:
              data.tests +
              "\n\ndef test_refunds():\n    from shop.ui.cart import refund\n    assert [refund(i) for i in range(7)] == [0, 1, 2, 3, 4, 5, 0]\n",
          },
        },
      ],
    },
    {
      calls: [
        {
          name: "tool_call",
          args: { calls: [{ name: "peekumi_measure", arguments: {} }] },
        },
      ],
    },
    {
      text: "Refunds are covered. Measured CRAP fell from 42 to 6, coverage is 100%, and the frozen rules have no new breaks. Both measurements are tied to exact source revisions.",
    },
  ];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "refund-fixture",
              object: "model",
              owned_by: "scripted-local-fixture",
            },
          ],
        }),
      );
    }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const messages = body.messages || [];
    const main = messages.some((message) =>
      JSON.stringify(message.content ?? "").includes("PEEKUMI_NATIVE_FIXTURE"),
    );
    let step = { text: "Scripted fixture" };
    if (main) {
      const index = phase++;
      if (index === 3 || index === 7) {
        const result = JSON.parse(
          messages.filter((m) => m.role === "tool").at(-1).content,
        );
        if (
          !result.measurement_accepted ||
          result.measurement.test_exit !== 0 ||
          result.measurement.export_exit !== 0
        )
          throw Error("The demo requires successful real measurements");
        measurements.push({
          status: result.status,
          snapshot: result.snapshot_sha,
          run_id: result.measurement.run_id,
          test_exit: result.measurement.test_exit,
          export_exit: result.measurement.export_exit,
        });
      }
      requests.push({
        phase: index,
        tools: (body.tools || []).map((t) => t.function?.name),
        results: messages
          .filter((m) => m.role === "tool")
          .slice(-2)
          .map((m) => String(m.content).slice(0, 2000)),
      });
      if (index === 4) {
        nudgeSeen = messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content ?? "").includes(
              "Peekumi findings:",
            ) &&
            JSON.stringify(message.content ?? "").includes("ui-no-db"),
        );
        gateFeedback =
          messages
            .filter(
              (message) =>
                message.role === "user" &&
                JSON.stringify(message.content ?? "").includes(
                  "Peekumi findings:",
                ),
            )
            .map((message) =>
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
            )
            .at(-1) || "";
        if (!nudgeSeen) {
          step = {
            text: "Fixture stopped: no actual Peekumi nudge was received.",
          };
        } else {
          await repairGate;
          step = steps[index];
        }
      } else step = steps[index] || { text: "Fixture complete." };
    }
    const calls = (step.calls || []).map((call, index) => ({
      id: `fixture_${phase}_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    const finish = calls.length ? "tool_calls" : "stop";
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, reason = null) =>
        `data: ${JSON.stringify({ id: "peekumi-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.write(chunk({ role: "assistant" }));
      if (step.text) res.write(chunk({ content: step.text }));
      if (calls.length)
        res.write(
          chunk({
            tool_calls: calls.map((call, index) => ({ index, ...call })),
          }),
        );
      res.write(chunk({}, finish));
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "peekumi-fixture",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: step.text || null,
                ...(calls.length ? { tool_calls: calls } : {}),
              },
              finish_reason: finish,
            },
          ],
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const frames = path.join(artifacts, "native-demo-frames");
  await mkdir(frames, { recursive: true });
  return {
    ...data,
    providerUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async run(page) {
      const pane = page.getByRole("region", { name: "Peekumi Risk Map" });
      const views = {};
      const screenshot = async (name, targets) => {
        const viewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          ...viewport,
          deviceScaleFactor: 3,
          mobile: false,
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        await page.waitForTimeout(250);
        const recorded = {};
        for (const [key, locator] of Object.entries(targets)) {
          const box =
            key === "testCode"
              ? await page.evaluate(() => {
                  const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                  );
                  while (walker.nextNode()) {
                    const text = walker.currentNode;
                    if (
                      !text.textContent.includes("test_refunds") ||
                      text.parentElement.closest("svg")
                    )
                      continue;
                    const range = document.createRange();
                    range.selectNodeContents(text);
                    const r = range.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                      return {
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: r.height,
                      };
                  }
                  return null;
                })
              : [
                    "score",
                    "metrics",
                    "status",
                    "findings",
                    "rule",
                    "import",
                    "source",
                    "run",
                    "reason",
                  ].includes(key)
                ? await locator.evaluate((node) => {
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    const r = range.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height };
                  })
                : await locator.boundingBox();
          if (!box || box.width <= 0 || box.height <= 0)
            throw Error("Missing visual target: " + name + "/" + key);
          if (
            name.startsWith("repair-") &&
            key === "code" &&
            box.x >= (await pane.boundingBox()).x
          )
            throw Error(
              "A diff close-up must point at the conversation, not a graph label",
            );
          recorded[key] = box;
        }
        const image = path.join(artifacts, "native-" + name + ".png");
        const captured = await cdp.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
            scale: 1,
          },
        });
        const pixels = Buffer.from(captured.data, "base64");
        if (pixels.readUInt32BE(16) < viewport.width * 3)
          throw Error("Close-ups require a high-resolution native capture");
        await writeFile(image, pixels);
        views[name] = {
          image,
          viewport,
          device_scale_factor: 3,
          targets: recorded,
        };
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          ...viewport,
          deviceScaleFactor: 1,
          mobile: false,
        });
      };
      const mapTargets = () => ({
        graph: pane
          .getByRole("img", { name: "Repository dependency map" })
          .locator(".."),
        refund: pane.getByRole("button", {
          name: "shop/ui/cart.py::refund",
          exact: true,
        }),
        uiFile: pane.getByRole("button", {
          name: "shop/ui/cart.py",
          exact: true,
        }),
        dbFile: pane.getByRole("button", {
          name: "shop/db/orders.py",
          exact: true,
        }),
        uiFolder: pane.getByText("shop/ui", { exact: true }),
        dbFolder: pane.getByText("shop/db", { exact: true }),
      });
      const hideTerminal = page
        .getByRole("button", { name: "Hide terminal", exact: true })
        .first();
      if (await hideTerminal.isVisible()) await hideTerminal.click();
      await pane.getByRole("button", { name: "Zoom out", exact: true }).click();
      const cdp = await page.context().newCDPSession(page);
      const samples = [],
        writes = [],
        events = [];
      let last = 0;
      cdp.on("Page.screencastFrame", (event) => {
        void cdp
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => {});
        const now = Date.now();
        if (now - last < 180) return;
        last = now;
        const filename = path.join(
          frames,
          `frame-${String(samples.length).padStart(5, "0")}.jpg`,
        );
        samples.push({ filename, time: now });
        writes.push(writeFile(filename, Buffer.from(event.data, "base64")));
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 85,
        everyNthFrame: 1,
      });
      try {
        const decline = page.getByText("No thanks", { exact: true });
        if (await decline.isVisible()) await decline.click();
        const hide = page.getByRole("button", {
          name: "Hide sidebar",
          exact: true,
        });
        if (await hide.isVisible()) await hide.click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Peekumi Risk Map"]')
              .getBoundingClientRect().width >= 600,
        );
        const composer = page
          .locator('[data-slot="composer-root"] [contenteditable="true"]')
          .first();
        await composer.waitFor({ timeout: 60000 });
        await composer.fill(
          "Scripted fixture: add refunds, measure risk, then repair after Peekumi's gate. PEEKUMI_NATIVE_FIXTURE",
        );
        await composer.press("Enter");
        await pane
          .getByText("findings", { exact: true })
          .waitFor({ timeout: 60000 });
        await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .click();
        const refundVisible = await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .evaluate((node) => {
            const box = node.getBoundingClientRect();
            const viewport =
              node.ownerSVGElement.parentElement.getBoundingClientRect();
            return (
              box.top >= viewport.top &&
              box.bottom <= viewport.bottom &&
              box.left >= viewport.left &&
              box.right <= viewport.right
            );
          });
        if (!refundVisible)
          throw Error(
            "The changed refund node must be fully visible in the graph",
          );
        await pane
          .getByText("CC 6 · coverage 0%", { exact: true })
          .waitFor({ timeout: 30000 });
        await screenshot("findings", {
          ...mapTargets(),
          edge: pane.getByRole("button", { name: /Rule ui-no-db at line 1/ }),
          edgePath: pane
            .getByRole("button", { name: /Rule ui-no-db at line 1/ })
            .locator("..")
            .locator("path")
            .last(),
          score: pane.getByText("42", { exact: true }).last(),
          metrics: pane.getByText("CC 6 · coverage 0%", { exact: true }),
          status: pane.getByText("findings", { exact: true }),
        });
        await page.setViewportSize({ width: 1800, height: 1000 });
        const added = page.getByText("def refund", { exact: false }).last();
        await added.scrollIntoViewIfNeeded();
        await screenshot("added", { code: added });
        const firstMeasure = page
          .getByText("Peekumi Measure", { exact: true })
          .last();
        await firstMeasure.scrollIntoViewIfNeeded();
        await screenshot("first-measure", { tool: firstMeasure });
        await page.setViewportSize({ width: 1280, height: 900 });
        events.push({ time: Date.now(), name: "findings", hold: 4 });
        await pane
          .getByRole("button", { name: /Rule ui-no-db at line 1/ })
          .click();
        await screenshot("rule", {
          ...mapTargets(),
          edge: pane.getByRole("button", { name: /Rule ui-no-db at line 1/ }),
          edgePath: pane
            .getByRole("button", { name: /Rule ui-no-db at line 1/ })
            .locator("..")
            .locator("path")
            .last(),
          rule: pane.getByText("ui-no-db", { exact: true }),
          import: pane.locator("pre").first(),
        });
        events.push({ time: Date.now(), name: "rule evidence", hold: 4 });
        await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .click();
        release();
        await pane
          .getByText("passed", { exact: true })
          .waitFor({ timeout: 60000 });
        await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .click();
        await pane
          .getByText("CC 6 · coverage 100%", { exact: true })
          .waitFor({ timeout: 30000 });
        await screenshot("passed", {
          ...mapTargets(),
          score: pane.getByText("6", { exact: true }).last(),
          metrics: pane.getByText("CC 6 · coverage 100%", { exact: true }),
          status: pane.getByText("passed", { exact: true }),
          findings: pane.getByText("0 open findings", { exact: true }),
          source: pane.getByText("Source", { exact: true }).locator(".."),
          run: pane.getByText("Run", { exact: true }).locator(".."),
        });
        await page.setViewportSize({ width: 1800, height: 1000 });
        const removed = page
          .getByText("from shop.db.orders import save", { exact: false })
          .last();
        await removed.scrollIntoViewIfNeeded();
        // The repair and its test fit in one real native view. Record them together.
        await screenshot("repair-import", {
          code: removed,
          testCode: page.locator("body"),
          secondTool: page.getByText("Peekumi Measure", { exact: true }).last(),
        });
        const repairView = views["repair-import"];
        if (repairView.targets.testCode.x >= (await pane.boundingBox()).x)
          throw Error("The added-test target must be in the conversation");
        views["repair-tests"] = {
          ...repairView,
          targets: { code: repairView.targets.testCode },
        };
        views["repair-measure"] = {
          ...repairView,
          targets: { tool: repairView.targets.secondTool },
        };
        await page.setViewportSize({ width: 1280, height: 900 });
        events.push({ time: Date.now(), name: "measured repair", hold: 5 });
        const unsupportedNode = pane.getByRole("button", {
          name: "view.ts",
          exact: true,
        });
        await unsupportedNode.scrollIntoViewIfNeeded();
        await unsupportedNode.dispatchEvent("click");
        await pane
          .getByText("CRAP not available for this language", { exact: true })
          .first()
          .waitFor();
        await screenshot("unsupported", {
          file: pane.getByRole("button", { name: "view.ts", exact: true }),
          reason: pane
            .getByText("CRAP not available for this language", { exact: true })
            .first(),
        });
        events.push({
          time: Date.now(),
          name: "unsupported language",
          hold: 3,
        });
        await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .dispatchEvent("click");
        if (!nudgeSeen)
          throw Error("The real Hermes loop did not receive the plugin nudge");
        console.log(
          "Native scripted turn passed: real write/read tools, two private measurements, actual stop-gate nudge, and passed final evidence.",
        );
      } catch (error) {
        await page.screenshot({
          path: path.join(artifacts, "native-demo-failed.png"),
        });
        await writeFile(
          path.join(artifacts, "native-demo-diagnostics.txt"),
          JSON.stringify(requests, null, 2) +
            "\n" +
            (await page.locator("body").innerText()),
        );
        throw error;
      } finally {
        release();
        await cdp.send("Page.stopScreencast");
        await Promise.all(writes);
        await writeFile(
          path.join(artifacts, "native-demo-frames.json"),
          JSON.stringify(samples),
        );
        await writeFile(
          path.join(artifacts, "native-demo-events.json"),
          JSON.stringify(events),
        );
        await writeFile(
          path.join(artifacts, "native-visuals.json"),
          JSON.stringify(
            {
              views,
              gate_feedback: gateFeedback,
              measurements,
              nudge_received: nudgeSeen,
              scripted_provider: true,
            },
            null,
            2,
          ),
        );
        await writeFile(
          path.join(artifacts, "native-demo-requests.json"),
          JSON.stringify(
            { scripted_provider: true, nudge_received: nudgeSeen, requests },
            null,
            2,
          ),
        );
      }
    },
    async close() {
      release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const exited = once(fixture, "exit");
      fixture.stdin.end("done\n");
      await exited;
      lines.close();
    },
  };
}
