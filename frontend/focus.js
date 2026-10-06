/** @module Agent focus on the map, for every agent: an open session, a running task and an
 * Ask answer in progress. Each source tells where its agent is (`current`), where it looked
 * before (`trail`) and which files it changed; this module marks those cards, moves the map
 * with the agent (Follow) and puts its card in the middle. One source shows at a time: a
 * running one wins, then the one set last.
 *
 * A place is `{path, symbol?}`. Marks are CSS classes on the map cards (`agent-here`,
 * `agent-trail` with `data-trail`, `agent-changed`) and a working Peek on the current card;
 * they are applied as a difference, so Peek keeps animating while the map is drawn again. */
import { glyph } from "./icons.js";
import { peek } from "./peek.js";

const FOLLOW = "peekumi.session.follow";

/**
 * @param {object} deps
 * @param {(place: {path: string, symbol?: string}) => Promise<void>} deps.followTo Moves the
 *   map to the level that shows a place (app.js).
 */
export function createFocus({ followTo }) {
  // Follow is on unless the owner turned it off on this device. It pauses when the owner
  // moves the map, until they tap the eye.
  let follow = (() => {
      try {
        return localStorage.getItem(FOLLOW) !== "off";
      } catch {
        return true;
      }
    })(),
    paused = false,
    moving = false,
    followed = { key: "", at: 0 },
    // The place and card that Follow last put in the middle of the map.
    centered = "";
  // The sources by name, each `{running, live, current, trail, changed, at}`.
  const sources = new Map();

  /** The map card that shows `place`: the declaration's card inside its file, the file's
   * card, or the nearest folder card that holds it ("Repository files" for a file at the
   * root). `exact` is true when the card is the place itself. */
  function cardFor(place) {
    const cards = [...document.querySelectorAll(".node[data-path]")];
    if (place.symbol) {
      const name = place.symbol.replace("::", ".");
      const symbol = cards.find(
        (c) =>
          c.dataset.kind === "symbol" &&
          c.dataset.path === place.path &&
          (c.dataset.key === "symbol:" + name ||
            c.dataset.key.endsWith("." + name) ||
            c.dataset.key.endsWith(" as " + name)),
      );
      if (symbol) return { card: symbol, exact: true };
    }
    let best = null;
    for (const card of cards) {
      const p = card.dataset.path;
      if (card.dataset.kind === "symbol" || !p) continue;
      if (
        (place.path === p || place.path.startsWith(p + "/")) &&
        (!best || p.length > best.dataset.path.length)
      )
        best = card;
    }
    if (!best && !place.path.includes("/"))
      best = document.querySelector('.node[data-kind="rootfiles"]');
    return best
      ? { card: best, exact: best.dataset.path === place.path && !place.symbol }
      : null;
  }

  /** The source to show: a running one (the latest set), else the latest set. */
  function shown() {
    const all = [...sources.values()].sort((a, b) => b.at - a.at);
    return all.find((s) => s.running) || all[0] || null;
  }

  /** Marks the map for the source shown, moves the map with it, and shows the eye. */
  function apply() {
    const source = shown();
    const running = Boolean(source?.running);
    const wanted = new Map();
    const want = (card, mark, value = true) => {
      if (!wanted.has(card)) wanted.set(card, {});
      wanted.get(card)[mark] ??= value;
    };
    for (const path of source?.changed || []) {
      const found = cardFor({ path });
      if (found) want(found.card, "changed");
    }
    const here = running && source.current ? cardFor(source.current) : null;
    if (here) want(here.card, "here");
    const trail = source
      ? source.trail.concat(running || !source.current ? [] : [source.current])
      : [];
    trail.forEach((place, i) => {
      const found = cardFor(place);
      if (found && found.card !== here?.card)
        want(found.card, "trail", running ? i + 1 : i);
    });
    for (const card of document.querySelectorAll(
      ".node.agent-here, .node.agent-trail, .node.agent-changed",
    ))
      if (!wanted.has(card)) wanted.set(card, {});
    for (const [card, marks] of wanted) {
      card.classList.toggle("agent-changed", Boolean(marks.changed));
      card.classList.toggle(
        "agent-trail",
        marks.trail !== undefined && !marks.here,
      );
      if (marks.trail !== undefined)
        card.dataset.trail = String(Math.min(4, marks.trail + 1));
      else delete card.dataset.trail;
      card.classList.toggle("agent-here", Boolean(marks.here));
      const badge = card.querySelector(":scope > .agent-badge");
      if (marks.here && !badge)
        card.append(peek("working", { className: "agent-badge" }));
      if (!marks.here && badge) badge.remove();
    }
    eye(source && (source.running || source.live));
    // Follow: show the agent's place in the middle of the map. When the place is not on this
    // level of the map, move there first (at most every 3 s), then center its card.
    if (!running || !follow || paused || moving || !source.current) return;
    const key = `${source.current.path}#${source.current.symbol || ""}`;
    if (!here?.exact && key !== followed.key) {
      if (Date.now() - followed.at < 3000) return;
      followed = { key, at: Date.now() };
      moving = true;
      Promise.resolve(followTo(source.current)).finally(() => {
        moving = false;
        apply();
      });
      return;
    }
    followed.key = key;
    const spot = here && `${key}|${here.card.dataset.key}`;
    if (spot && spot !== centered) {
      centered = spot;
      here.card.closest(".map-canvas")?.centerCard?.(here.card);
    }
  }

  /** The eye at the top right of the map while an agent works or a session is open: open
   * while the map follows the agent, crossed out while paused or off. */
  function eye(visible) {
    const stage = document.querySelector("#stage");
    if (!stage) return;
    let host = stage.querySelector("#agentFocus");
    if (!visible) {
      host?.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "agentFocus";
      const button = document.createElement("button");
      button.className = "follow-pill";
      button.type = "button";
      host.append(button);
      stage.append(host);
    }
    const button = host.querySelector(".follow-pill");
    const on = follow && !paused;
    button.dataset.on = String(on);
    button.setAttribute("aria-pressed", String(on));
    const label = on ? "on" : paused ? "paused" : "off";
    if (button.dataset.label !== label) {
      button.dataset.label = label;
      button.replaceChildren(glyph(on ? "eye" : "eyeOff"));
    }
    button.title = on
      ? "Following the agent: the map moves to where it works. Tap to turn off"
      : paused
        ? "Follow paused, because you moved the map. Tap to follow the agent again"
        : "Follow the agent: the map moves to where it works";
    button.setAttribute("aria-label", button.title);
    button.onclick = () => {
      if (on) follow = false;
      else {
        follow = true;
        paused = false;
        followed = { key: "", at: 0 };
      }
      try {
        localStorage.setItem(FOLLOW, follow ? "on" : "off");
      } catch {}
      apply();
    };
  }

  return {
    /** Sets source `name` (`"run"` or `"ask"`): `{running, live?, current, trail,
     * changed?}`, or `null` to remove it. The map updates at once. */
    set(name, source) {
      const before = sources.get(name);
      if (!source) sources.delete(name);
      else
        sources.set(name, {
          trail: [],
          changed: [],
          ...source,
          // A source that starts running again comes to the front.
          at:
            !before || (source.running && !before.running)
              ? performance.now()
              : before.at,
        });
      apply();
    },
    /** Marks the map again after it was drawn. */
    redraw: apply,
    /** The owner moved the map: Follow pauses while an agent works. Follow's own moves do
     * not count. */
    ownerMoved() {
      if (moving || !follow) return;
      if ([...sources.values()].some((s) => s.running || s.live)) paused = true;
    },
    /** True while Follow itself moves the map. */
    moving: () => moving,
  };
}
