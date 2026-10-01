/** @module Original rounded-stroke SVG icons for object types, Git status and declaration contracts. */

const paths = {
  folder: "M2 5h6l2 2h8v10H2Z",
  file: "M4 2h8l4 4v12H4ZM12 2v5h4",
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

/** Returns a detached status SVG wrapper; unsupported statuses throw a RangeError. */
export function statusIcon(status) {
  if (!Object.hasOwn(statuses, status))
    throw new RangeError(`Unknown Git status: ${status}`);
  const [label, tone] = statuses[status];
  const host = icon(status, label, "status-icon");
  host.style.setProperty("--status-tone", `var(${tone})`);
  return host;
}

/** Returns an input (In) or output (Out) arrow; other directions throw a RangeError. */
export function interfaceIcon(direction) {
  if (direction !== "In" && direction !== "Out")
    throw new RangeError(`Unknown contract direction: ${direction}`);
  return direction === "In"
    ? icon("input", "Inputs", "interface-icon")
    : icon("output", "Outputs", "interface-icon");
}

/** Returns a neutral type icon from adapter metadata, never inferred from a name or Git status. */
export function objectTypeIcon(node) {
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
