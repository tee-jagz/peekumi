#!/usr/bin/env node
/**
 * @module Writes the generated design files from docs/design/tokens.json and frontend/ui.js.
 *
 * Usage: `node docs/design/tools/make.mjs [ARTIFACT_DIR]`
 *
 * Always writes `frontend/tokens.css` (the tokens as CSS custom properties) and
 * `docs/design/mockups/` (one page for each component and screen, `screens.html` and
 * `index.html`). With ARTIFACT_DIR, it also writes the component folders of the design system
 * artifact there: `bundle.css`, and a `preview.html` and a `README.md` for each preview.
 * Each mockup is rendered from the real components through the small DOM in dom.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { html, install } from "./dom.mjs";

install();
const { COMPONENTS } = await import("./gallery.mjs");
const { SCREENS } = await import("./screens.mjs");
const { FLOWS } = await import("./flows.mjs");

const here = import.meta.dirname;
const design = path.resolve(here, "..");
const frontend = path.resolve(here, "../../../frontend");
const TOKENS = JSON.parse(
  readFileSync(path.join(design, "tokens.json"), "utf8"),
);
const UI_CSS = readFileSync(path.join(frontend, "ui.css"), "utf8");
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap";

/** The gallery's own frames: boxes, the glass ground and the Peek grid. Never app styles. */
const GALLERY_CSS = `
.gallery-box { display: grid; gap: 16px; padding: 16px; background: var(--surface); }
.gallery-glass { background: var(--glass); }
.gallery-title { margin: 8px 0 0; font: 600 14px/20px var(--font-ui); color: var(--ink-muted); }
.gallery-peeks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 12px; }
.gallery-peek { display: grid; justify-items: center; gap: 4px; margin: 0; text-align: center; }
.gallery-peek .pk-peek { width: 64px; height: 64px; }
.gallery-peek figcaption { display: grid; font: 400 12px/16px var(--font-ui); color: var(--ink-muted); }
.gallery-peek figcaption code { font: 600 12px/16px var(--font-mono); color: var(--ink); }
.gallery-flow-head { display: grid; gap: 4px; max-width: 760px; }
.gallery-flow-head h2 { margin: 0; font: 600 20px/26px var(--font-ui); color: var(--ink); }
.gallery-flow-head p { margin: 0; font: 400 14px/20px var(--font-ui); color: var(--ink-muted); }
.gallery-flow-head .counts { font: 600 14px/20px var(--font-ui); color: var(--ink); }
.gallery-flow { display: flex; gap: 24px; align-items: flex-start; }
.gallery-step { display: grid; gap: 8px; width: 390px; margin: 0; }
.gallery-step figcaption { display: flex; gap: 8px; min-height: 40px; font: 400 14px/20px var(--font-ui); color: var(--ink); }
.gallery-step figcaption b { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font: 600 12px/16px var(--font-ui); }
`;

/** The tokens as CSS. `where` wraps each selector in :where() (fallbacks for the artifact);
 * `media` adds the dark theme for `prefers-color-scheme`; `prefix` goes before the class name
 * of each type style (the app uses `pk-type-`, so `.title` cannot meet an old class). */
function tokenCss({ where = false, media = false, prefix = "" } = {}) {
  const w = (sel) => (where ? `:where(${sel})` : sel);
  const themes = TOKENS.color.themes.map((t) => t.id);
  const first = themes[0];
  const value = (t, theme) =>
    typeof t.value === "string" ? t.value : (t.value[theme] ?? t.value[first]);
  const block = (theme, pad = "  ") =>
    [...TOKENS.color.tokens, ...TOKENS.shadow.tokens]
      .map((t) => `${pad}--${t.name}: ${value(t, theme)};`)
      .join("\n");
  const scheme = {
    light: "light",
    dark: "dark",
    "light-cb": "light",
    "dark-cb": "dark",
  };
  const out = [
    `${w(":root")},\n${w(`[data-theme="${first}"]`)} {\n  color-scheme: light;\n${block(first)}\n}`,
  ];
  for (const theme of themes.slice(1))
    out.push(
      `${w(`[data-theme="${theme}"]`)} {\n  color-scheme: ${scheme[theme]};\n${block(theme)}\n}`,
    );
  if (media)
    out.push(
      `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n    color-scheme: dark;\n${block("dark", "    ")}\n  }\n}`,
    );
  const rest = [];
  for (const family of [
    "spacing",
    "radius",
    "size",
    "opacity",
    "blur",
    "zIndex",
  ])
    for (const t of TOKENS[family].tokens)
      rest.push(`  --${t.name}: ${t.value};`);
  for (const [k, v] of Object.entries(TOKENS.type.families))
    rest.push(`  --font-${k}: ${v};`);
  out.push(`${w(":root")} {\n${rest.join("\n")}\n}`);
  for (const group of TOKENS.type.groups)
    for (const s of group.styles)
      out.push(
        `${w("." + prefix + s.name)} {\n  font-family: var(--font-${s.family || group.family});\n  font-size: ${s.fontSize};\n  line-height: ${s.lineHeight};\n  font-weight: ${s.fontWeight};\n}`,
      );
  return out.join("\n") + "\n";
}

