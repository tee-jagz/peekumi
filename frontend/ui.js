/** @module The Peekumi components: every part of the interface, as functions that return DOM
 * elements with the pk- classes of ui.css. Screens are built only from these parts.
 *
 * docs/design/14-components.md lists the parts and docs/design/15-rules.md gives the rules.
 * scripts/lint-ui.mjs makes sure that other modules do not make elements, markup, classes or
 * inline styles of their own. A new part goes here first, with its row in the components list.
 *
 * Text is always set as text, never parsed as HTML. A child can be a string, a number, a Node,
 * an array of children, or null and false (left out). Event handlers are optional, so the same
 * parts render the mockups in docs/design.
 */
import { uiIcon } from "./icons.js";
import { peek } from "./peek.js";

const SVG = "http://www.w3.org/2000/svg";

/** Creates an element. `props`: `class`, `text`, `style` (a string), `on` (event handlers),
 * `data` (data- attributes), booleans (true sets an empty attribute, false leaves it out) and
 * other attributes. Children follow the rules in the module comment. */
function h(tag, props = {}, ...children) {
  const node = props.svg
    ? document.createElementNS(SVG, tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false || key === "svg") continue;
    if (key === "on") {
      for (const [type, handler] of Object.entries(value))
        if (handler) node.addEventListener(type, handler);
    } else if (key === "data") {
      for (const [name, v] of Object.entries(value))
        if (v != null) node.setAttribute(`data-${name}`, String(v));
    } else if (key === "text") node.textContent = String(value);
    // Through the style object: the app's Content Security Policy blocks style attributes.
    else if (key === "style") node.style.cssText = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  add(node, children);
  return node;
}

/** Appends children: strings and numbers as text, Nodes as they are, arrays in order. */
function add(node, children) {
  for (const child of children.flat(Infinity))
    if (child == null || child === false || child === "") continue;
    else if (typeof child === "string" || typeof child === "number")
      node.append(document.createTextNode(String(child)));
    else node.append(child);
}

const cls = (...names) => names.filter(Boolean).join(" ");

/** An icon (20px, or 16px when `small`). Decorative: the part that holds it has the name. */
export function Icon(name, small = false) {
  return uiIcon(name, small);
}

/** The chevron at the end of a Row that opens a page. */
function Chevron() {
  const svg = uiIcon("forward");
  svg.setAttribute("class", "pk-i pk-chevron");
  return svg;
}

/** Peek in one state or activity pose (see docs/design/12-peek.md). `head` crops it to the head
 * over a map card; `still` stops its motion; `size` is "live", "head", "page", "empty" or
 * "toast". Peek is always aria-hidden. */
export function Peek({ state = "idle", size, still = false, tiled = false }) {
  const sizes = {
    live: "",
    head: "pk-head-peek",
    card: "pk-card-peek",
    toast: "",
    empty: "",
    note: "pk-note-peek",
  };
  return peek(state, {
    tiled,
    head: size === "card",
    className: cls(sizes[size], still && "is-still"),
  });
}

// ---------- Basics ----------

/** A button with a verb label. `variant`: "secondary" (default), "primary", "plain" or
 * "danger". `block` fills the row. At most one primary button in a view (R12). */
export function Button({
  label,
  variant = "secondary",
  block = false,
  disabled = false,
  type = "button",
  onClick,
}) {
  return h(
    "button",
    {
      type,
      class: cls(
        "pk-button",
        variant !== "secondary" && `is-${variant}`,
        block && "is-block",
      ),
      disabled,
      on: onClick && { click: onClick },
    },
    label,
  );
}

/** A 44px icon button with an accessible name. `quiet` for the sheet, `pressed` for a toggle,
 * `dot` ("accent" or "warning") for an agent that works or needs the owner. */
export function IconButton({
  icon,
  label,
  quiet = false,
  pressed,
  dot,
  disabled = false,
  onClick,
}) {
  return h(
    "button",
    {
      type: "button",
      class: cls("pk-icon-button", quiet && "is-quiet"),
      "aria-label": label,
      title: label,
      "aria-pressed": pressed == null ? null : String(pressed),
      disabled,
      data: { dot },
      on: onClick && { click: onClick },
    },
    Icon(icon),
  );
}

/** Two to four related choices that change one view. `options`: { value, label, icon,
 * disabled, title }; with an icon, the label is the accessible name only. */
export function SegmentedControl({ label, options, value, onChange }) {
  if (options.length < 2 || options.length > 4)
    throw new RangeError("A segmented control has 2 to 4 options.");
  return h(
    "div",
    { class: "pk-seg", role: "group", "aria-label": label },
    options.map((o) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(o.value === value),
          "aria-label": o.icon ? o.label : null,
          title: o.title || (o.icon ? o.label : null),
          disabled: o.disabled || null,
          on: onChange && { click: () => onChange(o.value) },
        },
        o.icon ? Icon(o.icon) : o.label,
      ),
    ),
  );
}

const SHEET_TABS = [
  { id: "details", label: "Details", icon: "details" },
  { id: "source", label: "Source", icon: "source" },
  { id: "changes", label: "Changes", icon: "changes" },
  { id: "relations", label: "Relations", icon: "relations" },
];

/** The sheet tabs. Each tab is an icon; the selected tab also shows its name. */
export function Tabs({ selected, tabs = SHEET_TABS, onSelect }) {
  return h(
    "div",
    { class: "pk-tabs", role: "tablist" },
    tabs.map((t) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(t.id === selected),
          "aria-label": t.label,
          on: onSelect && { click: () => onSelect(t.id) },
        },
        Icon(t.icon),
        h("span", {}, t.label),
      ),
    ),
  );
}

/** A labelled one-line field at 16px. `error` marks it and shows the message under it. */
export function TextField({
  label,
  value = "",
  placeholder,
  error,
  name,
  type = "text",
  autocomplete,
  onInput,
  onEnter,
}) {
  return h(
    "label",
    { class: "pk-label" },
    label,
    h("input", {
      class: cls("pk-field", error && "is-error"),
      type,
      name,
      value,
      placeholder,
      autocomplete,
      "aria-invalid": error ? "true" : null,
      on: {
        input: onInput,
        keydown:
          onEnter &&
          ((event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            onEnter(event);
          }),
      },
    }),
    error && h("span", { class: "pk-help is-error" }, error),
  );
}

/** A labelled multi-line field at 16px. It grows up to 40% of the visible height. `code`
 * sets it in mono without the spelling check (a rule in JSON). `onChange` runs when the
 * owner leaves a changed field. */
