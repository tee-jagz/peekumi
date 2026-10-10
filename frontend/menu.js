/** @module The context menu: a long press on a phone, a right-click on a desktop, or the
 * context-menu key (Shift+F10) on a focused item. One small popover next to the finger or
 * cursor, with a header and only the actions that fit the item (see app.js `menuFor`).
 *
 * The trigger is attached once, at the document: a hold of 450 ms opens the menu, a finger
 * that moves first cancels it (so the map still pans), and the click that ends a long press
 * is swallowed. While the menu is open, its item lifts and the rest of the map dims. Arrow
 * keys move between items, a letter runs the item with that key, Escape or a tap outside
 * closes it, and focus goes back to the item. */
import { Menu, setStates } from "./ui.js";

const HOLD = 450,
  SLOP = 8;

let open = null;

/** True while a context menu is open. */
export const menuIsOpen = () => Boolean(open);

/** Closes the open menu, if any, and gives focus back to its item. */
export function closeMenu({ restore = true } = {}) {
  if (!open) return;
  const { popover, target, keydown, outside } = open;
  open = null;
  popover.remove();
  setStates(target, { "menu-target": false });
  setStates(document.body, { "menu-open": false });
  document.removeEventListener("keydown", keydown, true);
  document.removeEventListener("pointerdown", outside, true);
  if (restore && target.isConnected) target.focus({ preventScroll: true });
}

/**
 * Shows a menu for `target` at viewport point `x`,`y`.
 * @param {Element} target The item the menu is about.
 * @param {{title: string, subtitle?: string, items: Array<object|"rule">}} spec Items are
 *   `{label, icon, hint?, key?, accent?, run}`; `icon` names a control glyph, `hint` is quiet
 *   text at the end (a count, a name), `key` is the desktop shortcut letter.
 */
export function showMenu(target, x, y, spec) {
  closeMenu({ restore: false });
  const keys = new Map();
  const popover = Menu(
    spec.items
      .map((item, at) =>
        item === "rule"
          ? // One separator between groups, never two in a row or at the top.
            at > 0 && spec.items[at - 1] !== "rule"
            ? null
            : undefined
          : {
              ...item,
              onClick: () => {
                closeMenu({ restore: false });
                item.run();
              },
            },
      )
      .filter((item) => item !== undefined),
    { title: spec.title, subtitle: spec.subtitle },
  );
  setStates(popover, { floating: true });
  const buttons = [...popover.querySelectorAll('[role="menuitem"]')];
  spec.items
    .filter((item) => item !== "rule")
    .forEach(
      (item, at) => item.key && keys.set(item.key.toLowerCase(), buttons[at]),
    );
  document.body.append(popover);
  // Next to the point, inside the viewport: below and to the right, else above or left.
  const box = popover.getBoundingClientRect(),
    margin = 8;
  const left = Math.min(Math.max(margin, x), innerWidth - box.width - margin);
  const top =
    y + box.height + margin <= innerHeight
      ? y
      : Math.max(margin, y - box.height);
  popover.style.left = left + "px";
  popover.style.top = top + "px";
  setStates(target, { "menu-target": true });
  setStates(document.body, { "menu-open": true });
  const move = (step) => {
    const at = buttons.indexOf(document.activeElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  const keydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Tab") closeMenu({ restore: false });
    else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const key =
        event.key === "Enter" && !buttons.includes(document.activeElement)
          ? "enter"
          : event.key.toLowerCase();
      const button = keys.get(key);
      if (button) {
        event.preventDefault();
        button.click();
      }
    }
  };
  const outside = (event) => {
    if (!popover.contains(event.target)) closeMenu({ restore: false });
  };
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("pointerdown", outside, true);
  open = { popover, target, keydown, outside };
  buttons[0]?.focus({ preventScroll: true });
}

/**
 * Opens a menu on a long press, a right-click or the context-menu key, anywhere in the
 * document. `menuFor(element)` returns `{target, spec}` for the element pressed, or null
 * when it has no menu (then the browser's own menu stays).
 */
export function installContextMenus(menuFor) {
  let hold = 0,
    start = null,
    // True from a long press that opened a menu until its finger lifts; then the click that
    // ends the press, if the phone sends one, is swallowed until `swallowUntil`.
    pressing = false,
    swallowUntil = 0,
    // When a long press last opened a menu: the phone's own menu soon after is the same press.
    lastOpen = -Infinity;
  const openAt = (element, x, y) => {
    const found = menuFor(element);
    if (!found) return false;
    showMenu(found.target, x, y, found.spec);
    return true;
  };
  const cancel = () => {
    clearTimeout(hold);
    hold = 0;
    start = null;
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || event.isPrimary === false) return;
      cancel();
      // A new touch: no click is left to swallow (phones often send none after a long press).
      pressing = false;
      swallowUntil = 0;
      if (!menuFor(event.target)) return;
      start = { x: event.clientX, y: event.clientY, element: event.target };
      hold = setTimeout(() => {
        const at = start;
        cancel();
        if (!at || !openAt(at.element, at.x, at.y)) return;
        lastOpen = performance.now();
        pressing = true;
        navigator.vibrate?.(10);
      }, HOLD);
    },
    { passive: true },
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (
        start &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP
      )
        cancel();
    },
    { passive: true },
  );
  for (const type of ["pointerup", "pointercancel"])
    document.addEventListener(
      type,
      () => {
        cancel();
        // The finger of the long press lifts: its click, if any, follows at once.
        if (pressing) swallowUntil = performance.now() + 400;
        pressing = false;
      },
      { passive: true },
    );
  // The click that ends a long press does not also select or open the item. Only that one:
  // the next tap (on a menu item) works at once.
  document.addEventListener(
    "click",
    (event) => {
      if (performance.now() > swallowUntil) return;
      swallowUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  // A right-click, or the menu that a phone's own long press asks for.
  document.addEventListener("contextmenu", (event) => {
    if (!menuFor(event.target)) return;
    event.preventDefault();
    // This press already opened the menu.
    if (performance.now() - lastOpen < 800) return;
    openAt(event.target, event.clientX, event.clientY);
  });
  // The context-menu key, or Shift+F10, on a focused item.
  document.addEventListener("keydown", (event) => {
    if (
      open ||
      !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    )
      return;
    const element = document.activeElement;
    if (!element || !menuFor(element)) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    openAt(element, box.left + box.width / 2, box.top + box.height / 2);
  });
}
