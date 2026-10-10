#!/usr/bin/env node
/**
 * @module Checks that the interface is built only from the Peekumi components (frontend/ui.js
 * and ui.css), as docs/design/15-rules.md requires.
 *
 * Outside the component modules (ui.js, peek.js and icons.js), the frontend must not make UI
 * of its own. The checks count, for each file:
 *
 * - U1 elements: `document.createElement`, `createElementNS`, and each call with arguments of
 *   a function in the same file that makes elements (the local `el(…)` helpers and the like).
 * - U2 markup: `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write`.
 * - U3 classes: `className =` and `classList.add`, `toggle` or `replace`.
 * - U4 inline styles: `.style.x =`, `style.setProperty`, `style.cssText` and a `style`
 *   attribute.
 * - U5 native dialogs: `alert()`, `confirm()` and `prompt()`. Use a Dialog.
 * - U6 page markup: in index.html, each element with a class that is not a pk- class, and each
 *   native control (button, input, select, textarea, details, summary, dialog, label, form).
 * - U7 legacy CSS: each rule in a stylesheet other than ui.css and tokens.css. A comment in
 *   any stylesheet that holds a "{" always fails: it is open, and it hides the rules after it.
 *
 * The app still has UI from before the components. scripts/ui-baseline.json records those
 * counts. A count above its baseline fails: new code must use the components. A count below
 * its baseline also fails until `node scripts/lint-ui.mjs --update` writes the lower number,
 * so that the debt only goes down. `--update` never raises a count. When the baseline file does
 * not exist, the first run writes it from the current counts.
 *
 * ui.css itself must obey the value rules R1 to R10 (colours, type sizes, weights, spacing,
 * radii, the shadow, glass, gradients, `!important` and duplicate selectors), and every pk-
 * class that ui.js uses must exist in ui.css. These have no baseline.
 *
 * Usage: `node scripts/lint-ui.mjs [--update] [--verbose] [--root DIR] [--baseline FILE]`.
 * `--root` and `--baseline` check another frontend folder and baseline (for the tests). Exits
 * with 1 when a check fails.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rootArg = process.argv.indexOf("--root");
const frontend =
  rootArg > 0
    ? path.resolve(process.argv[rootArg + 1])
    : path.join(root, "frontend");
const baselineArg = process.argv.indexOf("--baseline");
const baselinePath =
  baselineArg > 0
    ? path.resolve(process.argv[baselineArg + 1])
    : path.join(root, "scripts", "ui-baseline.json");
const COMPONENT_MODULES = new Set(["ui.js", "peek.js", "icons.js"]);
const NOT_UI = new Set(["sw.js", "model.js", "nav.js"]);
const update = process.argv.includes("--update");
const verbose = process.argv.includes("--verbose");

/** Lines of `text` that match `pattern`, with their line numbers. */
function matches(text, pattern) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(pattern))
      found.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return found;
}

/** The names of the functions in `text` that make elements: each function whose body calls
 * `document.createElement`, or calls such a function. */
function builders(text) {
  const defs = [];
  const head =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/gm;
  const starts = [...text.matchAll(head)];
  starts.forEach((m, i) =>
    defs.push({
      name: m[1] || m[2],
      body: text.slice(m.index, starts[i + 1]?.index ?? text.length),
    }),
  );
  const found = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const d of defs) {
      if (found.has(d.name)) continue;
      const calls = [...found].some((n) =>
        new RegExp(`\\b${n.replace("$", "\\$")}\\(`).test(d.body),
      );
      if (/document\.createElement(?:NS)?\(/.test(d.body) || calls) {
        found.add(d.name);
        changed = true;
      }
    }
  }
  return found;
}

/** U1: each `document.createElement` and each call of a function that makes elements. The
 * head of a definition (`const box = (c) =>`) is not a call; the rest of its line counts. A
 * call without arguments is not a new element: it draws again what its function makes. */