export function TextArea({
  label,
  value = "",
  placeholder,
  error,
  rows,
  code = false,
  disabled = false,
  onInput,
  onChange,
}) {
  return h(
    "label",
    { class: "pk-label" },
    label,
    h(
      "textarea",
      {
        class: cls("pk-textarea", code && "is-code", error && "is-error"),
        placeholder,
        rows,
        disabled,
        spellcheck: code ? "false" : null,
        on: { input: onInput, change: onChange },
      },
      value,
    ),
    error && h("span", { class: "pk-help is-error" }, error),
  );
}

/** A labelled field that opens a Menu with the choices. `value` is the shown choice. */
export function Select({ label, value, onClick }) {
  return h(
    "label",
    { class: "pk-label" },
    label,
    h(
      "button",
      {
        type: "button",
        class: "pk-select",
        "aria-haspopup": "listbox",
        on: onClick && { click: onClick },
      },
      value,
      Icon("chevron", true),
    ),
  );
}

/** The button that opens the list of a native select (select.js keeps the select for its
 * value and change events): the shown value, then a chevron. */
export function SelectTrigger() {
  return h(
    "button",
    {
      type: "button",
      class: "pk-select pk-select-trigger",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
    },
    h("span", { class: "pk-select-value" }),
    Icon("chevron", true),
  );
}

/** The list that opens from a SelectTrigger. With `noun`, a long list has a filter box on
 * top ("Filter branches"). Its parts are ListboxHeading, ListboxOption and ListboxCount. */
export function Listbox({ id, label, noun }) {
  return h(
    "div",
    {
      id,
      class: "pk-listbox",
      role: "listbox",
      "aria-label": label,
      tabindex: "-1",
    },
    noun &&
      h("input", {
        type: "search",
        class: "pk-listbox-filter",
        placeholder: "Filter " + noun,
        "aria-label": "Filter " + noun,
        "aria-controls": id,
        autocomplete: "off",
      }),
  );
}

/** A quiet heading before a group of options. */
export function ListboxHeading(text) {
  return h("div", { class: "pk-listbox-heading", role: "presentation" }, text);
}

/** One option: its text, an optional quieter `detail` line, and a check when `selected`. */
export function ListboxOption({
  id,
  text,
  detail,
  selected,
  disabled,
  onClick,
}) {
  return h(
    "div",
    {
      id,
      class: "pk-listbox-option",
      role: "option",
      "aria-selected": String(Boolean(selected)),
      "aria-disabled": disabled ? "true" : null,
      on: onClick && { click: onClick },
    },
    h(
      "span",
      { class: "pk-listbox-label" },
      text,
      detail && h("small", {}, detail),
    ),
    selected && Icon("check", true),
  );
}

/** The count at the bottom of a long list: "24 branches" or "3 of 24 match". */
export function ListboxCount() {
  return h("div", { class: "pk-listbox-count", "aria-live": "polite" });
}

/** A 20px checkbox in a 44px row. Without `label`, `name` is its accessible name. */
export function Checkbox({
  label,
  name,
  checked = false,
  disabled = false,
  onChange,
}) {
  const box = h("input", {
    type: "checkbox",
    checked,
    disabled,
    "aria-label": label ? null : name,
    on: onChange && { change: onChange },
  });
  return label ? h("label", { class: "pk-check" }, box, label) : box;
}

/** A row that opens more detail below it. */
export function Disclosure({ summary, open = false }, ...children) {
  return h(
    "details",
    { class: "pk-disclosure", open },
    h("summary", {}, summary, Icon("chevron", true)),
    children,
  );
}

// ---------- Content ----------

/** Text in the body style. */
export function Text(...children) {
  return h("p", { class: "pk-text" }, children);
}

/** A quiet note in body-sm and ink-muted. */
export function Note(...children) {
  return h("p", { class: "pk-note" }, children);
}

/** Parts in a column with the standard gap. */
export function Stack(...children) {
  return h("div", { class: "pk-stack" }, children);
}

/** A row of buttons; `stack` puts them one under the other, full width. */
export function Actions({ stack = false } = {}, ...buttons) {
  return h("div", { class: cls("pk-actions", stack && "is-stack") }, buttons);
}

/** Rows with hairlines between them. */
export function List(...rows) {
  return h("div", { class: "pk-list" }, rows);
}

/** A group heading and its content. */
export function Group({ title }, ...children) {
  return h("div", {}, h("h3", { class: "pk-group-title" }, title), children);
}

/** A list row: the main line, an optional `meta` caption, an optional `end` part (a Figure or
 * StatusMarks), and a chevron when it opens a page. `lead` goes before the title. */
export function Row({
  title,
  meta,
  end,
  lead,
  chevron = true,
  small = false,
  onClick,
}) {
  return h(
    "button",
    { type: "button", class: "pk-row", on: onClick && { click: onClick } },
    lead,
    h(
      "span",
      { class: "pk-row-body" },
      h("span", { class: cls("pk-row-title", small && "is-sm") }, title),
      meta && h("span", { class: "pk-meta" }, meta),
    ),
    end,
    chevron && Chevron(),
  );
}

/** A caption with at most two items joined by " · " (R23). */
export function MetaLine(...items) {
  const parts = items.filter((i) => i != null && i !== false && i !== "");
  if (parts.length > 2)
    throw new RangeError("A MetaLine has at most two items.");
  return h(
    "span",
    { class: "pk-meta" },
    parts.flatMap((p, i) => (i ? [" · ", p] : [p])),
  );
}

/** Two to four facts as label and value pairs: [[label, value], …]. */
export function FactGrid(facts) {
  if (facts.length < 2 || facts.length > 4)
    throw new RangeError("A FactGrid has 2 to 4 facts.");
  return h(
    "dl",
    { class: "pk-facts" },
    facts.map(([label, value]) =>
      h("div", {}, h("dt", {}, label), h("dd", {}, value)),
    ),
  );
}

/** A state word with its dot and colour. `state`: draft, working, needs, ready, approved,
 * merged, stopped or failed. */
export function StatusLabel({ state, text }) {
  return h("span", { class: "pk-status", data: { state } }, text);
}

/** The change counts with their signs: + added, ~ modified, − removed, and the file count. */
export function StatusMarks({ added, modified, removed, files }) {
  return h(
    "span",
    { class: "pk-marks" },
    added > 0 && h("span", { class: "pk-mark is-added" }, `+${added}`),
    modified > 0 && h("span", { class: "pk-mark is-modified" }, `~${modified}`),
    removed > 0 && h("span", { class: "pk-mark is-removed" }, `−${removed}`),
    files != null &&
      h("span", { class: "pk-mark is-files" }, Icon("obj-file", true), files),
  );
}

