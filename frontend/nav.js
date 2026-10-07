/** @module The view stack: what the review sheet shows, and the way back.
 *
 * A view is a plain value:
 * - `{name: "inspect", aspect, explore?}`: the map's selection, in one aspect (`details`,
 *   `source`, `changes` or `dependencies`). `explore: {id, branch, base}` marks the map
 *   showing task `id`'s branch, and keeps the comparison to go back to.
 * - `{name: "ask"}`: the Ask conversation of the branch on the map.
 * - `{name: "conversations"}`: the open sessions and the Ask conversation.
 * - `{name: "tasks"}`, `{name: "history"}`: current work, and closed work.
 * - `{name: "prepare"}`: the form that makes a task from drafts.
 * - `{name: "instructions"}`: the instructions on the map's selection.
 * - `{name: "fixes"}`: proposed fixes for the dependency-rule breaks (fixes.js).
 * - `{name: "run", id}`: a task, or a session (a run whose kind is "session").
 *
 * Opening a view pushes it; a view equal to the one on top replaces it instead (a new aspect,
 * say). Back pops one view. The stack never empties: its base is the map in Details, and
 * Back from another aspect there returns to Details. Nothing else in the app keeps navigation
 * state: renderers read `view()`, actions call `go`, `back` or `toMap`. */

/** Views that read a thread: the map's selection stays the subject of the next message. */
export const THREADS = new Set(["ask", "run"]);

const same = (a, b) =>
  a.name === b.name &&
  (a.id ?? null) === (b.id ?? null) &&
  (a.explore?.id ?? null) === (b.explore?.id ?? null);

/**
 * Creates the stack.
 * @param {{changed: (previous: object, next: object) => void}} deps `changed` runs after
 *   every change, with the view before and the view now on top.
 */
export function createNav({ changed }) {
  const base = () => ({ name: "inspect", aspect: "details" });
  let stack = [base()];
  const top = () => stack[stack.length - 1];
  const after = (previous) => changed(previous, top());
  return {
    /** The view on top. */
    view: top,
    /** The nearest view below the top (or the top) that matches `test`, or null. */
    find: (test) => stack.slice().reverse().find(test) || null,
    /** Shows `view`: on top of the stack, or in place of an equal view on top. */
    go(view) {
      const previous = top();
      if (same(previous, view))
        stack[stack.length - 1] = { ...previous, ...view };
      else stack.push(view);
      after(previous);
    },
    /** Returns to the view before; false when the base is already in Details. */
    back() {
      const previous = top();
      if (stack.length > 1) stack.pop();
      else if (previous.aspect !== "details")
        stack[0] = { ...previous, aspect: "details" };
      else return false;
      after(previous);
      return true;
    },
    /** Pops views while `test` holds for the top, down to the base. */
    backWhile(test) {
      const previous = top();
      while (stack.length > 1 && test(top())) stack.pop();
      if (top() !== previous) after(previous);
    },
    /** The map in an aspect, for an action on the map: on top of a page that is not a thread,
     * so Back returns to it; in place of the map view that is already on top. A thread stays
     * in view, and the map's selection becomes its subject. */
    toMap(aspect = "details", { thread = false } = {}) {
      const current = top();
      if (current.name === "inspect") return this.go({ ...current, aspect });
      if (thread) return;
      const explore = this.find((v) => v.explore)?.explore;
      this.go({ name: "inspect", aspect, ...(explore ? { explore } : {}) });
    },
    /** Starts again from the map in Details (a new branch or pull request). */
    reset() {
      const previous = top();
      stack = [base()];
      after(previous);
    },
  };
}
