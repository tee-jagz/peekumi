import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixture, waitFor } from "./workflow-support.mjs";
import { RUST_BINARY } from "./rust-support.mjs";

// Verifies the four-part review sheet, sandboxed checks, one-tap send-failure-back,
// and CRAP (>30 risky) colouring on the map at both mobile (390x844) and desktop (1366x768).
const LCOV_RUNNER = `
import pathlib, trace
tracer = trace.Trace(count=True, trace=False)
import test_calc
tracer.runfunc(test_calc.run_tests)
counts = {}
for (filename, lineno), hits in tracer.results().counts.items():
    p = pathlib.Path(filename).resolve()
    try:
        rel = p.relative_to(pathlib.Path.cwd().resolve()).as_posix()
    except ValueError:
        continue
    if rel == "calc.py":
        counts[lineno] = hits
src_lines = pathlib.Path("calc.py").read_text().splitlines()
out = ["TN:", "SF:calc.py"]
for idx, text in enumerate(src_lines, start=1):
    s = text.strip()
    if not s or s.startswith("#") or s.startswith("def "):
        continue
    out.append(f"DA:{idx},{counts.get(idx, 0)}")
out.append("end_of_record")
pathlib.Path("coverage").mkdir(exist_ok=True)
pathlib.Path("coverage/lcov.info").write_text("\\n".join(out) + "\\n")
`;

const CALC_BASE = `def score(x, mode):
    if mode == "fast":
        return x * 2
    return x
`;

const CALC_RISKY = `def score(x, mode):
    if mode == "fast":
        return x * 2
    if mode == "complex":
        if x < 0:
            return 0
        if x > 1000 and mode != "trial":
            x = x * 3
        elif x > 500 or x == 250:
            x = x * 2
        elif x > 100:
            x = x + 10
        for step in range(3):
            if step > 1:
                x += 2
            else:
                x += 1
        if x > 9999:
            return 9999
        return x
    return x
`;