function elements(text) {
  const names = [...builders(text)].map((n) => n.replace("$", "\\$"));
  const call = names.length ? `|(?<![\\w.])(?:${names.join("|")})\\(` : "";
  const pattern = new RegExp(`document\\.createElement(?:NS)?\\(${call}`, "g");
  const head =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+[\w$]+\s*\(|(?:const|let)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/;
  const found = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(head, "");
    for (const m of code.matchAll(pattern)) {
      // A call without arguments (`renderPanel()`) draws again what its function makes; the
      // lines of that function count once.
      const empty =
        !m[0].startsWith("document.") &&
        code.startsWith("()", m.index + m[0].length - 1);
      if (!empty) found.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
  return found;
}

const JS_CHECKS = {
  U1: null,
  U2: /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/g,
  U3: /\.className\s*=|classList\.(?:add|toggle|replace)\(/g,
  U4: /\.style\.[a-zA-Z]+\s*=|\.style\.setProperty\(|\.style\.cssText|setAttribute\(\s*["']style["']/g,
};
const NATIVE = /(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\(/g;
const CONTROLS =
  /<(button|input|select|textarea|details|summary|dialog|label|form)\b/g;

/** The counts and the places of each check, for each file. */
function scan() {
  const counts = {};
  const places = {};
  const hard = [];
  const note = (file, code, list) => {
    if (!list.length) return;
    (counts[file] ??= {})[code] = list.length;
    (places[file] ??= {})[code] = list;
  };
  for (const entry of readdirSync(frontend, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    // Fonts and other folders hold no UI code.
    if (!entry.isFile()) continue;
    const name = entry.name;
    const file = `frontend/${name}`;
    const text = readFileSync(path.join(frontend, name), "utf8");
    if (name.endsWith(".js")) {
      if (COMPONENT_MODULES.has(name) || NOT_UI.has(name)) {
        for (const p of matches(text, NATIVE))
          hard.push(`${file}:${p} (U5 native dialog)`);
        continue;
      }
      note(file, "U5", matches(text, NATIVE));
      for (const [code, pattern] of Object.entries(JS_CHECKS))
        note(file, code, pattern ? matches(text, pattern) : elements(text));
    } else if (name === "index.html") {
      const body = text.slice(text.indexOf("<body"));
      const found = [];
      for (const m of body.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)) {
        const classes =
          /\bclass="([^"]*)"/.exec(m[2])?.[1].split(/\s+/).filter(Boolean) ||
          [];
        if (classes.some((c) => !c.startsWith("pk-") && c !== "pk"))
          found.push(m[0].slice(0, 80));
        else if (CONTROLS.test(m[0]) && !classes.length)
          found.push(m[0].slice(0, 80));
        CONTROLS.lastIndex = 0;
      }
      note(file, "U6", found);
    }
    // A comment that holds a "{" is a comment that a cut left open: it hides the rules after it.
    if (name.endsWith(".css"))
      for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g))
        if (m[0].includes("{"))
          hard.push(
            `${file}:${text.slice(0, m.index).split("\n").length} (a comment hides rules: close it)`,
          );
    if (name.endsWith(".css") && name !== "ui.css" && name !== "tokens.css") {
      note(file, "U7", matches(text.replace(/@[a-z-]+[^{]*\{/g, ""), /\{/g));
    }
  }
  return { counts, places, hard };
}

/** The value rules R1 to R10 for ui.css, and the pk- classes of ui.js. */
function checkComponents() {
  const css = readFileSync(path.join(frontend, "ui.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const errors = [];
  const SPACE =
    /^(?:0|-?1px|-?2px|auto|var\(--space-\d\)|calc\(.*var\(--[a-z0-9-]+\).*\)|-?var\(--space-\d\))$/;
  // Each rule: the at-rule context, the selector and its declarations.
  const seen = new Map();
  const stack = [];
  let selector = "";
  let buffer = "";
  for (const ch of css) {
    if (ch === "{") {
      const head = buffer.trim();
      buffer = "";
      if (head.startsWith("@")) stack.push(head);
      else {
        selector = head;
        stack.push(null);
      }
    } else if (ch === "}") {
      const top = stack.pop();
      if (top === null) {
        const context = stack.filter(Boolean).join(" ");
        const inKeyframes = context.includes("@keyframes");
        const key = `${context}|${selector}`;
        if (!inKeyframes && seen.has(key))
          errors.push(`R10 ${selector}: declared twice`);
        seen.set(key, true);
        for (const decl of buffer.split(";")) {
          const [prop, ...rest] = decl.split(":");
          if (!rest.length) continue;
          const p = prop.trim();
          const v = rest.join(":").trim();
          const where = `${selector} { ${p}: ${v} }`;
          const bare = v.replace(/var\([^)]*\)/g, "");
          if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(bare))
            errors.push(`R1 colour: ${where}`);
          if (
            /\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple)\b/.test(
              bare,
            ) &&
            /color|background|fill|stroke|border/.test(p)
          )
            errors.push(`R1 named colour: ${where}`);
          if (p === "font" || p === "font-size") {
            const size = /(\d+)px/.exec(v)?.[1];
            if (
              size &&
              !["12", "13", "14", "16", "18", "20", "22", "24"].includes(size)
            )
              errors.push(`R2 font size: ${where}`);
          }
          if (p === "font" || p === "font-weight") {
            const weight = /^(\d{3})\b/.exec(v)?.[1];
            if (weight && !["400", "600"].includes(weight))
              errors.push(`R3 font weight: ${where}`);
          }
          if (
            /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?$/.test(p) &&
            !inKeyframes
          )
            for (const part of v.split(/\s+(?![^(]*\))/))
              if (!SPACE.test(part)) errors.push(`R4 spacing: ${where}`);
          if (/^border(?:-[a-z]+)*-radius$/.test(p))
            for (const part of v.split(/\s+/))
              if (!/^(?:0|var\(--radius-[a-z]+\))$/.test(part))
                errors.push(`R5 radius: ${where}`);
          if (
            p === "box-shadow" &&
            !/^(?:none|var\(--shadow-[a-z]+\))$/.test(v)
          )
            errors.push(`R6 shadow: ${where}`);
          if (
            /backdrop-filter$/.test(p) &&
            !/\.pk-(?:sheet|composer|map|map-controls)\b/.test(selector)
          )
            errors.push(`R7 glass: ${where}`);
          if (/gradient\(/.test(v)) errors.push(`R8 gradient: ${where}`);
          if (
            /!important/.test(v) &&
            !context.includes("prefers-reduced-motion") &&
            !selector.includes("[hidden]")
          )
            errors.push(`R9 !important: ${where}`);
        }
      }
      buffer = "";
    } else buffer += ch;
  }
  const defined = new Set(
    css.match(/\.pk(?:-[a-z0-9-]+)?/g).map((c) => c.slice(1)),
  );
  const js = readFileSync(path.join(frontend, "ui.js"), "utf8");
  for (const literal of js.match(/["'`][^"'`]*["'`]/g) || [])
    for (const c of literal.match(/(?<![-\w#])pk(?:-[a-z0-9-]+)?\b/g) || [])
      if (!defined.has(c) && !c.endsWith("-"))
        errors.push(`ui.js uses .${c}, which ui.css does not define`);
  return [...new Set(errors)];
}

const { counts, places, hard } = scan();
const first = !existsSync(baselinePath);
const baseline = first ? {} : JSON.parse(readFileSync(baselinePath, "utf8"));
const over = [];
const under = [];
for (const file of new Set([...Object.keys(counts), ...Object.keys(baseline)]))
  for (const code of new Set([
    ...Object.keys(counts[file] || {}),
    ...Object.keys(baseline[file] || {}),
  ])) {
    const now = counts[file]?.[code] || 0;
    const was = baseline[file]?.[code] || 0;
    if (now > was) over.push({ file, code, now, was });
    else if (now < was) under.push({ file, code, now, was });
  }

const NAMES = {
  U1: "elements",
  U2: "markup",
  U3: "classes",
  U4: "inline styles",
  U5: "native dialogs",
  U6: "page markup",
  U7: "legacy CSS rules",
};
const errors = [...hard, ...checkComponents()];
for (const o of first ? [] : over) {
  errors.push(
    `${o.file}: ${o.now} ${NAMES[o.code]} (${o.code}), the baseline allows ${o.was}. Use the parts in frontend/ui.js.`,
  );
  if (verbose) for (const p of places[o.file][o.code]) errors.push(`    ${p}`);
}

if (update || first) {
  if (over.length && !first) {
    console.error(
      "lint-ui: --update never raises a count. Remove the new UI first:",
    );
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const next = {};
  for (const file of Object.keys(counts).sort()) next[file] = counts[file];
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  const total = Object.values(next).reduce(
    (n, c) => n + Object.values(c).reduce((a, b) => a + b, 0),
    0,
  );
  console.log(
    `lint-ui: baseline written, ${total} places of UI outside the components.`,
  );
  for (const e of errors) console.error(e);
  process.exit(errors.length ? 1 : 0);
}
for (const u of under)
  errors.push(
    `${u.file}: ${NAMES[u.code]} (${u.code}) went down from ${u.was} to ${u.now}. Run node scripts/lint-ui.mjs --update to lock it in.`,
  );
if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(
    `lint-ui: ${errors.length} problems. See docs/design/15-rules.md.`,
  );
  process.exit(1);
}
const total = Object.values(counts).reduce(
  (n, c) => n + Object.values(c).reduce((a, b) => a + b, 0),
  0,
);
console.log(
  `lint-ui: no new UI outside the components (${total} places of old UI left).`,
);
