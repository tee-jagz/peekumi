/** @module Frosted menus that replace native select popups while keeping each select as the value and change-event source. */
import { glyph } from "./icons.js";

const valueProperty = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  "value",
);
const indexProperty = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  "selectedIndex",
);
let current = null,
  menuId = 0;

/** Closes the open menu, optionally returning focus to its trigger. */
function close(focus = false) {
  if (!current) return;
  const { menu, trigger } = current;
  current = null;
  menu.remove();
  trigger.setAttribute("aria-expanded", "false");
  if (focus) trigger.focus({ preventScroll: true });
}

/** Commits an option through the native select so existing change handlers run unchanged. */
function choose(select, option) {
  close(true);
  if (option.disabled || option.value === select.value) return;
  select.value = option.value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Opens a listbox beside the trigger, above it when there is more room there. */
function show(select, trigger) {
  close();
  const id = "frost-menu-" + ++menuId,
    menu = document.createElement("div"),
    items = [];
  menu.id = id;
  menu.className = "frost-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute(
    "aria-label",
    select.getAttribute("aria-label") || "Options",
  );
  menu.tabIndex = -1;
  for (const option of select.options) {
    const item = document.createElement("div");
    item.id = `${id}-${items.length}`;
    item.className = "frost-option";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.selected));
    if (option.disabled) item.setAttribute("aria-disabled", "true");
    item.append(document.createTextNode(option.textContent.trim()));
    if (option.selected) item.append(glyph("check"));
    item.onclick = () => choose(select, option);
    items.push(item);
    menu.append(item);
  }
  let active = Math.max(0, select.selectedIndex);
  const activate = (index) => {
    items[active]?.removeAttribute("data-active");
    active = Math.max(0, Math.min(items.length - 1, index));
    items[active]?.setAttribute("data-active", "true");
    menu.setAttribute("aria-activedescendant", items[active]?.id || "");
    items[active]?.scrollIntoView({ block: "nearest" });
  };
  menu.onkeydown = (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) activate(active + step);
    else if (event.key === "Home") activate(0);
    else if (event.key === "End") activate(items.length - 1);
    else if (event.key === "Enter" || event.key === " ")
      choose(select, select.options[active]);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.body.append(menu);
  // Fixed to the viewport: the app shell is transformed for the phone keyboard.
  const rect = trigger.getBoundingClientRect(),
    margin = 8,
    below = innerHeight - rect.bottom - margin,
    above = rect.top - margin,
    natural = Math.min(menu.scrollHeight, innerHeight * 0.6),
    downward = below >= natural || below >= above;
  menu.style.minWidth = Math.max(rect.width, 200) + "px";
  menu.style.maxHeight =
    Math.min(downward ? below : above, innerHeight * 0.6) + "px";
  const left = Math.min(rect.left, innerWidth - menu.offsetWidth - margin);
  menu.style.left = Math.max(margin, left) + "px";
  menu.style.top =
    (downward ? rect.bottom + 6 : rect.top - 6 - menu.offsetHeight) + "px";
  current = { menu, trigger, select };
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", id);
  activate(active);
  menu.focus({ preventScroll: true });
}

/** Hides one native select behind a frosted trigger. The select stays in the DOM for value, events and form semantics; the trigger mirrors its label, value, disabled and hidden state. */
function frost(select) {
  if (select.dataset.frost) return;
  select.dataset.frost = "true";
  const trigger = document.createElement("button"),
    text = document.createElement("span");
  trigger.type = "button";
  trigger.className = "frost-select";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  text.className = "frost-select-value";
  trigger.append(text, glyph("chevron"));
  select.classList.add("visually-hidden");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.after(trigger);
  const sync = () => {
    const value = select.selectedOptions[0]?.textContent.trim() || "";
    const label = select.getAttribute("aria-label");
    text.textContent = value;
    trigger.disabled = select.disabled;
    trigger.hidden = select.hidden;
    trigger.setAttribute("aria-label", label ? `${label}: ${value}` : value);
    trigger.title = select.title || value;
  };
  // Programmatic value changes fire no event, so mirror them at the property.
  for (const [name, property] of [
    ["value", valueProperty],
    ["selectedIndex", indexProperty],
  ])
    Object.defineProperty(select, name, {
      configurable: true,
      get() {
        return property.get.call(this);
      },
      set(next) {
        property.set.call(this, next);
        sync();
      },
    });
  new MutationObserver(sync).observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "aria-label", "title"],
  });
  select.addEventListener("change", sync);
  select.addEventListener("input", sync);
  trigger.onclick = () =>
    current?.select === select ? close(true) : show(select, trigger);
  trigger.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(select, trigger);
    }
  };
  sync();
}

/** Frosts every select under `root` now and as the interface renders new ones. Menus close on an outside press, resize or outside scroll. */
export function frostSelects(root = document.body) {
  root.querySelectorAll("select").forEach(frost);
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches("select")) frost(node);
        else node.querySelectorAll("select").forEach(frost);
      }
  }).observe(root, { childList: true, subtree: true });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        current &&
        !current.menu.contains(event.target) &&
        !current.trigger.contains(event.target)
      )
        close();
    },
    true,
  );
  addEventListener("resize", () => close());
  document.addEventListener(
    "scroll",
    (event) => {
      if (current && !current.menu.contains(event.target)) close();
    },
    true,
  );
}
