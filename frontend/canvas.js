/** @module Pan, pinch and zoom viewport for repository cards, moved as one GPU-composited layer. */
import { iconButton } from "./icons.js";
const views = new Map();
// Momentum: velocity decays by this factor per 16 ms frame; flings below the floor stop.
const FRICTION = 0.94,
  MIN_SPEED = 0.02;

/** Mounts map content in a pannable, zoomable viewport and binds touch, mouse, wheel and
 * keyboard controls. The content layer is moved with a CSS transform, so panning composites
 * on the GPU instead of repainting every card. Remembers the view by key, adds momentum to
 * flings, suppresses clicks after gestures and brings keyboard-focused cards into view.
 * Mutates the supplied container and controls; icon buttons are appended to `toolbar`,
 * which defaults to `controls`. */
export function mountCanvas(
  body,
  content,
  width,
  height,
  key,
  controls,
  toolbar = controls,
) {
  const viewport = document.createElement("div");
  viewport.className = "map-canvas";
  viewport.setAttribute(
    "aria-label",
    "Repository map. Drag to pan, scroll to move, pinch or Control-scroll to zoom.",
  );
  viewport.setAttribute("role", "group");
  viewport.tabIndex = 0;
  const layer = document.createElement("div");
  layer.className = "map-layer";
  layer.style.width = width + "px";
  layer.style.height = height + "px";
  layer.append(content);
  viewport.append(layer);
  body.replaceChildren(viewport, controls);
  const view = {
    ...(views.get(key) || {
      x: (body.clientWidth - width) / 2,
      y: 0,
      scale: 1,
    }),
  };
  let settle = 0,
    glide = 0;
  // Promote the layer only while it moves; afterwards it re-rasterizes crisply at its scale.
  const moving = () => {
    layer.classList.add("is-moving");
    clearTimeout(settle);
    settle = setTimeout(() => layer.classList.remove("is-moving"), 160);
  };
  const remember = () => {
    layer.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
    views.delete(key);
    views.set(key, { ...view });
    if (views.size > 40) views.delete(views.keys().next().value);
  };
  const stopGlide = () => {
    cancelAnimationFrame(glide);
    glide = 0;
  };
  const zoom = (
    factor,
    x = viewport.clientWidth / 2,
    y = viewport.clientHeight / 2,
  ) => {
    const scale = Math.max(0.05, Math.min(3, view.scale * factor));
    const ratio = scale / view.scale;
    view.x = x - (x - view.x) * ratio;
    view.y = y - (y - view.y) * ratio;
    view.scale = scale;
    moving();
    remember();
  };
  const add = (name, icon, action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.onclick = () => {
      stopGlide();
      action();
    };
    toolbar.append(iconButton(b, icon, name));
  };
  add("Zoom out", "zoomOut", () => zoom(1 / 1.25));
  add("Zoom in", "zoomIn", () => zoom(1.25));
  add("Fit map", "fit", () => {
    view.scale = Math.max(
      0.05,
      Math.min(
        1.5,
        (viewport.clientWidth - 16) / width,
        (viewport.clientHeight - 16) / height,
      ),
    );
    view.x = (viewport.clientWidth - width * view.scale) / 2;
    view.y = (viewport.clientHeight - height * view.scale) / 2;
    moving();
    remember();
  });
  add("Reset map view", "reset", () => {
    view.x = (viewport.clientWidth - width) / 2;
    view.y = 0;
    view.scale = 1;
    moving();
    remember();
  });
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stopGlide();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientHeight
            : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect();
        zoom(
          Math.exp(-event.deltaY * unit * 0.008),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      } else {
        view.x -= event.deltaX * unit;
        view.y -= event.deltaY * unit;
        moving();
        remember();
      }
    },
    { passive: false },
  );
  const pointers = new Map();
  let moved = false,
    start = null,
    captured = false,
    track = [];
  const geometry = () => {
    const points = [...pointers.values()];
    return {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
      distance:
        points.length === 2
          ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
          : 0,
    };
  };
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    stopGlide();
    if (!pointers.size) {
      moved = false;
      captured = false;
      start = { x: event.clientX, y: event.clientY };
      track = [];
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      moved = true;
      for (const id of pointers.keys()) viewport.setPointerCapture(id);
      captured = true;
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const old = geometry();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const next = geometry();
    if (
      !moved &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5
    )
      return;
    if (!captured) {
      viewport.setPointerCapture(event.pointerId);
      captured = true;
    }
    moved = true;
    if (old.distance && next.distance) {
      const rect = viewport.getBoundingClientRect();
      zoom(next.distance / old.distance, old.x - rect.left, old.y - rect.top);
    }
    view.x += next.x - old.x;
    view.y += next.y - old.y;
    // Keep the last ~100 ms of single-finger movement to estimate fling velocity.
    if (pointers.size === 1) {
      track.push({ x: view.x, y: view.y, t: event.timeStamp });
      while (track.length > 2 && event.timeStamp - track[0].t > 100)
        track.shift();
    } else track = [];
    moving();
    remember();
  });
  /** Continues a released single-finger pan with decaying velocity. */
  const fling = () => {
    if (track.length < 2) return;
    const first = track[0],
      last = track.at(-1),
      elapsed = last.t - first.t;
    if (elapsed <= 0 || performance.now() - last.t > 80) return;
    let vx = (last.x - first.x) / elapsed,
      vy = (last.y - first.y) / elapsed,
      previous = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - previous);
      previous = now;
      view.x += vx * dt;
      view.y += vy * dt;
      const decay = Math.pow(FRICTION, dt / 16);
      vx *= decay;
      vy *= decay;
      moving();
      remember();
      glide =
        Math.hypot(vx, vy) > MIN_SPEED ? requestAnimationFrame(step) : 0;
    };
    if (Math.hypot(vx, vy) > MIN_SPEED) glide = requestAnimationFrame(step);
  };
  const end = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
    if (!pointers.size) {
      if (moved && event.type === "pointerup") fling();
      // A drag produces no click; clear the flag so the next keyboard activation works.
      setTimeout(() => {
        if (!pointers.size) moved = false;
      }, 0);
    }
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
  viewport.addEventListener(
    "click",
    (event) => {
      if (moved && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        moved = false;
      }
    },
    true,
  );
  viewport.addEventListener("keydown", (event) => {
    if (event.target !== viewport) return;
    const delta = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    }[event.key];
    if (delta) {
      event.preventDefault();
      stopGlide();
      view.x += delta[0];
      view.y += delta[1];
      moving();
      remember();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1 / 1.25);
    }
  });
  // Keyboard navigation brings the focused card into the viewport. Pointer focus does not,
  // so tapping a card near the edge never shifts the map under the finger.
  viewport.addEventListener("focusin", (event) => {
    if (event.target === viewport || !event.target.matches(":focus-visible"))
      return;
    const card = event.target.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect();
    if (
      card.top < bounds.top ||
      card.bottom > bounds.bottom ||
      card.left < bounds.left ||
      card.right > bounds.right
    ) {
      stopGlide();
      if (card.left < bounds.left || card.right > bounds.right)
        view.x += bounds.left + bounds.width / 2 - (card.left + card.width / 2);
      if (card.top < bounds.top || card.bottom > bounds.bottom)
        view.y += bounds.top + bounds.height / 2 - (card.top + card.height / 2);
      moving();
      remember();
    }
  });
  /** Pans so that `card` sits in the middle of the visible map: Follow and links use it, so
   * the place they show is never at the edge. The part under the sheet does not count.
   * Animated unless the owner prefers reduced motion. */
  viewport.centerCard = (card) => {
    if (!card?.isConnected) return;
    stopGlide();
    const box = card.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect(),
      sheet = document.querySelector("#panel")?.getBoundingClientRect();
    const bottom = sheet && sheet.top > bounds.top + 80 ? Math.min(bounds.bottom, sheet.top) : bounds.bottom;
    view.x += bounds.left + bounds.width / 2 - (box.left + box.width / 2);
    view.y += (bounds.top + bottom) / 2 - (box.top + box.height / 2);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      layer.style.transition = "transform 280ms cubic-bezier(.3,.7,.3,1)";
      setTimeout(() => (layer.style.transition = ""), 320);
    }
    moving();
    remember();
  };
  remember();
}