writeFileSync(
  path.join(frontend, "tokens.css"),
  "/* Peekumi tokens. docs/design/tools/make.mjs makes this file from docs/design/tokens.json:\n   do not edit it by hand. */\n" +
    tokenCss({ media: true, prefix: "pk-type-" }),
);

const sized = (node, width, height) => {
  node.setAttribute("style", `width: ${width}px; height: ${height}px`);
  return node;
};

// ---------- the design system artifact ----------
const art = process.argv[2];
if (art) {
  mkdirSync(art, { recursive: true });
  writeFileSync(
    path.join(art, "bundle.css"),
    `@import url("${FONTS_URL}");\n/* Token fallbacks: :where() keeps them below the page's tokens.css. */\n` +
      tokenCss({ where: true }) +
      // The artifact loads the fonts from Google Fonts: the local font files are the app's.
      UI_CSS.replace(/@font-face \{[^}]*\}\n?/g, "") +
      GALLERY_CSS,
  );
  const write = (name, marker, body, readme) => {
    mkdirSync(path.join(art, name), { recursive: true });
    writeFileSync(path.join(art, name, "preview.html"), `${marker}\n${body}\n`);
    writeFileSync(path.join(art, name, "README.md"), readme);
  };
  for (const c of COMPONENTS)
    write(
      c.name,
      `<!-- @dsCard group="${c.group}" height=${c.height} -->`,
      html(c.render()),
      `# ${c.name}\n\n${c.readme}\n\nThe part is \`${c.name}\` in \`frontend/ui.js\` when it has its own function. The rules for it are in **Components** and **Rules**. Its styles are the \`pk-\` classes in \`components/bundle.css\`.\n`,
    );
  for (const s of SCREENS)
    write(
      s.name,
      `<!-- @dsCard group="Screens" height=${s.height} width=${s.width} page subtitle="${s.title}" -->`,
      html(sized(s.render(), s.width, s.height)),
      `# ${s.name}\n\n${s.readme}\n`,
    );
}

/** A flow as HTML: its title, the counts for today and for the proposal, and the numbered
 * screens. */
const flowHtml = (f) =>
  `<div class="gallery-flow-head"><h2>${f.title}</h2><p>${f.readme}</p><p class="counts">Today: ${f.today}</p><p class="counts">Proposed: ${f.proposed}</p></div>` +
  `<div class="gallery-flow">${f.steps
    .map(
      (s, i) =>
        `<figure class="gallery-step"><figcaption><b>${i + 1}</b><span>${s.caption}</span></figcaption>${html(sized(s.render(), 390, 844))}</figure>`,
    )
    .join("")}</div>`;
const flowWidth = (f) => f.steps.length * 390 + (f.steps.length - 1) * 24;

if (art)
  for (const f of FLOWS) {
    mkdirSync(path.join(art, f.name), { recursive: true });
    writeFileSync(
      path.join(art, f.name, "preview.html"),
      `<!-- @dsCard group="Flows" height=1060 width=${flowWidth(f)} page subtitle="${f.title}" -->\n<div style="display: grid; gap: 16px">${flowHtml(f)}</div>\n`,
    );
    writeFileSync(
      path.join(art, f.name, "README.md"),
      `# ${f.title}\n\n${f.readme}\n\n- Today: ${f.today}\n- Proposed: ${f.proposed}\n\nThe reasons and the rules are in **Flows**.\n`,
    );
  }

