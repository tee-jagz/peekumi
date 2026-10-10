import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { html, install } from "../docs/design/tools/dom.mjs";

const lint = (...args) =>
  spawnSync(process.execPath, ["scripts/lint-ui.mjs", ...args], {
    encoding: "utf8",
  });
/** The check on a copy made by copy(). */
const lintCopy = (dir, ...args) =>
  lint(
    "--root",
    join(dir, "frontend"),
    "--baseline",
    join(dir, "baseline.json"),
    ...args,
  );

/** A copy of frontend/ and of the baseline, to change for one test. */
async function copy(t) {
  const dir = await mkdtemp(join(tmpdir(), "peekumi-ui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp("frontend", join(dir, "frontend"), { recursive: true });
  await cp("scripts/ui-baseline.json", join(dir, "baseline.json"));
  return dir;
}

test("the frontend adds no UI outside the components", () => {
  const run = lint();
  assert.equal(run.status, 0, run.stderr);
});

test("new elements, markup, styles and dialogs outside ui.js fail the check", async (t) => {
  const dir = await copy(t);
  await appendFile(
    join(dir, "frontend", "agents.js"),
    '\nconst extra = document.createElement("div");\nextra.innerHTML = "<b>x</b>";\nextra.style.color = "red";\nalert("x");\n',
  );
  const run = lintCopy(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /agents\.js: \d+ elements \(U1\)/);
  assert.match(run.stderr, /agents\.js: 1 markup \(U2\)/);
  assert.match(run.stderr, /agents\.js: 1 inline styles \(U4\)/);
  assert.match(run.stderr, /agents\.js: 1 native dialogs \(U5\)/);
});

test("a call of a local helper that makes elements counts as an element", async (t) => {
  const dir = await copy(t);
  await writeFile(
    join(dir, "frontend", "extra.js"),
    'const box = (c) => {\n  const n = document.createElement("div");\n  n.className = c;\n  return n;\n};\nexport const a = () => box("x");\n',
  );
  const run = lintCopy(dir);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /extra\.js: 2 elements \(U1\), the baseline allows 0/,
  );
});

test("a call without arguments draws again and adds no element", async (t) => {
  const dir = await copy(t);
  await writeFile(
    join(dir, "frontend", "extra.js"),
    'const draw = () => {\n  document.body.append(document.createElement("div"));\n};\nexport const again = () => {\n  draw();\n  return draw();\n};\n',
  );
  const run = lintCopy(dir);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /extra\.js: 1 elements \(U1\), the baseline allows 0/,
  );
});

test("a stylesheet comment that a cut left open fails the check", async (t) => {
  const dir = await copy(t);
  await appendFile(
    join(dir, "frontend", "style.css"),
    "\n/* A note, .gone {\n  color: red;\n}\n.kept { color: blue; } */\n",
  );
  const run = lintCopy(dir);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /style\.css:\d+ \(a comment hides rules: close it\)/,
  );
});

test("new legacy CSS and page markup fail the check, and the baseline never goes up", async (t) => {
  const dir = await copy(t);
  await appendFile(
    join(dir, "frontend", "style.css"),
    "\n.new-card { padding: 3px; }\n",
  );
  const page = await readFile(join(dir, "frontend", "index.html"), "utf8");
  await writeFile(
    join(dir, "frontend", "index.html"),
    page.replace("</body>", '<div class="card">x</div></body>'),
  );
  assert.match(lintCopy(dir).stderr, /style\.css: \d+ legacy CSS rules \(U7\)/);
  assert.match(lintCopy(dir).stderr, /index\.html: \d+ page markup \(U6\)/);
  const raise = lintCopy(dir, "--update");
  assert.equal(raise.status, 1);
  assert.match(raise.stderr, /never raises a count/);
});

test("ui.css keeps the value rules", async (t) => {
  const dir = await copy(t);
  await appendFile(
    join(dir, "frontend", "ui.css"),
    "\n.pk-extra { color: #ff0000; padding: 5px; font: 600 15px/20px var(--font-ui); border-radius: 3px; background: linear-gradient(red, blue); }\n",
  );
  const run = lintCopy(dir);
  assert.equal(run.status, 1);
  for (const rule of ["R1", "R2", "R4", "R5", "R8"])
    assert.match(run.stderr, new RegExp(`${rule} `));
});

test("every rendered component has accessible names and known classes", async () => {
  install();
  const { COMPONENTS } = await import("../docs/design/tools/gallery.mjs");
  const { SCREENS } = await import("../docs/design/tools/screens.mjs");
  const { FLOWS } = await import("../docs/design/tools/flows.mjs");
  const steps = FLOWS.flatMap((f) =>
    f.steps.map((s, i) => ({ name: `${f.name} ${i + 1}`, render: s.render })),
  );
  const css = await readFile("frontend/ui.css", "utf8");
  const defined = new Set(
    css.match(/\.pk(?:-[a-z0-9-]+)?/g).map((c) => c.slice(1)),
  );
  for (const part of [...COMPONENTS, ...SCREENS, ...steps]) {
    const markup = html(part.render());
    for (const [, attrs, inner] of markup.matchAll(
      /<button\b([^>]*)>([\s\S]*?)<\/button>/g,
    )) {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      assert.ok(
        text || /aria-label="[^"]+"/.test(attrs),
        `${part.name}: a button has no accessible name`,
      );
    }
    for (const [tag] of markup.matchAll(/<(?:input|textarea)\b[^>]*>/g))
      if (!/type="checkbox"/.test(tag) || !markup.includes('class="pk-check"'))
        assert.ok(
          /aria-label=|placeholder=/.test(tag) ||
            markup.includes('class="pk-label"'),
          `${part.name}: a field has no label`,
        );
    for (const [, list] of markup.matchAll(/\bclass="([^"]*)"/g))
      for (const c of list.split(/\s+/))
        if (c.startsWith("pk"))
          assert.ok(defined.has(c), `${part.name}: .${c} is not in ui.css`);
  }
});
