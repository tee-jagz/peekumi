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
        await page.screenshot({
          path: path.join(artifacts, "native-findings.png"),
        });
        events.push({ time: Date.now(), name: "findings", hold: 4 });
        await pane
          .getByRole("button", { name: /Rule ui-no-db at line 1/ })
          .click();
        await page.screenshot({
          path: path.join(artifacts, "native-rule.png"),
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
        await page.screenshot({
          path: path.join(artifacts, "native-passed.png"),
        });
        events.push({ time: Date.now(), name: "measured repair", hold: 5 });
        await pane
          .getByRole("button", { name: "view.ts", exact: true })
          .click();
        await pane
          .getByText("CRAP not available for this language", { exact: true })
          .first()
          .waitFor();
        await page.screenshot({
          path: path.join(artifacts, "native-unsupported.png"),
        });
        events.push({
          time: Date.now(),
          name: "unsupported language",
          hold: 3,
        });
        await pane
          .getByRole("button", { name: "shop/ui/cart.py::refund", exact: true })
          .click();
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
