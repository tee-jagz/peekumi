/** @module Original rounded-stroke SVG icons for object types, Git status, declaration contracts and icon-only controls. */

const ring = (x, y, r) =>
  `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
// Control glyphs are decorative; the owning button supplies the accessible name.
const glyphs = {
  time: ring(10, 10, 7) + "M10 6v4l3 2",
  diff: "M3 3h9v9H3ZM8 8h9v9H8Z",
  tasks: "M3 5l2 2 3-3M10 6h7M3 13l2 2 3-3M10 14h7",
  branch:
    ring(6, 5, 2) + ring(6, 15, 2) + ring(14, 6, 2) + "M6 7v6M14 8c0 3-8 2-8 5",
  filter: "M3 4h14l-5.5 6.5V16l-3 1.5v-7Z",
  zoomIn: "M10 4v12M4 10h12",
  zoomOut: "M4 10h12",
  fit: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4",
  reset: "M4 4h12v12H4ZM8 8h4v4H8Z",
  key: "M3 4h4v4H3ZM3 12h4v4H3ZM10 6h7M10 14h7",
  before: "M2 10h1.4M8.6 10H18" + ring(6, 10, 2.6),
  after: "M2 10h9.4M16.6 10H18" + ring(14, 10, 2.6),
  ask: "M10 17a7 7 0 1 0-6.2-3.8L3 17l3.6-.9A7 7 0 0 0 10 17ZM8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M10 13.3v.1",
  comment: "M4 4h12v9h-5l-4 3v-3H4ZM7 7.5h6M7 10h4",
  send: "M10 16V4M5 9l5-5 5 5",
  pending: ring(5, 10, 0.8) + ring(10, 10, 0.8) + ring(15, 10, 0.8),
  details: ring(10, 10, 7.5) + "M10 9v5M10 6.2v.1",
  source: "M7 6l-4 4 4 4M13 6l4 4-4 4",
  changes: "M6 3v6M3 6h6M11 14h6M15 4L5 16",
  relations:
    ring(5, 5.5, 2) +
    ring(15, 5.5, 2) +
    ring(10, 15, 2) +
    "M7 5.5h6M6 7.5l3 5.6M14 7.5l-3 5.6",
  discussion: "M3 4h10v7H8l-3 3v-3H3ZM15.5 8H17v7h-1.5v2.5L12 15H9",
  session: "M3 4h14v9h-7l-4 3v-3H3ZM8 7l-2 1.5L8 10M12 7l2 1.5-2 1.5",
  stop: "M6 6h8v8H6Z",
  // Commands: a shield (ask before commands); open with a slash (all commands allowed).
  shield: "M10 2.5l6 2.2v4.6c0 4-2.6 6.9-6 8.2-3.4-1.3-6-4.2-6-8.2V4.7Z",
  // A chain link in two halves, with sparks at the break: a dependency rule break.
  broken:
    "M8.5 11.5 6.8 13.2a2.6 2.6 0 0 1-3.7-3.7l1.7-1.7M11.5 8.5l1.7-1.7a2.6 2.6 0 0 1 3.7 3.7l-1.7 1.7M7 3.5l.6 2.1M3.5 7l2.1.6M13 16.5l-.6-2.1M16.5 13l-2.1-.6",
  shieldOff:
    "M10 2.5l6 2.2v4.6c0 4-2.6 6.9-6 8.2-3.4-1.3-6-4.2-6-8.2V4.7ZM3 3l14 14",
  eye:
    "M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10Z" + ring(10, 10, 2.5),
  eyeOff:
    "M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10Z" +
    ring(10, 10, 2.5) +
    "M3.5 3.5l13 13",
  structure: "M3 3h5v4H3ZM12 13h5v4h-5ZM5.5 7v8h6.5",
  pin: "M10 18s6-5.3 6-10a6 6 0 0 0-12 0c0 4.7 6 10 6 10Z" + ring(10, 8, 2),
  check: "M4 10.5l4 4 8-9",
  close: "M5 5l10 10M15 5L5 15",
  copy: "M7 7h10v10H7ZM3 13V3h10",
  refresh: "M16 10a6 6 0 1 1-2-4.5M16 3v4h-4",
  back: "M12 4l-6 6 6 6",
  chevron: "M5 8l5 5 5-5",
  forward: "M8 4l6 6-6 6",
  add: "M10 4v12M4 10h12",
  // Agents: two sliders, for the choice of provider, model and effort.
  agents: "M3 6h7M14 6h3M3 14h3M10 14h7" + ring(12, 6, 2) + ring(8, 14, 2),
  home: "M3 9l7-6 7 6v8H3ZM8 17v-5h4v5",
  up: "M9 13L4 8l5-5M4 8h8a4 4 0 0 1 4 4v5",
  file: "M4 2h8l4 4v12H4ZM12 2v5h4",
  external:
    "M12 3h5v5M17 3l-7 7M15 12v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4",
};
const paths = {
  folder: "M2 5h6l2 2h8v10H2Z",
  file: "M4 2h8l4 4v12H4ZM12 2v5h4",
  code: "M4 2h8l4 4v12H4ZM12 2v5h4M8.5 10.5l-2 2 2 2M11.5 10.5l2 2-2 2",
  document: "M4 2h8l4 4v12H4ZM12 2v5h4M7 10h6M7 13h6M7 15.5h4",
  data: "M4 2h8l4 4v12H4ZM12 2v5h4M8.5 9.5c-1 0-1 .5-1 1.5v.5c0 .7-.4 1-1 1 .6 0 1 .3 1 1v.5c0 1 0 1.5 1 1.5M11.5 9.5c1 0 1 .5 1 1.5v.5c0 .7.4 1 1 1-.6 0-1 .3-1 1v.5c0 1 0 1.5-1 1.5",
  image:
    "M4 2h8l4 4v12H4ZM12 2v5h4M6.5 16l2.5-3 2 2 1.5-1.5 1.5 2.5" +
    ring(8, 9.5, 1),
  sealed:
    "M4 2h8l4 4v12H4ZM12 2v5h4M7 11.5h6v4.5H7ZM8.5 11.5V10a1.5 1.5 0 0 1 3 0v1.5",
  files: "M6 5h10v13H6ZM3 14V2h10",
  class: "m10 2 7 4v8l-7 4-7-4V6Zm-7 4 7 4 7-4M10 10v8",
  function: "M15 3c-4-2-5 1-6 5l-2 7c-1 3-3 3-5 2M5 8h9",
  interface: "m7 5-5 5 5 5m6-10 5 5-5 5",
  enum: "M3 4h3v3H3Zm0 9h3v3H3ZM10 5h7M10 14h7",
  symbol: "m10 2 8 8-8 8-8-8Z",

  added: "M10 4v12M4 10h12",
  changed: "M10 3l7 7-7 7-7-7Z",
  removed: "M4 10h12",
  unchanged: "M4 7h12M4 13h12",
  input: "M16 3v14M3 10h9M8 6l4 4-4 4",
  output: "M4 3v14M8 10h9M13 6l4 4-4 4",
  fields: "M3 5h2M3 10h2M3 15h2M8 5h9M8 10h9M8 15h9",
  signature: "M7 3c-3.5 3.5-3.5 10.5 0 14M13 3c3.5 3.5 3.5 10.5 0 14",
  implementation:
    "M8 3c-2 0-2 1-2 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 0 3 2 3M12 3c2 0 2 1 2 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2 0 3-2 3",
  documentation: "M4 6h12M4 10h12M4 14h7",
};
const statuses = {
  added: ["Added", "--add"],
  changed: ["Modified", "--mod"],
  removed: ["Removed", "--del"],
  unchanged: ["Unchanged", "--faint"],
};

/** Creates a detached, labelled icon with a native tooltip and decorative SVG child. */
function icon(name, label, className) {
  const host = document.createElement("span");
  host.className = className;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", label);
  host.title = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  host.append(svg);
  return host;
}

/** Returns a decorative SVG glyph for a control that carries its own accessible name (aria-label or text). Unknown names throw a RangeError. */
export function glyph(name) {
  if (!Object.hasOwn(glyphs, name))
    throw new RangeError(`Unknown control glyph: ${name}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "glyph");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", glyphs[name]);
  svg.append(path);
  return svg;
}