/** The broken-link mark with a count of rule breaks, or with `text`. */
export function BreakMark({ count, text }) {
  return h(
    "span",
    {
      class: "pk-mark is-break",
      "aria-label": text
        ? null
        : `${count} rule break${count === 1 ? "" : "s"}`,
    },
    Icon("broken", true),
    text ?? count,
  );
}

/** One key number with its unit. `danger` for new rule breaks. */
export function Figure({ value, unit, danger = false, muted = false }) {
  return h(
    "span",
    { class: cls("pk-figure", danger && "is-danger", muted && "is-muted") },
    value,
    h("small", {}, unit),
  );
}

/** Code in running text. */
export function Code(text) {
  return h("code", { class: "pk-code" }, text);
}

/** Code that opens a place on the map. */
export function CodeLink({ text, onClick }) {
  return h(
    "button",
    {
      type: "button",
      class: "pk-code pk-code-link",
      on: onClick && { click: onClick },
    },
    text,
  );
}

/** A command or other preformatted text. */
export function Command(text) {
  return h("pre", { class: "pk-command" }, text);
}

// ---------- Shell ----------

/** The page frame: `header`, an optional `rail` (Time mode), the `map`, the `sheet` and an
 * optional `overlay` (a Dialog). `sheetHeight` (px) keeps the map controls above the sheet. */
export function AppShell({
  header,
  rail,
  map,
  sheet,
  overlay,
  sheetHeight = 0,
}) {
  return h(
    "div",
    { class: "pk pk-shell" },
    h(
      "div",
      { class: "pk-shell-body", style: `--pk-sheet-h: ${sheetHeight}px` },
      header,
      rail,
      map,
      sheet,
      overlay && h("div", { class: "pk-overlay" }, Scrim(), overlay),
    ),
  );
}

/** The repository name, the ComparisonLine, Time or Diff, Conversations and Tasks. `tasksDot`
 * is "accent" while an agent works and "warning" when one needs the owner. */
export function AppHeader({
  name,
  comparison,
  mode = "diff",
  tasksDot,
  onMode,
  onConversations,
  onTasks,
}) {
  return h(
    "header",
    { class: "pk-header" },
    h("div", { class: "pk-header-name" }, h("strong", {}, name), comparison),
    h(
      "div",
      { class: "pk-header-actions" },
      SegmentedControl({
        label: "Mode",
        value: mode,
        onChange: onMode,
        options: [
          { value: "time", label: "Time", icon: "time" },
          { value: "diff", label: "Diff", icon: "diff" },
        ],
      }),
      IconButton({
        icon: "discussion",
        label: "Conversations",
        onClick: onConversations,
      }),
      IconButton({
        icon: "tasks",
        label: "Tasks",
        dot: tasksDot,
        onClick: onTasks,
      }),
    ),
  );
}

/** Branch, base and head. It opens the comparison menu. `offline` shows Offline instead. */
export function ComparisonLine({
  branch,
  base,
  head,
  offline = false,
  onClick,
}) {
  return offline
    ? h("button", { type: "button", class: "pk-compare is-offline" }, "Offline")
    : h(
        "button",
        {
          type: "button",
          class: "pk-compare",
          on: onClick && { click: onClick },
        },
        Icon("branch", true),
        `${branch} · ${base} → ${head}`,
      );
}

/** The bottom sheet over the map (a right panel from 900px). Its height comes from AppShell.
 * `composer` stays at its bottom. */
export function ReviewSheet({ composer, grabber = true }, ...children) {
  return h(
    "section",
    { class: "pk-sheet" },
    grabber &&
      h("button", {
        type: "button",
        class: "pk-grabber",
        "aria-label": "Sheet height. Tap to change",
      }),
    h("div", { class: "pk-sheet-body" }, children),
    composer,
  );
}

/** The selection's icon, name and kind, an optional `keyLine` (a rule break) with an optional
 * `keyAction` (a plain Button, such as Fix), and an `end` part (a LiveLine, a ChangeTray, Back to
 * task or a caption). */
export function SheetTitleRow({ icon, name, kind, keyLine, keyAction, end }) {
  return h(
    "div",
    { class: "pk-sheet-title" },
    h(
      "div",
      { class: "pk-sheet-title-row" },
      Icon(icon, true),
      h("strong", {}, name),
      h("span", { class: "pk-meta" }, kind),
      end,
    ),
    keyLine &&
      h(
        "div",
        { class: "pk-keyline" },
        Icon("broken", true),
        h("span", {}, keyLine),
        keyAction,
      ),
  );
}

/** A caption at the end of a SheetTitleRow. */
export function TitleEnd(...children) {
  return h("span", { class: "pk-meta pk-end" }, children);
}

/** Back, the page title, a MetaLine, Peek in the page's state, and at most two actions.
 * `back: false` leaves out Back (the first page of a dialog); `backLabel` names it. */
export function PageHeader({
  title,
  meta,
  state,
  actions = [],
  back = true,
  backLabel = "Back",
  onBack,
}) {
  if (actions.length > 2)
    throw new RangeError("A PageHeader has at most two actions.");
  return h(
    "div",
    { class: "pk-page-header" },
    back &&
      IconButton({
        icon: "back",
        label: backLabel,
        quiet: true,
        onClick: onBack,
      }),
    h("div", { class: "titles" }, h("h2", {}, title), meta),
    h(
      "div",
      { class: "actions" },
      state && Peek({ state, size: "head" }),
      actions,
    ),
  );
}

/** The composer: Ask, Instruction or Session, the place it is about (`code` for a path), the
 * field and Send. With `intent`, there is no mode control: the owner types first, then sends
 * the text as a question (Ask) or keeps it as a change for an agent (Add as a change). */
export function Composer({
  mode = "ask",
  place = "Repository",
  code = false,
  placeholder = "Ask about the repository",
  intent = false,
  value,
  asking,
  docked,
  onMode,
  onInput,
  onSend,
  onAdd,
}) {
  if (intent)
    return IntentComposer({
      place,
      code,
      value,
      asking,
      docked,
      onInput,
      onSend,
      onAdd,
    });
  return h(
    "div",
    { class: "pk-composer" },
    h(
      "div",
      { class: "pk-composer-top" },
      SegmentedControl({
        label: "Composer mode",
        value: mode,
        onChange: onMode,
        options: [
          { value: "ask", label: "Ask", icon: "ask" },
          { value: "instruction", label: "Instruction", icon: "comment" },
          { value: "session", label: "Session", icon: "session" },
        ],
      }),
      h(
        "span",
        { class: "pk-place" },
        Icon("pin", true),
        code ? h("code", {}, place) : place,
      ),
    ),
    h(
      "div",
      { class: "pk-composer-input" },
      h("input", {
        class: "pk-field",
        placeholder,
        "aria-label": placeholder,
      }),
      h(
        "button",
        {
          type: "button",
          class: "pk-send",
          "aria-label": "Send",
          disabled: !onSend,
          on: onSend && { click: onSend },
        },
        Icon("send"),
      ),
    ),
  );
}

