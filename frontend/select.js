/** @module Frosted menus that replace native select popups while keeping each select as the value and change-event source. */
import {
  Listbox,
  ListboxCount,
  ListboxHeading,
  ListboxOption,
  SelectTrigger,
} from "./ui.js";

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
// More entries than this get a filter box.
const LONG = 12;

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
  const id = "select-list-" + ++menuId,
    items = [];
  // A long list (such as the branches of a large repository) gets a filter box on top
  // and a count at the bottom. The select's data-noun names its entries.
  const noun = select.dataset.noun || "options",
    long = select.options.length > LONG,
    menu = Listbox({
      id,
      label: select.getAttribute("aria-label") || "Options",
      noun: long ? noun : null,
    }),
    filter = menu.querySelector(".pk-listbox-filter"),
    count = long ? ListboxCount() : null,
    headings = [];
  for (const option of select.options) {
    // A group gets a quiet heading before its first option.
    const group = option.parentElement;
    if (group.tagName === "OPTGROUP" && group.firstElementChild === option) {
      const heading = ListboxHeading(group.label);
      headings.push({
        heading,
        from: items.length,
        to: items.length + group.children.length,
      });
      menu.append(heading);
    }
    // An option can carry a second, quieter line, such as a pull request's state.
    const item = ListboxOption({
      id: `${id}-${items.length}`,
      text: option.textContent.trim(),
      detail: option.dataset.detail,
      selected: option.selected,
      disabled: option.disabled,
      onClick: () => choose(select, option),
    });
    items.push(item);
    menu.append(item);
  }
  if (count) menu.append(count);
  let active = Math.max(0, select.selectedIndex);
  const activate = (index) => {
    items[active]?.removeAttribute("data-active");
    active = Math.max(0, Math.min(items.length - 1, index));
    items[active]?.setAttribute("data-active", "true");
    menu.setAttribute("aria-activedescendant", items[active]?.id || "");
    items[active]?.scrollIntoView({ block: "nearest" });
  };
  /** The next shown entry from `index` in direction `step`; filtered-out entries are skipped. */
  const shown = (index, step) => {
    for (let i = index; i >= 0 && i < items.length; i += step)
      if (!items[i].hidden) return i;
    return active;
  };
  /** Shows only the entries that contain the filter text, and says how many match. */
  const apply = () => {
    const query = filter.value.trim().toLowerCase();
    let matches = 0;
    items.forEach((item, i) => {
      item.hidden =
        !!query && !select.options[i].textContent.toLowerCase().includes(query);
      if (!item.hidden) matches++;
    });
    for (const { heading, from, to } of headings)
      heading.hidden = items.slice(from, to).every((item) => item.hidden);
    count.textContent = query
      ? `${matches} of ${items.length} match`
      : `${items.length} ${noun}`;
    if (items[active]?.hidden) activate(shown(0, 1));
  };
  if (filter) {
    filter.oninput = apply;
    apply();
  }
  menu.onkeydown = (event) => {
    const typing = event.target === filter;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) activate(shown(active + step, step));
    else if (event.key === "Home" && !typing) activate(shown(0, 1));
    else if (event.key === "End" && !typing)
      activate(shown(items.length - 1, -1));
    else if (event.key === "Enter" || (event.key === " " && !typing))
      choose(select, select.options[active]);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") close();
    else if (filter && !typing && event.key.length === 1) {
      // Typing in the open list goes to the filter.
      filter.focus();
      filter.value += event.key;
      apply();
    } else return;
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
  // A filter must not make the menu narrower or move it while the user types.
  menu.style.width = menu.offsetWidth + "px";
  const left = Math.min(rect.left, innerWidth - menu.offsetWidth - margin);
  menu.style.left = Math.max(margin, left) + "px";
  menu.style.top =
    (downward ? rect.bottom + 6 : rect.top - 6 - menu.offsetHeight) + "px";
  current = { menu, trigger, select, top: rect.top, left: rect.left };
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", id);
  activate(active);
  // Open at the current entry, in the middle of the list where there is room.
  const entry = items[active];
  if (entry)
    menu.scrollTop =
      entry.offsetTop - (menu.clientHeight - entry.offsetHeight) / 2;
  // A mouse and keyboard can type at once; a phone keeps its keyboard closed until the
  // filter is tapped.
  (filter && matchMedia("(pointer: fine)").matches ? filter : menu).focus({
    preventScroll: true,
  });
}

/** Hides one native select behind a frosted trigger. The select stays in the DOM for value, events and form semantics; the trigger mirrors its label, value, disabled and hidden state. */
function frost(select) {
  if (select.dataset.frost) return;
  select.dataset.frost = "true";
  const trigger = SelectTrigger(),
    text = trigger.querySelector(".pk-select-value");
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

/** Frosts every select under `root` now and as the interface renders new ones. Menus close on an outside press, resize or an outside scroll that moves the trigger. */
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
      if (!current || current.menu.contains(event.target)) return;
      // Only a scroll that moved the trigger closes the menu. The scroll that brought the
      // trigger into view, before the tap, reports after the menu opened, and changes nothing.
      const at = current.trigger.getBoundingClientRect();
      if (
        Math.abs(at.top - current.top) > 1 ||
        Math.abs(at.left - current.left) > 1
      )
        close();
    },
    true,
  );
}
