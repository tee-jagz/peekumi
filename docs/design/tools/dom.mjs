/**
 * @module A small DOM for Node, so the mockup generator can run frontend/ui.js and write its
 * elements as HTML. It has only what ui.js, icons.js and peek.js use: elements, SVG elements,
 * text, attributes, the class list, `innerHTML` as raw markup, and `outerHTML`. Event
 * listeners are ignored. `install()` puts it on `globalThis.document`.
 */

const VOID = new Set(["input", "br", "hr", "img", "wbr", "meta", "link"]);
const escape = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const quote = (text) => escape(text).replace(/"/g, "&quot;");

class Text {
  constructor(text) {
    this.text = String(text);
  }
  get outerHTML() {
    return escape(this.text);
  }
}

class Element {
  constructor(tag, namespace = null) {
    this.tagName = tag;
    this.namespaceURI = namespace;
    this.attributes = new Map();
    this.children = [];
    this.raw = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes)
      this.children.push(typeof n === "string" ? new Text(n) : n);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.raw = null;
    this.append(...nodes);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...n) =>
        (this.className = [...new Set([...names(), ...n])].join(" ")),
      remove: (...n) =>
        (this.className = names()
          .filter((x) => !n.includes(x))
          .join(" ")),
      contains: (n) => names().includes(n),
      toggle: (n, force = !names().includes(n)) =>
        force ? this.classList.add(n) : this.classList.remove(n),
    };
  }
  get dataset() {
    return new Proxy(
      {},
      {
        set: (_, key, value) => {
          const name = key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
          this.setAttribute(`data-${name}`, value);
          return true;
        },
        get: (_, key) => this.getAttribute(`data-${String(key)}`),
      },
    );
  }
  get style() {
    return {
      set cssText(value) {
        this.owner.setAttribute("style", value);
      },
      owner: this,
      setProperty: (name, value) =>
        this.setAttribute(
          "style",
          `${this.getAttribute("style") ? this.getAttribute("style") + "; " : ""}${name}: ${value}`,
        ),
    };
  }
  set title(value) {
    this.setAttribute("title", value);
  }
  set textContent(value) {
    this.children = [new Text(value)];
    this.raw = null;
  }
  set innerHTML(markup) {
    this.children = [];
    this.raw = markup;
  }
  get outerHTML() {
    const attrs = [...this.attributes]
      .map(([k, v]) =>
        v === "" && !this.namespaceURI ? ` ${k}` : ` ${k}="${quote(v)}"`,
      )
      .join("");
    if (VOID.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    const inner = this.raw ?? this.children.map((c) => c.outerHTML).join("");
    return `<${this.tagName}${attrs}>${inner}</${this.tagName}>`;
  }
}

/** Installs the small DOM as `globalThis.document`. */
export function install() {
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag, namespace),
    createTextNode: (text) => new Text(text),
  };
}

/** The HTML of one node, or of a list of nodes. */
export function html(node) {
  if (node == null || node === false) return "";
  if (Array.isArray(node)) return node.map(html).join("");
  if (typeof node === "string") return escape(node);
  return node.outerHTML;
}