/** The composer without modes: the place, one field, then Add as a change and Ask. The
 * owner types first and chooses at the end (docs/design/19-flows.md, flow 2). `asking` shows
 * that an answer is on its way; `docked` drops the composer's own padding inside the app's
 * dock; `onInput` gets the text as it changes; `onAdd` and `onSend` get the text. */
function IntentComposer({
  place,
  code,
  value = "",
  asking = false,
  docked = false,
  addLabel = "Add as a change",
  onInput,
  onSend,
  onAdd,
}) {
  const label = "Ask, or describe a change";
  const field = h(
    "textarea",
    {
      class: "pk-field",
      rows: "1",
      maxlength: "8000",
      placeholder: label,
      "aria-label": label,
    },
    value,
  );
  const add = h(
    "button",
    {
      type: "button",
      class: "pk-send is-secondary",
      "aria-label": addLabel,
      title: addLabel,
      disabled: !value.trim(),
      on: onAdd && { click: () => onAdd(field.value) },
    },
    Icon("add"),
  );
  const ask = h(
    "button",
    {
      type: "button",
      class: "pk-send",
      "aria-label": asking ? "Thinking…" : "Ask",
      title: asking ? "Thinking…" : "Ask",
      disabled: asking || !value.trim(),
      on: onSend && { click: () => onSend(field.value) },
    },
    Icon(asking ? "pending" : "send"),
  );
  field.addEventListener("input", () => {
    const empty = !field.value.trim();
    add.disabled = empty;
    ask.disabled = asking || empty;
    onInput?.(field.value);
  });
  return h(
    "div",
    { class: cls("pk-composer", docked && "is-docked") },
    place &&
      h(
        "div",
        { class: "pk-composer-top" },
        h(
          "span",
          { class: "pk-place" },
          Icon("pin", true),
          code ? h("code", {}, place) : place,
        ),
      ),
    h("div", { class: "pk-composer-input" }, field, add, ask),
  );
}

/** The composer with one action: the place, one field and its send button. For a question on
 * the Ask page, a reply in a session, and the changes to a task. `busy` shows that an answer
 * is on its way (`busyLabel`); `onInput` gets the text as it changes; `onSend` gets the text. */
export function ReplyComposer({
  label,
  placeholder = label,
  sendLabel,
  busyLabel = "Thinking…",
  busy = false,
  sendIcon = "send",
  place,
  code = false,
  value = "",
  docked = false,
  onInput,
  onSend,
}) {
  const field = h(
    "textarea",
    {
      class: "pk-field",
      rows: "1",
      maxlength: "8000",
      placeholder,
      "aria-label": label,
    },
    value,
  );
  const send = h(
    "button",
    {
      type: "button",
      class: "pk-send",
      "aria-label": busy ? busyLabel : sendLabel,
      title: busy ? busyLabel : sendLabel,
      disabled: busy || !value.trim(),
      on: onSend && { click: () => onSend(field.value) },
    },
    Icon(busy ? "pending" : sendIcon),
  );
  field.addEventListener("input", () => {
    send.disabled = busy || !field.value.trim();
    onInput?.(field.value);
  });
  return h(
    "div",
    { class: cls("pk-composer", docked && "is-docked") },
    place &&
      h(
        "div",
        { class: "pk-composer-top" },
        h(
          "span",
          { class: "pk-place", title: place },
          Icon("pin", true),
          code ? h("code", {}, place) : place,
        ),
      ),
    h("div", { class: "pk-composer-input" }, field, send),
  );
}

/** A change to send, with its checkbox: the change as the main line, where it is under it. */
export function PickRow({ title, meta, checked = true, onChange }) {
  return h(
    "label",
    { class: "pk-row pk-pick" },
    h("input", {
      type: "checkbox",
      checked,
      on: onChange && { change: (e) => onChange(e.target.checked) },
    }),
    h(
      "span",
      { class: "pk-row-body" },
      h("span", { class: "pk-row-title is-sm" }, title),
      meta && h("span", { class: "pk-meta" }, meta),
    ),
  );
}

/** The changes that wait to go to an agent, as one button: the tray icon and the count, named
 * "2 changes · Send". It opens the send sheet. Every way to make a change (an instruction, a fix, a rule, an Ask suggestion)
 * adds to it. */
export function ChangeTray({ count, onClick }) {
  const label = `${count} ${count === 1 ? "change" : "changes"} · Send`;
  return h(
    "button",
    {
      type: "button",
      class: "pk-tray",
      "aria-label": label,
      title: label,
      on: onClick && { click: onClick },
    },
    Icon("tray"),
    h("span", { class: "pk-tray-count", "aria-hidden": "true" }, count),
  );
}

/** The agent choice in the dock: the Agents icon (the same as on the Tasks page), with the
 * agent's name for assistive technology and for the tooltip of the button that holds it. */
export function AgentMark(name) {
  return h(
    "span",
    { class: "pk-agent-mark" },
    Icon("agents"),
    h("span", { class: "pk-vh" }, name),
  );
}

/** One choice from a short list, as rows with a check on the chosen one. `options`:
 * { value, title, meta }. */
export function Choices({ label, options, value, onChange }) {
  // An option with `disabled` stays in the list, with its meta saying why. `hidden` leaves an
  // option out of view (a search), and `data-value` names it.
  return h(
    "div",
    { class: "pk-list pk-choices", role: "radiogroup", "aria-label": label },
    options.map((o) =>
      h(
        "button",
        {
          type: "button",
          class: "pk-row",
          role: "radio",
          "aria-checked": String(o.value === value),
          disabled: o.disabled || null,
          hidden: o.hidden || null,
          data: { value: o.value },
          on: onChange && { click: () => onChange(o.value) },
        },
        h(
          "span",
          { class: "pk-row-body" },
          h("span", { class: "pk-row-title" }, o.title),
          o.meta && h("span", { class: "pk-meta" }, o.meta),
        ),
        o.value === value && Icon("check"),
      ),
    ),
  );
}

/** One line for the agent: Peek in its activity or state, then the text. `needs` for an agent
 * that waits for the owner. It opens the run. */
