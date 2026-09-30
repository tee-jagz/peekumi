/** @module Original rounded-stroke SVG icons for Git status and declaration contracts. */

const paths = {
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
