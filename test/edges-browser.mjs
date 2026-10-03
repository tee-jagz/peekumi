import assert from "node:assert/strict";
import { rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { startRust } from "./rust-support.mjs";

// Dependency lines never pass through a card they do not connect, and lines arriving at the
// same card land at separate points. Six files in `lib` sit in a grid where `a.mjs` (top
// left) is imported by its row neighbour and by both bottom-row files, two rows away.
const dir = await mkdtemp(join(tmpdir(), "peekumi-edges-"));
const git = (...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
await mkdir(join(dir, "lib"));
const files = {
  "a.mjs": "export function a() { return 1; }\n",
  "b.mjs": 'import { a } from "./a.mjs";\nexport const b = () => a();\n',
  "c.mjs": "export const c = 3;\n",
  "d.mjs": "export const d = 4;\n",
  "e.mjs": 'import { a } from "./a.mjs";\nexport const e = () => a();\n',
  "f.mjs": 'import { a } from "./a.mjs";\nexport const f = () => a();\n',
};
for (const [name, source] of Object.entries(files))
  await writeFile(join(dir, "lib", name), source);
git("add", ".");
git("commit", "-m", "Grid");
let server, browser;
try {
  server = await startRust(dir, { base: "HEAD", head: "HEAD" });
  browser = await chromium.launch({ headless: true });
  await mkdir("test-results", { recursive: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url + "/#token=" + server.token);
    const front = page.locator('.sheet[data-front="true"]'),
      folder = front.locator('.node[data-path="lib"]');
    await folder.waitFor();
    await folder.click();
    await folder.click();
    await front.locator('.node[data-path="lib/f.mjs"]').waitFor();
    await page.waitForTimeout(400);
    const report = await page.evaluate(() => {
      const sheet = document.querySelector('.sheet[data-front="true"]');
      const box = (el) => el.getBoundingClientRect();
      const cards = [...sheet.querySelectorAll(".node[data-key]")].map((n) => ({
        key: n.dataset.key,
        r: box(n),
      }));
      const lines = [...sheet.querySelectorAll(".edges path.e")];
      const crossings = [],
        bent = [],
        offCentre = [],
        ends = new Map();
      for (const line of lines) {
        const matrix = line.getScreenCTM(),
          length = line.getTotalLength(),
          at = (d) => {
            const p = line.getPointAtLength(d);
            return new DOMPoint(p.x, p.y).matrixTransform(matrix);
          };
        for (let i = 1; i < 40; i++) {
          const p = at((length * i) / 40);
          for (const { key, r } of cards)
            // A line never passes through a card, its own two included: it leaves one
            // edge and arrives at another.
            if (
              p.x > r.left + 3 && p.x < r.right - 3 &&
              p.y > r.top + 3 && p.y < r.bottom - 3
            )
              crossings.push(`${line.dataset.from} → ${line.dataset.to} crosses ${key}`);
        }
        // A line that leaves a card's side leaves at that card's mid height.
        const start = at(0),
          source = cards.find((c) => c.key === line.dataset.from)?.r;
        if (
          source &&
          (Math.abs(start.x - source.left) < 3 || Math.abs(start.x - source.right) < 3) &&
          Math.abs(start.y - (source.top + source.bottom) / 2) > 5
        )
          offCentre.push(`${line.dataset.from} → ${line.dataset.to}`);
        const end = at(length),
          lead = at(Math.max(0, length - 12));
        // The last stretch runs straight into the arrowhead, along its axis.
        if (Math.abs(end.x - lead.x) > 0.6 && Math.abs(end.y - lead.y) > 0.6)
          bent.push(`${line.dataset.from} → ${line.dataset.to}`);
        if (!ends.has(line.dataset.to)) ends.set(line.dataset.to, []);
        ends.get(line.dataset.to).push([end.x, end.y]);
      }
      const stacked = [];
      for (const [key, points] of ends)
        for (let i = 0; i < points.length; i++)
          for (let j = i + 1; j < points.length; j++)
            {
              // Lines merged into one trunk share an arrowhead exactly; others keep apart.
              const apart = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
              if (apart > 0.5 && apart < 6) stacked.push(key);
            }
      return { lines: lines.length, crossings: [...new Set(crossings)], stacked, bent, offCentre };
    });
    assert.ok(report.lines >= 3, "Every import of a.mjs is drawn");
    assert.deepEqual(report.crossings, [], "No line passes through an unrelated card");
    assert.deepEqual(report.stacked, [], "Arrowheads into the same card do not overlap");
    assert.deepEqual(report.bent, [], "Every line meets its arrowhead straight on");
    assert.deepEqual(report.offCentre, [], "Arrows across leave the middle of a card's side");
    await page.screenshot({ path: `test-results/edges-${viewport.width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${viewport.width}: dependency lines avoid cards and land separately`);
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