export function LiveLine({
  text,
  state = "working",
  needs = false,
  still = false,
  onClick,
}) {
  return h(
    "button",
    {
      type: "button",
      class: cls("pk-live has-peek", needs && "is-needs"),
      on: onClick && { click: onClick },
    },
    Peek({ state, size: "live", still }),
    h("span", { class: "pk-live-text" }, text),
  );
}

// ---------- Map ----------

/** The app's map viewport: one focusable group that canvas.js pans and zooms, with one layer
 * of `width` × `height` that holds the `content`. */
export function MapViewport({ width, height, label }, content) {
  return h(
    "div",
    {
      class: "pk-map-viewport",
      role: "group",
      tabindex: "0",
      "aria-label": label,
    },
    h(
      "div",
      {
        class: "pk-map-layer",
        style: `width: ${width}px; height: ${height}px`,
      },
      content,
    ),
  );
}

/** The map: a plane of `width` × `height` with the dot grid, the `edges` (MapEdge), the `cards`
 * (MapCard) and `marks` (EdgeMark), and the MapControls. */
export function MapCanvas({
  width,
  height,
  cards = [],
  edges = [],
  marks = [],
  controls = true,
}) {
  return h(
    "div",
    { class: "pk-map" },
    h(
      "div",
      {
        class: "pk-map-plane",
        style: `width: ${width}px; height: ${height}px`,
      },
      h(
        "svg",
        {
          svg: true,
          class: "pk-edges",
          viewBox: `0 0 ${width} ${height}`,
          "aria-hidden": "true",
        },
        h(
          "defs",
          { svg: true },
          h(
            "pattern",
            {
              svg: true,
              id: "grid-dots",
              width: 16,
              height: 16,
              patternUnits: "userSpaceOnUse",
            },
            h("circle", {
              svg: true,
              class: "pk-grid-dot",
              cx: 8,
              cy: 8,
              r: 1,
            }),
          ),
        ),
        h("rect", {
          svg: true,
          x: -400,
          y: -400,
          width: 4000,
          height: 4000,
          fill: "url(#grid-dots)",
        }),
        edges,
      ),
      cards,
      marks,
    ),
    controls && MapControls(),
  );
}

/** A dependency line. `kind`: import (default), impl, out, break, added, removed; `selected` and
 * `dim` for a selection. */
export function MapEdge({ d, kind, selected = false, dim = false }) {
  return h("path", {
    svg: true,
    d,
    class: cls(
      "pk-edge",
      kind && kind !== "import" && `is-${kind}`,
      selected && "is-selected",
      dim && "is-dim",
    ),
  });
}

/** The broken-link mark at the middle of a rule-break line. */
export function EdgeMark({ x, y }) {
  return h(
    "span",
    { class: "pk-edge-mark", style: `left: ${x}px; top: ${y}px` },
    Icon("broken", true),
  );
}

/** A name that may break after ".", "/", "-" and "_", and before a capital inside a word, so a
 * long name takes a second line at its parts, not at a random letter. */
function breakable(name) {
  return name
    .split(/(?<=[._/-])|(?<=[a-z0-9])(?=[A-Z])/)
    .flatMap((part, i) => (i ? [h("wbr"), part] : [part]));
}

/** A card on the map.
 *
 * - `kind`: an object shape for the icon (folder, file, function, class, rootfiles), or `icon`,
 *   a ready icon element (the adapter's type icon, with its own accessible label).
 * - `states`: selected, dim, linked, unchanged, removed, stub, boundary, symbol, agent (with
 *   `doing`, the agent's pose).
 * - A folder with `files` shows its counts and the change bar; a file can show `bars`, one for
 *   each declaration ({ color, title }).
 * - `meta` (a count after the name), `parts` (icons for the changed parts of a declaration),
 *   `breaks` and `breaksTitle` (rule breaks), `uncommitted`.
 * - `data`: data- attributes (key, path, status, …); `label` and `title`: the accessible name
 *   and the tooltip. */
export function MapCard({
  name,
  x,
  y,
  width,
  height,
  kind = "folder",
  icon,
  code = false,
  description,
  added = 0,
  modified = 0,
  removed = 0,
  files,
  breaks,
  breaksTitle,
  meta,
  parts = [],
  bars,
  uncommitted = false,
  states = [],
  doing = "working",
  data = {},
  label,
  title,
  onClick,
}) {
  const shown = code ? h("code", {}, breakable(name)) : breakable(name);
  const breakMark = breaks > 0 && BreakMark({ count: breaks });
  if (breakMark && breaksTitle) breakMark.setAttribute("title", breaksTitle);
  return h(
    "button",
    {
      type: "button",
      class: cls("pk-card", ...states.map((s) => `is-${s}`)),
      data: { kind, ...data, uncommitted: uncommitted ? "true" : null },
      "aria-label": label,
      title,
      tabindex: states.includes("boundary") ? "-1" : null,
      style: `left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px`,
      on: onClick && { click: onClick },
    },
    states.includes("agent") && Peek({ state: doing, size: "card" }),
    h(
      "span",
      { class: "pk-card-top" },
      icon || Icon(`obj-${kind}`, true),
      h("span", { class: "pk-card-name" }, shown),
      meta != null && h("span", { class: "pk-card-meta" }, meta),
      parts.length > 0 && h("span", { class: "pk-card-parts" }, parts),
      uncommitted &&
        h("span", {
          class: "pk-card-dot",
          "aria-label": "uncommitted changes",
        }),
      breakMark,
    ),
    description && h("span", { class: "pk-card-desc" }, description),
    files != null &&
      h(
        "span",
        { class: "pk-card-foot" },
        StatusMarks({ added, modified, removed, files }),
        ChangeBar({ added, modified, removed, files }),
      ),
    bars?.length > 0 &&
      h(
        "span",
        { class: "pk-card-bars", "aria-hidden": "true" },
        bars.map((b) =>
          h("span", { title: b.title, style: `background: ${b.color}` }),
        ),
      ),
    files == null &&
      !bars?.length &&
      // A sum, not ||: with no change it is 0, which a condition would write as text.
      (added || 0) + (modified || 0) + (removed || 0) > 0 &&
      h(
        "span",
        { class: "pk-card-foot" },
        StatusMarks({ added, modified, removed }),
      ),
  );
}

/** Turns the is- states of a part on or off: setStates(card, { selected: true, dim: false }).
 * Other modules change a part's state through this, never through its classes. */
export function setStates(node, states) {
  for (const [state, on] of Object.entries(states))
    node.classList.toggle(`is-${state}`, Boolean(on));
  return node;
}