/** Replaces a button's content with a glyph and names it for assistive technology and tooltips. */
export function iconButton(target, name, label) {
  target.replaceChildren(glyph(name));
  target.setAttribute("aria-label", label);
  target.title = label;
  return target;
}

/** Returns a detached status SVG wrapper; unsupported statuses throw a RangeError. */
export function statusIcon(status) {
  if (!Object.hasOwn(statuses, status))
    throw new RangeError(`Unknown Git status: ${status}`);
  const [label, tone] = statuses[status];
  const host = icon(status, label, "status-icon");
  host.style.setProperty("--status-tone", `var(${tone})`);
  return host;
}

/** Returns an input (In) or output (Out) arrow, or the declared-fields icon (Fields); other values throw a RangeError. */
export function interfaceIcon(direction) {
  const kinds = {
    In: ["input", "Inputs"],
    Out: ["output", "Outputs"],
    Fields: ["fields", "Fields"],
  };
  if (!Object.hasOwn(kinds, direction))
    throw new RangeError(`Unknown contract direction: ${direction}`);
  return icon(...kinds[direction], "interface-icon");
}

const extensionKinds = {
  document: ["md", "mdx", "markdown", "rst", "txt", "adoc"],
  data: [
    ...["json", "jsonl", "toml", "yaml", "yml", "lock"],
    ...["ini", "cfg", "conf", "env", "csv", "xml"],
  ],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"],
  code: [
    ...["html", "css", "scss", "sh", "bash", "zsh", "sql", "go"],
    ...["java", "kt", "swift", "c", "h", "cpp", "rb", "php"],
  ],
};
/** Classifies a file for its icon: adapter-parsed files are source, unreadable ones are sealed, and the rest follow their extension. */
export function fileKind(file) {
  if (file.readable === false) return "sealed";
  const parsed = !/^file-level|binary|restricted|omitted/.test(file.analysis);
  if (file.analysis && parsed) return "code";
  const name = (file.path || file.name || "").split("/").at(-1).toLowerCase(),
    extension = name.includes(".") ? name.split(".").at(-1) : name;
  for (const [kind, list] of Object.entries(extensionKinds))
    if (list.includes(extension)) return kind;
  return "file";
}
const fileLabels = {
  code: "Source file",
  document: "Documentation",
  data: "Data or configuration",
  image: "Image",
  sealed: "Binary or restricted file",
  file: "File",
};
const partLabels = {
  signature: "Signature changed",
  documentation: "Documentation changed",
  implementation: "Implementation changed",
};
/** Returns an icon for one changed part of a declaration: signature, documentation or implementation. Unknown parts throw a RangeError. */
export function partIcon(part) {
  if (!Object.hasOwn(partLabels, part))
    throw new RangeError(`Unknown declaration part: ${part}`);
  return icon(part, partLabels[part], "part-icon");
}
/** Returns the icon for one file kind from fileKind(); unknown kinds use the plain file icon. */
export function fileKindIcon(kind) {
  const known = Object.hasOwn(fileLabels, kind) ? kind : "file";
  return icon(known, fileLabels[known], "object-type-icon");
}
/** Returns a neutral type icon from adapter metadata and, for files, the file kind; never from Git status. */
export function objectTypeIcon(node) {
  const isFile =
    node.kind === "file" ||
    node.kind === "boundary" ||
    (node.kind === "stub" && (node.targetKind || "file") === "file");
  if (isFile) return fileKindIcon(fileKind(node));
  const kind =
    node.kind === "symbol"
      ? node.symbolKind || "symbol"
      : node.kind === "stub"
        ? node.targetKind || "file"
        : node.kind === "boundary"
          ? "file"
          : node.kind;
  const types = {
    folder: ["folder", "Directory"],
    repo: ["folder", "Repository"],
    rootfiles: ["files", "File group"],
    file: ["file", "File / module"],
    module: ["file", "Module"],
    class: ["class", "Class"],
    struct: ["class", "Struct"],
    function: ["function", "Function"],
    method: ["function", "Method"],
    trait: ["interface", "Trait"],
    interface: ["interface", "Interface"],
    enum: ["enum", "Enum"],
  };
  const [shape, label] = Object.hasOwn(types, kind)
    ? types[kind]
    : ["symbol", kind || "Object"];
  return icon(shape, label, "object-type-icon");
}
