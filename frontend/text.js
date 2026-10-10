/** @module The old name of the Markdown part: `richText(text, className, options)` is
 * `Prose(text, options)` from ui.js with extra classes for the screens that still use legacy
 * styles. New code calls `Prose`. */
import { Prose } from "./ui.js";

/** Returns `Prose(text, options)`; `className` adds classes for context. */
export function richText(text, className = "", options = {}) {
  const box = Prose(text, options);
  if (className.trim()) box.classList.add(...className.trim().split(/\s+/));
  return box;
}