/** The change bar of a folder: added, modified and removed files against all its files. */
function ChangeBar({ added, modified, removed, files }) {
  if (files == null || !(added || modified || removed)) return null;
  const same = Math.max(files - added - modified - removed, 0);
  return h(
    "span",
    { class: "pk-strata", "aria-hidden": "true" },
    [
      ["is-added", added],
      ["is-modified", modified],
      ["is-removed", removed],
      ["is-same", same],
    ]
      .filter(([, n]) => n)
      .map(([c, n]) => h("span", { class: c, style: `flex: ${n}` })),
  );
}

const CONTROLS = [
  ["home", "Home"],
  ["up", "Up"],
  null,
  ["filter", "Changes only"],
  ["zoomOut", "Zoom out"],
  ["zoomIn", "Zoom in"],
  ["fit", "Fit"],
  ["key", "Key"],
];

/** Home, Up, Changes only, Zoom out, Zoom in, Fit and Key, in one floating bar. */
export function MapControls({ onAction } = {}) {
  return h(
    "div",
    { class: "pk-map-controls" },
    CONTROLS.map((c) =>
      c
        ? IconButton({
            icon: c[0],
            label: c[1],
            onClick: onAction && (() => onAction(c[0])),
          })
        : h("span", { class: "divider" }),
    ),
  );
}

/** A short sample of one line style, for the key. */
export function LineSample(kind) {
  return h(
    "span",
    { class: "pk-key-glyph" },
    h(
      "svg",
      { svg: true, viewBox: "0 0 32 12", "aria-hidden": "true" },
      MapEdge({ d: "M2 6 H30", kind }),
    ),
    kind === "break" && EdgeMark({ x: 16, y: 6 }),
  );
}

/** The key: the status marks and the line styles. */
export function MapKey() {
  const row = (glyph, text) =>
    h(
      "div",
      { class: "pk-key-row" },
      h("span", { class: "pk-key-glyph" }, glyph),
      text,
    );
  const line = (kind, text) =>
    h("div", { class: "pk-key-row" }, LineSample(kind), text);
  return h(
    "div",
    { class: "pk-key" },
    h("h3", {}, "Status"),
    row(StatusMarks({ added: 1 }), "Added"),
    row(StatusMarks({ modified: 1 }), "Modified"),
    row(StatusMarks({ removed: 1 }), "Removed"),
    row(h("span", { class: "pk-card-dot" }), "Uncommitted changes"),
    row(BreakMark({ text: "" }), "Rule breaks"),
    h("h3", {}, "Lines"),
    line("import", "Import or call"),
    line("impl", "Implements"),
    line("out", "Outgoing"),
    line("break", "Breaks a rule"),
    line("removed", "Removed"),
  );
}

/** The commit strip of Time mode: { hash, subject, current } for each commit. */
export function TimeRail(commits, onSelect) {
  return h(
    "div",
    { class: "pk-rail" },
    commits.map((c) =>
      h(
        "button",
        {
          type: "button",
          class: "pk-commit",
          "aria-current": String(Boolean(c.current)),
          on: onSelect && { click: () => onSelect(c.hash) },
        },
        h("code", {}, c.hash),
        h("span", {}, c.subject),
      ),
    ),
  );
}

/** The list view of the map: { name, kind, added, modified, removed, breaks } for each item. */
export function MapList(items, onOpen) {
  return List(
    items.map((i) =>
      Row({
        lead: Icon(`obj-${i.kind || "folder"}`, true),
        title: i.name,
        end: [StatusMarks(i), i.breaks > 0 && BreakMark({ count: i.breaks })],
        onClick: onOpen && (() => onOpen(i)),
      }),
    ),
  );
}

// ---------- Code ----------

/** Code text with syntax parts: a string, or [[text, kind], …] where kind is "c" (comment),
 * "s" (string), "d" (declaration), "add" or "del" (a changed word), or null. */
function code(parts) {
  if (typeof parts === "string") return parts;
  const kinds = {
    c: "syn-c",
    s: "syn-s",
    d: "syn-d",
    add: "w-add",
    del: "w-del",
  };
  return parts.map(([text, kind]) =>
    kind ? h("span", { class: kinds[kind] }, text) : text,
  );
}

/** A unified diff. `lines`: { kind: "+", "-", " " or "@", old, new, code } (see code()). A
 * { collapsed: n } item is the row for n hidden lines. */
export function DiffBlock({ file, added, removed, lines, onExpand }) {
  const signs = { "+": "+", "-": "−", " ": " ", "@": "" };
  const kinds = { "+": "is-add", "-": "is-del", "@": "is-hunk", " ": "" };
  return h(
    "div",
    { class: "pk-diff" },
    file &&
      h(
        "div",
        { class: "pk-diff-file" },
        h("span", {}, file),
        StatusMarks({ added, removed }),
      ),
    lines.map((l) =>
      l.collapsed
        ? CollapsedLines({ count: l.collapsed, onClick: onExpand })
        : h(
            "div",
            { class: cls("pk-line", kinds[l.kind]) },
            h("span", { class: "n" }, l.old ?? ""),
            h("span", { class: "n" }, l.new ?? ""),
            h("span", { class: "s" }, signs[l.kind]),
            h("span", { class: "t" }, code(l.code)),
          ),
    ),
  );
}

/** Source with line numbers: { n, code, selected } for each line. */
export function SourceBlock(lines) {
  return h(
    "div",
    { class: "pk-source" },
    lines.map((l) =>
      h(
        "div",
        { class: cls("pk-line", l.selected && "is-selected") },
        h("span", { class: "n" }, l.n),
        h("span", { class: "t" }, code(l.code)),
      ),
    ),
  );
}

/** The row for hidden unchanged lines in a diff. */
export function CollapsedLines({ count, onClick }) {
  return h(
    "button",
    {
      type: "button",
      class: "pk-collapsed",
      on: onClick && { click: onClick },
    },
    Icon("chevron", true),
    `Show ${count} lines`,
  );
}

// ---------- Tasks and review ----------

/** A task as a Row: its title, its StatusLabel and the time. */
export function TaskRow({ title, state, stateText, detail, onClick }) {
  return Row({
    title,
    meta: MetaLine(StatusLabel({ state, text: stateText }), detail),
    onClick,
  });
}

/** One instruction, the agent's report and its commit. */
export function InstructionReport({
  title,
  state,
  stateText,
  report,
  commit,
  files,
}) {
  return h(
    "div",
    { class: "pk-report" },
    h("p", { class: "pk-report-title" }, title),
    StatusLabel({ state, text: stateText }),
    report && h("blockquote", {}, report),
    commit && MetaLine(h("code", {}, commit), files),
  );
}

