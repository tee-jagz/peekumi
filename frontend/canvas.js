/** @module SVG viewport supporting touch, mouse and keyboard navigation around repository cards. */
// SVG viewport with HTML card contents, preserving the reference's glass styling.
const NS = "http://www.w3.org/2000/svg";
const views = new Map();
/** Mounts HTML card content inside an SVG viewport and binds pan, pinch and zoom controls. Remembers the transform by view key, suppresses gesture clicks and pans focused cards into view. Mutates the supplied container and controls. */
export function mountCanvas(body, content, width, height, key, controls) {
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("map-canvas");
  svg.setAttribute(
    "aria-label",
    "Repository map. Drag to pan, scroll to move, pinch or Control-scroll to zoom.",
  );
  svg.setAttribute("role", "group");
  svg.tabIndex = 0;
  const layer = document.createElementNS(NS, "g");
  const foreign = document.createElementNS(NS, "foreignObject");
  foreign.setAttribute("width", width);
  foreign.setAttribute("height", height);
  foreign.append(content);
  layer.append(foreign);
  svg.append(layer);
  body.replaceChildren(svg, controls);
  const view = {
    ...(views.get(key) || {
      x: (body.clientWidth - width) / 2,
      y: 0,
      scale: 1,
    }),
  };
  const label = document.createElement("output");
  label.setAttribute("aria-label", "Map zoom");
  const remember = () => {
    layer.setAttribute(
      "transform",
      `translate(${view.x} ${view.y}) scale(${view.scale})`,
    );
    label.textContent = Math.round(view.scale * 100) + "%";
    views.delete(key);
    views.set(key, { ...view });
    if (views.size > 40) views.delete(views.keys().next().value);
  };
  const zoom = (factor, x = svg.clientWidth / 2, y = svg.clientHeight / 2) => {
    const scale = Math.max(0.001, Math.min(3, view.scale * factor));
    const ratio = scale / view.scale;
    view.x = x - (x - view.x) * ratio;
    view.y = y - (y - view.y) * ratio;
    view.scale = scale;
    remember();
  };
  const add = (name, text, action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", name);
    b.title = name;
    b.onclick = action;
    controls.append(b);
  };
  add("Zoom out", "−", () => zoom(1 / 1.25));
  controls.append(label);
  add("Zoom in", "+", () => zoom(1.25));
  add("Fit map", "Fit", () => {
    view.scale = Math.max(
      0.001,
      Math.min(
        1.5,
        (svg.clientWidth - 16) / width,
        (svg.clientHeight - 16) / height,
      ),
    );
    view.x = (svg.clientWidth - width * view.scale) / 2;
    view.y = (svg.clientHeight - height * view.scale) / 2;
    remember();
  });
  add("Reset map view", "1:1", () => {
    view.x = (svg.clientWidth - width) / 2;
    view.y = 0;
    view.scale = 1;
    remember();
  });
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? svg.clientHeight
            : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = svg.getBoundingClientRect();
        zoom(
          Math.exp(-event.deltaY * unit * 0.008),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      } else {
        view.x -= event.deltaX * unit;
        view.y -= event.deltaY * unit;
        remember();
      }
    },
    { passive: false },
  );
  const pointers = new Map();
  let moved = false,
    start = null,
    captured = false;
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
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!pointers.size) {
      moved = false;
      captured = false;
      start = { x: event.clientX, y: event.clientY };
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      moved = true;
      for (const id of pointers.keys()) svg.setPointerCapture(id);
      captured = true;
    }
  });
  svg.addEventListener("pointermove", (event) => {
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
      svg.setPointerCapture(event.pointerId);
      captured = true;
    }
    moved = true;
    if (old.distance && next.distance) {
      const rect = svg.getBoundingClientRect();
      zoom(next.distance / old.distance, old.x - rect.left, old.y - rect.top);
    }
    view.x += next.x - old.x;
    view.y += next.y - old.y;
    remember();
  });
  const end = (event) => {
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId))
      svg.releasePointerCapture(event.pointerId);
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener(
    "click",
    (event) => {
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        moved = false;
      }
    },
    true,
  );
  svg.addEventListener("keydown", (event) => {
    if (event.target !== svg) return;
    const delta = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    }[event.key];
    if (delta) {
      event.preventDefault();
      view.x += delta[0];
      view.y += delta[1];
      remember();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1 / 1.25);
    }
  });
  // Keyboard navigation brings the focused card into the viewport.
  svg.addEventListener("focusin", (event) => {
    if (event.target === svg) return;
    const card = event.target.getBoundingClientRect(),
      viewport = svg.getBoundingClientRect();
    if (
      card.top < viewport.top ||
      card.bottom > viewport.bottom ||
      card.left < viewport.left ||
      card.right > viewport.right
    ) {
      if (card.left < viewport.left || card.right > viewport.right)
        view.x +=
          viewport.left + viewport.width / 2 - (card.left + card.width / 2);
      if (card.top < viewport.top || card.bottom > viewport.bottom)
        view.y +=
          viewport.top + viewport.height / 2 - (card.top + card.height / 2);
      remember();
    }
  });
  remember();
}
