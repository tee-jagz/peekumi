/** @module Renders the small Markdown subset that answers, instructions and agent reports use:
 * paragraphs, headings, bullet and numbered lists, fenced code, `code`, **bold** and *italic*.
 * Builds DOM nodes from text only, so repository or model output can never inject HTML.
 * Markdown links render as their text; code spans can link into the app; everything
 * unrecognised stays as plain text. */

const inline = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*)/;

/** Appends text with inline code, bold and italic to `parent`. A code span found in `links`
 * becomes a button that calls `onLink` with its target. */
function appendInline(parent, text, links, onLink) {
  // Keep link text and drop the target: a review answer never needs to navigate away.
  const plain = text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
  for (const [i, part] of plain.split(inline).entries()) {
    if (!part) continue;
    if (i % 2 === 0) {
      parent.append(document.createTextNode(part));
      continue;
    }
    const tag = part.startsWith("`")
      ? "code"
      : part.startsWith("**") || part.startsWith("__")
        ? "strong"
        : "em";
    const node = document.createElement(tag);
    const edge = tag === "em" || tag === "code" ? 1 : 2;
    node.textContent = part.slice(edge, -edge);
    const key = node.textContent.trim();
    const target =
      tag === "code" && onLink && Object.hasOwn(links, key) ? links[key] : null;
    if (target) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "code-link link-button";
      link.title = `Show ${target.symbol ? target.symbol + " in " : ""}${target.path} on the map`;
      // The place, for the context menu (menu.js).
      link.dataset.target = JSON.stringify(target);
      link.onclick = () => onLink(target);
      link.append(node);
      parent.append(link);
    } else parent.append(node);
  }
}

/** Returns a `div.md` element rendering `text`; `className` adds classes for context.
 * `links` maps a code span's exact text to a target that `onLink` receives when it is tapped. */
export function richText(
  text,
  className = "",
  { links = {}, onLink = null } = {},
) {
  const box = document.createElement("div");
  box.className = ("md " + className).trim();
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let paragraph = [],
    list = null,
    item = null;
  const flush = () => {
    if (paragraph.length) {
      const p = document.createElement("p");
      appendInline(p, paragraph.join(" "), links, onLink);
      box.append(p);
    }
    paragraph = [];
  };
  const closeList = () => {
    list = null;
    item = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      closeList();
      const fence = trimmed.slice(0, 3),
        code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence))
        code.push(lines[i]);
      const pre = document.createElement("pre"),
        inner = document.createElement("code");
      inner.textContent = code.join("\n");
      pre.append(inner);
      box.append(pre);
      continue;
    }
    if (!trimmed) {
      flush();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      closeList();
      const h = document.createElement("p");
      h.className = "md-heading";
      appendInline(h, heading[1], links, onLink);
      box.append(h);
      continue;
    }
    const bullet = trimmed.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      if (!list || (list.tagName === "OL") !== ordered) {
        list = document.createElement(ordered ? "ol" : "ul");
        box.append(list);
      }
      item = document.createElement("li");
      appendInline(item, bullet[2], links, onLink);
      list.append(item);
      continue;
    }
    if (item && /^\s+/.test(line)) {
      // An indented continuation line belongs to the list item above it.
      appendInline(item, " " + trimmed, links, onLink);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  flush();
  return box;
}
