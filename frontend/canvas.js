/** @module Pan, pinch and zoom viewport for repository cards, moved as one GPU-composited layer. */
import { iconButton } from "./icons.js";
const views = new Map();
// Momentum: velocity decays by this factor per 16 ms frame; flings below the floor stop.
const FRICTION = 0.94,
  MIN_SPEED = 0.02;

// A pan stops when this much of the map is still in view.
const KEEP = 56;

/** Mounts map content in a pannable, zoomable viewport and binds touch, mouse, wheel and
 * keyboard controls. The content layer is moved with a CSS transform, so panning composites
 * on the GPU instead of repainting every card. Remembers the view by key, adds momentum to
 * flings, suppresses clicks after gestures and brings keyboard-focused cards into view.
 * Mutates the supplied container and controls; icon buttons are appended to `toolbar`,
 * which defaults to `controls`.
 *
 * The visible map is the part of the viewport above the floating controls and the sheet.
 * The first view, Fit, centering and the pan limit use that part, so no card starts or
 * stays under the toolbar. `options.contentHeight` is the height that the cards use (the
 * layer can be taller); `options.center` centers short content vertically, else it starts
 * at the top. Until the owner moves the map, a resize places it again. */
export function mountCanvas(
  body,
  content,
  width,
  height,
  key,
  controls,
  toolbar = controls,
  options = {},
) {
  const contentHeight = Math.min(height, options.contentHeight || height);
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
  const view = { ...(views.get(key) || { x: 0, y: 0, scale: 1, auto: true }) };
  /** The visible part of the viewport, in its own coordinates: above the floating controls
   * and above the sheet when the sheet covers the map. */
  const region = () => {
    const bounds = viewport.getBoundingClientRect();
    let bottom = bounds.height;
    const tools = controls.isConnected
      ? controls.getBoundingClientRect()
      : null;
    if (
      tools?.height &&
      tools.top > bounds.top + 40 &&
      tools.top < bounds.bottom
    )
      bottom = Math.min(bottom, tools.top - bounds.top - 6);
    const sheet = document.querySelector("#panel")?.getBoundingClientRect();
    if (
      sheet &&
      sheet.left < bounds.right &&
      sheet.right > bounds.left &&
      sheet.top > bounds.top + 80
    )
      bottom = Math.min(bottom, sheet.top - bounds.top);
    return {
      left: 0,
      top: 0,
      right: bounds.width,
      bottom: Math.max(40, bottom),
    };
  };
  /** The view that the map opens with: centered across, and at the top (or in the middle,
   * for short content with `options.center`) of the visible part. */
  const place = () => {
    const r = region();
    view.scale = 1;
    view.x = (r.right - r.left - width) / 2;
    view.y = options.center
      ? Math.max(r.top, (r.top + r.bottom - contentHeight) / 2)
      : r.top;
    view.auto = true;
  };
  /** Keeps at least KEEP pixels of the cards in the visible part, so a pan or a fling
   * cannot lose the map. Returns true when it moved the view. */
  const limit = (r = region()) => {
    const w = width * view.scale,
      h = contentHeight * view.scale,
      keepX = Math.min(KEEP, w / 2),
      keepY = Math.min(KEEP, h / 2);
    const x = Math.min(r.right - keepX, Math.max(r.left + keepX - w, view.x)),
      y = Math.min(r.bottom - keepY, Math.max(r.top + keepY - h, view.y));
    const moved = x !== view.x || y !== view.y;
    view.x = x;
    view.y = y;
    return moved;
  };
  let settle = 0,
    glide = 0,
    // The visible part, measured once per gesture: a pan does not read the layout per frame.
    frame = null;
  // Promote the layer only while it moves; afterwards it re-rasterizes crisply at its scale.
  const moving = () => {
    layer.classList.add("is-moving");
    clearTimeout(settle);
    settle = setTimeout(() => layer.classList.remove("is-moving"), 160);
  };
  const remember = () => {
    if (!view.auto) limit(frame || region());
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
    y = (region().top + region().bottom) / 2,
  ) => {
    view.auto = false;
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
    const r = region();
    view.auto = false;
    view.scale = Math.max(
      0.05,
      Math.min(
        1.5,
        (r.right - r.left - 16) / width,
        (r.bottom - r.top - 16) / contentHeight,
      ),
    );
    view.x = r.left + (r.right - r.left - width * view.scale) / 2;
    view.y = r.top + (r.bottom - r.top - contentHeight * view.scale) / 2;
    moving();
    remember();
  });
  add("Reset map view", "reset", () => {
    place();
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
        view.auto = false;
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
      frame = region();
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
    view.auto = false;
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
      // At the limit the fling stops, as a scroll stops at its end.
      if (limit(frame || region())) vx = vy = 0;
      remember();
      glide = Math.hypot(vx, vy) > MIN_SPEED ? requestAnimationFrame(step) : 0;
    };
    if (Math.hypot(vx, vy) > MIN_SPEED) glide = requestAnimationFrame(step);
  };
  const end = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
    if (!pointers.size) {
      if (moved && event.type === "pointerup") fling();
      if (!glide) frame = null;
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
      view.auto = false;
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
    if (!shown(event.target)) {
      stopGlide();
      viewport.centerCard(event.target, { animate: false, ifHidden: true });
    }
  });
  /** True when `card` is wholly in the visible part of the map. */
  const shown = (card, margin = 0) => {
    const box = card.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect(),
      r = region();
    return (
      box.left >= bounds.left + r.left + margin &&
      box.right <= bounds.left + r.right - margin &&
      box.top >= bounds.top + r.top + margin &&
      box.bottom <= bounds.top + r.bottom - margin
    );
  };
  /** Pans so that `card` sits in the middle of the visible map: Follow and links use it, so
   * the place they show is never at the edge or under the controls. With `ifHidden`, a card
   * that is already wholly in view stays where it is (keyboard focus, a resize). Animated
   * unless the owner prefers reduced motion or `animate` is false. */
  viewport.centerCard = (card, { animate = true, ifHidden = false } = {}) => {
    if (!card?.isConnected || !viewport.contains(card)) return;
    stopGlide();
    if (ifHidden && shown(card, 8)) return;
    const box = card.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect(),
      r = region();
    view.auto = false;
    view.x += bounds.left + (r.left + r.right) / 2 - (box.left + box.width / 2);
    view.y += bounds.top + (r.top + r.bottom) / 2 - (box.top + box.height / 2);
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      layer.style.transition = "transform 280ms cubic-bezier(.3,.7,.3,1)";
      setTimeout(() => (layer.style.transition = ""), 320);
    }
    moving();
    remember();
  };
  // A new size (the sheet moved, the phone turned): a map that the owner has not moved opens
  // again in its first view; else the selected card comes back into view.
  let size = "";
  new ResizeObserver(() => {
    if (!viewport.isConnected) return;
    const next = `${viewport.clientWidth}x${viewport.clientHeight}`;
    if (next === size || !viewport.clientHeight) return;
    const first = !size;
    size = next;
    if (view.auto) place();
    else {
      const selected = layer.querySelector(".node.sel");
      if (!first && selected)
        viewport.centerCard(selected, { animate: false, ifHidden: true });
    }
    remember();
  }).observe(viewport);
  if (view.auto) place();
  remember();
}