/** The look in its two themes: the same screens in light and in dark. */
const THEMES = [
  [
    "light",
    "Light",
    "White paper, ink lines and black main buttons. Colour only where it means something: the ochre and rust strata under folders, and the status marks.",
  ],
  [
    "dark",
    "Dark",
    "Deep teal-black, luminous mint, teal strata under folders, a rim of light on cards and a glow where the agent works.",
  ],
];
const lookScreens = () => [
  ["The map", SCREENS.find((s) => s.name === "ScreenMap").render],
  ["A task", SCREENS.find((s) => s.name === "ScreenTask").render],
  [
    "The send sheet",
    FLOWS.find((f) => f.name === "FlowChange").steps[2].render,
  ],
];
const looksHtml = () =>
  THEMES.map(
    ([id, title, text]) =>
      `<div class="gallery-flow-head"><h2>${title}</h2><p>${text}</p></div>` +
      `<div class="gallery-flow" data-theme="${id}">${lookScreens()
        .map(
          ([caption, render]) =>
            `<figure class="gallery-step"><figcaption><span>${caption}</span></figcaption>${html(sized(render(), 390, 844))}</figure>`,
        )
        .join("")}</div>`,
  ).join("");
if (art) {
  mkdirSync(path.join(art, "Looks"), { recursive: true });
  writeFileSync(
    path.join(art, "Looks", "preview.html"),
    `<!-- @dsCard group="Looks" height=2000 width=1240 page subtitle="Light and dark" -->\n<div style="display: grid; gap: 16px">${looksHtml()}</div>\n`,
  );
  writeFileSync(
    path.join(art, "Looks", "README.md"),
    "# Looks\n\nThe chosen look (Survey in light, Strata in dark) on the same screens. **Looks** gives the reasons.\n",
  );
}

// ---------- the mockup pages ----------
const out = path.join(design, "mockups");
mkdirSync(out, { recursive: true });
const THEME = `<script>const t = new URLSearchParams(location.search).get("theme"); if (t) document.documentElement.dataset.theme = t;</script>`;
const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Peekumi design</title>
<link rel="stylesheet" href="../../../frontend/tokens.css">
<link rel="stylesheet" href="../../../frontend/ui.css">
<style>body { margin: 0; padding: 24px; background: var(--canvas); display: grid; gap: 24px; justify-items: start; }${GALLERY_CSS}</style>
${THEME}
</head>
<body>
${body}
</body>
</html>
`;
const groups = new Map();
const list = (group, name) =>
  groups.set(group, [...(groups.get(group) || []), name]);
for (const c of COMPONENTS) {
  const frame = document.createElement("div");
  frame.setAttribute("style", "width: 390px");
  frame.append(c.render());
  writeFileSync(path.join(out, `${c.name}.html`), page(c.name, html(frame)));
  list(c.group, c.name);
}
const figures = [];
for (const s of SCREENS) {
  const shell = () => html(sized(s.render(), s.width, s.height));
  writeFileSync(path.join(out, `${s.name}.html`), page(s.title, shell()));
  figures.push(
    `<figure style="margin: 0; display: grid; gap: 8px"><figcaption class="pk-meta">${s.title}</figcaption>${shell()}</figure>`,
  );
  list("Screens", s.name);
}
for (const f of FLOWS) {
  writeFileSync(path.join(out, `${f.name}.html`), page(f.title, flowHtml(f)));
  list("Flows", f.name);
}
writeFileSync(
  path.join(out, "flows.html"),
  page("Flows", FLOWS.map(flowHtml).join("")),
);
writeFileSync(path.join(out, "looks.html"), page("Looks", looksHtml()));
writeFileSync(
  path.join(out, "screens.html"),
  page(
    "Screens",
    `<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">${figures.join("")}</div>`,
  ),
);
const index = [...groups]
  .map(
    ([g, names]) =>
      `<section><h2 class="pk-type-title">${g}</h2><ul>${names.map((n) => `<li><a href="${n}.html">${n}</a></li>`).join("")}</ul></section>`,
  )
  .join("");
writeFileSync(
  path.join(out, "index.html"),
  page(
    "Mockups",
    `<div class="pk gallery-box"><h1 class="pk-type-title-lg">Peekumi mockups</h1><p class="pk-note">Each page renders the real parts of <code class="pk-code">frontend/ui.js</code>. Add <code class="pk-code">?theme=dark</code>, <code class="pk-code">?theme=light-cb</code> or <code class="pk-code">?theme=dark-cb</code> to see another theme. <a href="screens.html">All screens</a>. <a href="flows.html">All flows</a>.</p>${index}</div>`,
  ),
);
console.log(
  `${COMPONENTS.length} components, ${SCREENS.length} screens, ${FLOWS.length} flows`,
);