/** The agent's message in a session. */
export function AgentMessage(text, steps = []) {
  return h(
    "div",
    { class: "pk-report is-plain" },
    h("p", {}, text),
    steps.length > 0 && ProgressSteps({ steps }),
  );
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*)/;

/** Text with inline code, bold and italic, as nodes. A code span found in `links` becomes a
 * button that calls `onLink` with its target (and keeps the place for the context menu). */
function inlineText(text, links, onLink) {
  // Keep link text and drop the target: a review answer never needs to navigate away.
  const plain = text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
  return plain.split(INLINE).map((part, i) => {
    if (!part || i % 2 === 0) return part;
    const tag = part.startsWith("`")
      ? "code"
      : part.startsWith("**") || part.startsWith("__")
        ? "strong"
        : "em";
    const edge = tag === "em" || tag === "code" ? 1 : 2;
    const words = part.slice(edge, -edge);
    const target =
      tag === "code" && onLink && Object.hasOwn(links, words.trim())
        ? links[words.trim()]
        : null;
    return target
      ? h(
          "button",
          {
            type: "button",
            class: "pk-code-link",
            title: `Show ${target.symbol ? target.symbol + " in " : ""}${target.path} on the map`,
            data: { target: JSON.stringify(target) },
            on: { click: () => onLink(target) },
          },
          h("code", {}, words),
        )
      : h(tag, {}, words);
  });
}

/** The small Markdown that answers, instructions and agent reports use: paragraphs, headings,
 * bullet and numbered lists, fenced code, `code`, **bold** and *italic*. It makes nodes from
 * text only, so repository or model output can never inject HTML; everything else stays as
 * plain text. `links` maps a code span's exact text to a place that `onLink` receives. */
export function Prose(text, { links = {}, onLink = null } = {}) {
  const box = h("div", { class: "pk-prose" });
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let paragraph = [],
    list = null,
    item = null;
  const flush = () => {
    if (paragraph.length)
      box.append(h("p", {}, inlineText(paragraph.join(" "), links, onLink)));
    paragraph = [];
  };
  const closeList = () => {
    list = null;
    item = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      closeList();
      const fence = trimmed.slice(0, 3),
        code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence))
        code.push(lines[i]);
      box.append(h("pre", {}, h("code", {}, code.join("\n"))));
      continue;
    }
    if (!trimmed) {
      flush();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      closeList();
      box.append(
        h(
          "p",
          { class: "pk-prose-heading" },
          inlineText(heading[1], links, onLink),
        ),
      );
      continue;
    }
    const bullet = trimmed.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      if (!list || (list.tagName === "OL") !== ordered) {
        list = h(ordered ? "ol" : "ul");
        box.append(list);
      }
      item = h("li", {}, inlineText(bullet[2], links, onLink));
      list.append(item);
      continue;
    }
    if (item && /^\s+/.test(line)) {
      // An indented continuation line belongs to the list item above it.
      add(item, inlineText(" " + trimmed, links, onLink));
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  flush();
  return box;
}

/** One message of a conversation: the owner's (`from: "user"`) at the right in a quiet box,
 * or the agent's (`"assistant"`) as plain text. `pending` marks an answer on its way. */
export function Message({ from = "assistant", pending = false }, ...children) {
  return h(
    "article",
    {
      class: cls("pk-message", `is-${from}`, pending && "is-pending"),
      "aria-live": pending ? "polite" : null,
    },
    children,
  );
}

/** The messages of a conversation, one under the other. */
export function Thread(...messages) {
  return h("div", { class: "pk-thread" }, messages);
}

/** The mark where the subject of a conversation changes: "About app.js". */
export function SubjectMark(text) {
  return h("p", { class: "pk-subject" }, text);
}

/** A change that an answer suggests: its label, its text, then one action or a note. */
export function Suggestion({ label = "Suggested change", text, action }) {
  return h(
    "div",
    { class: "pk-suggestion" },
    h("span", { class: "pk-suggestion-label" }, label),
    text,
    action,
  );
}

/** Words for work on its way, with a slow pulse after them ("Reading the code…"). */
export function Pending(text) {
  return h("span", { class: "pk-pending" }, text);
}

/** The steps of a long run: { text, state: "done", "now" or "next" }, and the time since the
 * start. */
export function ProgressSteps({ steps, elapsed }) {
  return [
    h(
      "ul",
      { class: "pk-steps" },
      steps.map((s) =>
        h(
          "li",
          { class: `is-${s.state}` },
          s.state === "done" && Icon("check", true),
          s.state === "now" && Spinner(),
          s.text,
        ),
      ),
    ),
    elapsed && h("span", { class: "pk-elapsed" }, elapsed),
  ];
}

/** A command (or a tool) that an agent asks to use, with the owner's answers. `note` goes
 * before the answers (a note that goes with Deny); `actions` replaces the three standard
 * answers. Without `command` and `icon`, it is a plain choice (End the session). */
export function ApprovalPrompt({
  title = "Allow this command?",
  icon = "shield",
  command,
  reason,
  note,
  actions,
  onAllow,
  onAllowSession,
  onDeny,
}) {
  return h(
    "section",
    { class: "pk-approval", "aria-label": title },
    h(
      "h3",
      { class: cls(!icon && "is-plain") },
      icon && Icon(icon, true),
      title,
    ),
    command != null && Command(command),
    reason && Note(reason),
    note,
    actions
      ? Actions({}, actions)
      : Actions(
          { stack: true },
          Button({ label: "Allow once", variant: "primary", onClick: onAllow }),
          Actions(
            {},
            Button({
              label: "Allow for this session",
              onClick: onAllowSession,
            }),
            Button({ label: "Deny", variant: "danger", onClick: onDeny }),
          ),
        ),
  );
}

/** One step of an agent: a mark for its result (`state`: "done", "failed", "now" or
 * "open"), what it did and its command or pattern. Its `details` show when it opens.
 * `current` marks the step that the agent takes now; `key` keeps it open across a redraw. */
export function StepRow(
  { label, code, state = "done", current = false, key },
  ...details
) {
  return h(
    "details",
    {
      data: { key },
      class: cls(
        "pk-step",
        state === "failed" && "is-failed",
        current && "is-current",
      ),
    },
    h(
      "summary",
      {},
      h(
        "span",
        { class: cls("pk-step-mark", `is-${state}`) },
        state === "done" && Icon("check", true),
        state === "failed" && Icon("close", true),
      ),
      h("span", { class: "pk-step-label" }, label),
      code && h("code", {}, code),
    ),
    h("div", { class: "pk-step-body" }, details),
  );
}

/** Steps in a row, as one compact list. */
export function StepList(...rows) {
  return h("div", { class: "pk-step-list" }, rows);
}