const TEST_CALC = `import calc
def run_tests():
    assert calc.score(5, "fast") == 10
`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const f = await fixture({
      files: {
        "run_cov.py": LCOV_RUNNER,
        "calc.py": CALC_BASE,
        "test_calc.py": TEST_CALC,
        "view.ts": "export const v = 1;\n",
        ".peekumi.json": JSON.stringify({
          version: 1,
          groups: {},
          rules: [],
          checks: {
            items: [
              {
                id: "py-cov",
                name: "Python coverage check",
                command: ["python3", "run_cov.py"],
                coverage: "coverage/lcov.info",
              },
              {
                id: "must-pass",
                name: "Guard check",
                command: [
                  "python3",
                  "-c",
                  "import pathlib; assert 'agent-result.txt' and pathlib.Path('ok.flag').is_file()",
                ],
              },
            ],
          },
        }),
      },
    });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      // Commit a risky Python change + TS change on main to test CRAP map colouring.
      const baseSha = f.sha;
      await writeFile(path.join(f.dir, "calc.py"), CALC_RISKY);
      await writeFile(path.join(f.dir, "view.ts"), "export const v = 2;\n");
      await f.git("add", "calc.py", "view.ts");
      await f.git("commit", "-qm", "Add complex uncovered branches");
      const headSha = (await f.git("rev-parse", "HEAD")).toString().trim();

      // Run peekumi verify on base and head to record sandboxed coverage.
      for (const sha of [baseSha, headSha]) {
        spawnSync(
          RUST_BINARY,
          [
            "verify",
            f.dir,
            "--state-dir",
            f.state,
            "--start",
            baseSha,
            "--head",
            sha,
            "--json",
          ],
          { encoding: "utf8", timeout: 60000 },
        );
      }

      // Open the file on the map and verify the risky CRAP badge and red border render.
      await page.goto(
        `${f.server.url}/?base=${baseSha}&head=${headSha}#token=${f.server.token}`,
      );
      const front = page.locator('.sheet[data-front="true"]');
      await front.locator(".pk-card").first().waitFor({ timeout: 20000 });
      // Open Root files, then open calc.py from the map.
      const rootFiles = front.locator('.pk-card[data-kind="rootfiles"]');
      if (await rootFiles.count()) {
        await rootFiles.click();
        await rootFiles.click();
      }
      const calcCard = front.locator('.pk-card[data-path="calc.py"]');
      await calcCard.waitFor({ timeout: 20000 });
      await calcCard.click();
      await calcCard.click();
      const scoreCard = front.locator(".pk-card.is-crap-risky").first();
      await scoreCard.waitFor({ timeout: 20000 });
      assert.match(await scoreCard.innerText(), /CRAP \d+\.\d/);
      await page.screenshot({
        path: `test-results/verify-crap-map-${viewport.width}.png`,
      });

      // Now run an agent task whose Guard check fails (ok.flag is missing) and inspect the four-part review sheet.
      const c = await f.req("/api/comments", {
        text: "Write the result file",
        sha: headSha,
        anchor: { kind: "repo", path: "" },
      });
      const p = await f.req("/api/runs/preview", {
        agent: "codex",
        commentIds: [c.id],
      });
      await f.req("/api/runs", { previewId: p.id });
      const doneTask = await waitFor(async () => {
        const r = await f.req("/api/runs/" + p.id);
        return r.status === "completed" && r;
      });
      const taskHead = doneTask.results.at(-1);
      await waitFor(async () => {
        const { runs } = await f.req(`/api/verify/runs?head=${taskHead}`);
        return runs.some((r) => r.runId === p.id && r.state === "failed");
      });

      // Also verify Review Inbox shows committed local branches + auto-open opt-in (off by default)
      // and universal Verify on a committed branch comparison has Run checks (no merge button).
      await f.git("checkout", "-qb", "feature/inbox-branch", headSha);
      await writeFile(path.join(f.dir, "view.ts"), "export const v = 3;\n");
      await f.git("add", "view.ts");
      await f.git("commit", "-qm", "Committed feature branch");
      await f.git("checkout", "-q", "main");

      await page.locator("#openTasks").click();
      await page.getByText("Other branches (1)").waitFor({ timeout: 20000 });
      await page.screenshot({
        path: `test-results/verify-inbox-${viewport.width}.png`,
      });
      await page.getByText("Inbox settings").click();
      const autoOpen = page.getByLabel("Auto-open inbox when items wait");
      assert.equal(await autoOpen.isChecked(), false);

      // Open the agent task and inspect the 4-part review sheet + provenance + owner acceptance check.
      await page.locator(".task-link").first().click();
      await page
        .getByRole("heading", { name: "Peekumi checks" })
        .waitFor({ timeout: 20000 });
      const sheetText = await page.locator("#panel").innerText();
      assert.match(sheetText, /Peekumi checks/);
      assert.match(sheetText, /Guard check/);
      assert.match(sheetText, /CI/);
      assert.match(sheetText, /Agent claims/);
      assert.match(sheetText, /Blind spots/);
      assert.match(sheetText, /Send failure to agent/);
      assert.match(sheetText, /Add owner acceptance check/);
      assert.ok(await page.locator(".pk-prov-chip").count());
      await page.screenshot({
        path: `test-results/verify-review-sheet-${viewport.width}.png`,
      });

      // Open the committed branch from Other branches and verify universal Verify renders (no merge).
      await page.locator(".view-back").click();
      await page.getByText("Other branches (1)").click();
      await page
        .locator(".pk-inbox-row", { hasText: "feature/inbox-branch" })
        .click();
      await page
        .getByRole("heading", { name: "Peekumi checks" })
        .waitFor({ timeout: 20000 });
      const branchSheetText = await page.locator("#panel").innerText();
      assert.match(branchSheetText, /Run checks/);
      assert.doesNotMatch(branchSheetText, /Approve and merge/);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      console.log(
        `Verify & CRAP browser ${viewport.width}: Inbox + Universal Verify + CRAP map + 4-part review sheet passed`,
      );
    } finally {
      await page.close();
      await f.close();
    }
  }
} finally {
  await browser?.close();
}