/** The confirmation of a merge: its facts, what happens and the undo note. */
export function MergeDialog({
  branch,
  commits,
  files,
  note,
  onMerge,
  onCancel,
}) {
  return Dialog({
    title: `Merge into ${branch}?`,
    body: [
      FactGrid([
        ["Commits", commits],
        ["Files", files],
      ]),
      Note(note),
    ],
    actions: [
      Button({
        label: `Merge into ${branch}`,
        variant: "primary",
        onClick: onMerge,
      }),
      Button({ label: "Cancel", onClick: onCancel }),
    ],
  });
}

/** A proposed fix or rule: its checkbox (named by `name`), the plain sentence, the breaks
 * figure (none when `breaks` is null), a caption, then the `details` (notes and errors) and a
 * Disclosure with the `editor`. `done` mutes a row that went to an agent. */
export function ProposalRow(
  {
    sentence,
    meta,
    breaks = 0,
    checked = false,
    disabled = false,
    done = false,
    name = "Select this rule",
    editor,
    editLabel = "Edit rule",
    editOpen = false,
    onToggle,
  },
  ...details
) {
  return h(
    "div",
    { class: cls("pk-proposal", done && "is-done") },
    Checkbox({ name, checked, disabled, onChange: onToggle }),
    h("span", { class: "title" }, sentence),
    breaks == null
      ? h("span")
      : Figure({
          value: breaks,
          unit: breaks === 1 ? "break" : "breaks",
          danger: breaks > 0,
          muted: breaks === 0,
        }),
    meta && h("p", { class: "why" }, meta),
    // Only real notes: a condition that gives 0 must not show as "0".
    details.flat().filter(Boolean).length > 0 &&
      h("div", { class: "more" }, details.flat().filter(Boolean)),
    editor && Disclosure({ summary: editLabel, open: editOpen }, editor),
  );
}

// ---------- Feedback ----------

/** An error where it happened: what failed, what to do, and one action when one fixes it. */
export function InlineError({ title, text, action }) {
  return h(
    "div",
    { class: "pk-error", role: "alert" },
    Icon("close", true),
    h("strong", {}, title),
    h("p", {}, text),
    action,
  );
}

/** Peek in its state, one line, an optional note and one action. */
export function EmptyState({ state = "empty", title, text, action, note }) {
  return h(
    "div",
    { class: "pk-empty" },
    Peek({ state, size: "empty" }),
    h("strong", {}, title),
    text && h("p", {}, text),
    action,
    note && MetaLine(note),
  );
}

/** Grey blocks in the shape of the content: one width (in %) for each line. */
export function Skeleton(widths = [40, 90, 75, 60]) {
  return h(
    "div",
    { class: "pk-skeleton", "aria-hidden": "true" },
    widths.map((w) => h("i", { style: `width: ${w}%` })),
  );
}

/** A small spinner, with an optional label next to it. */
export function Spinner(label) {
  const spin = h("span", { class: "pk-spinner", "aria-hidden": "true" });
  return label
    ? Actions({}, spin, h("span", { class: "pk-muted" }, label))
    : spin;
}

/** A passive confirmation. `peek` shows Peek in that state in place of the check icon. */
export function Toast({ text, peek: state }) {
  return h(
    "span",
    { class: "pk-toast", role: "status" },
    state ? Peek({ state, size: "toast" }) : Icon("check", true),
    text,
  );
}

/** A menu: an optional head (`title` · `subtitle`), then its items; null is a separator.
 * An item is `{label, icon, hint, key, accent, danger, onClick}`: `hint` is quiet text at the
 * end (a count, a name), `key` the desktop shortcut. `label` names the menu (else `title`). */
export function Menu(items, { label, title, subtitle } = {}) {
  return h(
    "div",
    { class: "pk-menu", role: "menu", "aria-label": label || title || null },
    title &&
      h(
        "p",
        { class: "pk-menu-head" },
        h("strong", {}, title),
        subtitle && " · " + subtitle,
      ),
    items.map((i) =>
      i
        ? h(
            "button",
            {
              type: "button",
              role: "menuitem",
              tabindex: "-1",
              class: cls(i.danger && "is-danger", i.accent && "is-accent"),
              on: i.onClick && { click: i.onClick },
            },
            i.icon && Icon(i.icon, true),
            h("span", {}, i.label),
            i.hint && h("small", {}, i.hint),
            i.key && h("kbd", {}, i.key === "Enter" ? "↵" : i.key),
          )
        : h("hr"),
    ),
  );
}

/** A quiet note in the header's comparison row: a small Peek in `state`, a few words and
 * plain text actions (`{label, primary, onClick}`). For "Offline", "Update ready" and
 * "Read-only device". `detail` is its tooltip. */
export function HeaderNote({ state, text, detail, kind, actions = [] }) {
  return h(
    "span",
    {
      class: cls("pk-header-note", kind && `is-${kind}`),
      role: "status",
      title: detail,
    },
    state && Peek({ state, size: "note" }),
    text,
    actions.map((a) =>
      h(
        "button",
        {
          type: "button",
          class: cls("pk-header-note-action", a.primary && "is-main"),
          on: { click: a.onClick },
        },
        a.label,
      ),
    ),
  );
}

/** A floating panel with a title. */
export function Popover({ title }, ...children) {
  return h("div", { class: "pk-popover" }, h("strong", {}, title), children);
}

/** The scrim behind a Dialog. */
export function Scrim() {
  return h("div", { class: "pk-scrim" });
}

/** A modal sheet: a native dialog over the scrim, at the bottom of a phone and in the middle
 * from 900px. `label` names it. Escape and a tap on the scrim call `onClose`. The children go
 * in its body (`.pk-modal-body`); `openModal` shows it. */
export function Modal({ label, onClose }, ...children) {
  const dialog = h(
    "dialog",
    {
      class: "pk-modal",
      "aria-label": label,
      on: {
        cancel: (event) => {
          event.preventDefault();
          onClose?.();
        },
        click: (event) => event.target === dialog && onClose?.(),
      },
    },
    h("div", { class: "pk-modal-body" }, children),
  );
  return dialog;
}

/** Shows a Modal and returns the function that closes and removes it. */
export function openModal(dialog) {
  document.body.append(dialog);
  dialog.showModal();
  return () => {
    dialog.close();
    dialog.remove();
  };
}

/** A modal dialog: the title, its body and its actions (the verb first). */
export function Dialog({ title, body, actions }) {
  return h(
    "div",
    {
      class: "pk-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title,
    },
    h("h2", {}, title),
    body,
    Actions({ stack: true }, actions),
  );
}
