/** @module Live sessions: a conversation with a coding agent that works on its own branch
 * (backend/agent_session.rs). The owner's messages start agent turns; this module shows the
 * conversation, each step the agent takes with its output, the agent's command requests, and
 * the way to end the session in the normal review. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  n.className = cls || "";
  if (text !== undefined) n.textContent = text;
  return n;
};

/** True for a session that is still open: an agent turn runs, or it waits for the owner. */
export const live = (r) => r?.kind === "session" && ["running", "waiting"].includes(r.status);

/** True for a command with several parts, which a session rule cannot cover (see
 * backend/agent_session.rs). */
const chained = (command = "") => ["&&", "||", ";", "|", "`", "$(", ">", "<", "\n"].some((c) => command.includes(c)) || command.trim().startsWith("(");

/** How a new session treats commands on this device: "ask" (the default) or "allow". */
const PERMISSIONS = "peekumi.session.permissions";
function savedPermissions() {
  try {
    return localStorage.getItem(PERMISSIONS) === "allow" ? "allow" : "ask";
  } catch {
    return "ask";
  }
}
function savePermissions(mode) {
  try {
    localStorage.setItem(PERMISSIONS, mode);
  } catch {}
}

/** What a live session does now, for the sheet's header outside its view: a title, a short
 * label, the command or file to highlight, and the path the agent works on (for the map).
 * `tail` is the session with the end of its log. */
export function activity(tail) {
  if (tail.approval)
    return { state: "needs", title: "Needs you", label: tail.approval.tool === "Bash" ? "Allow this command?" : `Allow ${tail.approval.tool}?`, code: tail.approval.tool === "Bash" ? tail.approval.input : "" };
  if (tail.status !== "running") return { state: "waiting", title: "Your turn", label: tail.summary ? tail.summary.split("\n")[0] : "The agent waits for your reply." };
  const last = timeline(tail.output || "").filter((i) => i.kind === "step" || i.kind === "text").at(-1);
  if (!last) return { state: "running", title: "Working", label: "Starting" };
  if (last.kind === "text") return { state: "running", title: "Working", label: last.text.split("\n")[0] };
  const path = last.changed?.[0] || last.files?.[0] || "";
  return { state: "running", title: "Working", label: last.label, code: last.code || "", path };
}

/** A path inside the session's worktree, relative to the repository. */
const relative = (path = "") => (path.includes("/worktree/") ? path.split("/worktree/").pop() : path);
const fileName = (path = "") => relative(path).split("/").pop();

/** File and folder paths named in a command or a search, relative to the repository: what
 * the agent looks at when it runs `sed -n 1,40p backend/lookup.rs` or `grep -rn x backend/`.
 * Options, variables, URLs, globs and paths outside the worktree are left out. */
export function pathsIn(text = "") {
  const found = [];
  for (const raw of String(text).split(/[\s'"`;|&()<>=,]+/)) {
    let token = relative(raw).replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "").replace(/[:,.]$/, "");
    // `backend/` names a folder.
    const folder = /^[\w.-]+\/$/.test(token);
    token = token.replace(/\/$/, "");
    if (!token || token.length > 200 || /^[-$~/]/.test(token) || token.includes("://") || token.includes("..") || /[*?{}[\]\\]/.test(token)) continue;
    if (!folder && !token.includes("/") && !/^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(token)) continue;
    if (/^\d+(\.\d+)+$/.test(token)) continue;
    found.push(token);
  }
  return [...new Set(found)].slice(0, 4);
}

/** Where a session's agent is and has been, from its steps: `current` (the newest place),
 * `trail` (up to four places before it, newest first). A place is `{path, symbol?}`. */
export function focusOf(items) {
  const places = items.flatMap((i) => (i.kind === "step" ? i.targets || [] : []));
  const key = (p) => `${p.path}#${p.symbol || ""}`;
  const seen = new Set();
  const order = [];
  for (let i = places.length - 1; i >= 0 && order.length < 5; i--) {
    if (seen.has(key(places[i]))) continue;
    seen.add(key(places[i]));
    order.push(places[i]);
  }
  return { current: order[0] || null, trail: order.slice(1) };
}

/** The text of a Claude Code tool result, which is a string or a list of text parts. */
function resultText(content) {
  if (typeof content === "string") return content;
  return (content || [])
    .map((part) => (typeof part === "string" ? part : part.text || ""))
    .join("\n");
}

/** One Claude Code tool call as a step: a short label, the command or pattern, and the files
 * it read or changed. Peekumi's own bookkeeping calls are left out. */
function claudeStep(part) {
  const input = part.input || {};
  const step = { kind: "step", id: part.id, files: [], changed: [], targets: [] };
  const file = relative(input.file_path || input.notebook_path || "");
  const at = (paths) => paths.filter(Boolean).map((path) => ({ path }));
  switch (part.name) {
    case "Read":
      return { ...step, label: `Read ${fileName(file)}`, files: [file], targets: at([file]) };
    case "Edit":
    case "MultiEdit":
      return { ...step, label: `Edited ${fileName(file)}`, files: [file], changed: [file], targets: at([file]) };
    case "Write":
      return { ...step, label: `Wrote ${fileName(file)}`, files: [file], changed: [file], targets: at([file]) };
    case "Bash":
      return { ...step, label: "Ran", code: input.command, note: input.description, targets: at(pathsIn(input.command)) };
    case "Glob":
      return { ...step, label: "Listed files", code: input.pattern, targets: at(pathsIn(input.path)) };
    case "Grep":
      return { ...step, label: "Searched", code: input.pattern, targets: at(pathsIn(input.path)) };
    case "TodoWrite":
    case "mcp__peekumi__get_run":
      return null;
  }
  if (part.name.startsWith("mcp__peekumi_graph__")) {
    const tool = part.name.slice("mcp__peekumi_graph__".length);
    const target = input.to?.name || input.name || input.query || input.text || input.path || "";
    const path = input.path || input.to?.path;
    // A map lookup names the file and, often, the declaration: that is where the agent looks.
    const targets = [input.from, input.to, input.path ? { path: input.path, name: input.name } : null]
      .filter((t) => t?.path)
      .map((t) => ({ path: t.path, symbol: t.name || undefined }));
    return { ...step, label: `Map · ${tool}`, code: target, files: path ? [path] : [], targets };
  }
  return { ...step, label: part.name };
}

/** Reads a session log into a timeline: the owner's messages, the agent's text, its steps
 * with their output, the end of each turn, and errors. It reads Claude Code's stream-json,
 * Codex's JSON events and Peekumi's own agent, so every provider looks the same. */
export function timeline(output = "") {
  const items = [];
  const steps = new Map();
  for (const line of output.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "peekumi.owner") {
      for (const m of event.messages || [])
        items.push({ kind: "owner", text: m.text, anchors: m.anchors || [], turn: event.turn });
      continue;
    }
    if (event.type === "peekumi.turn") {
      items.push({ kind: "end", status: event.status, turn: event.turn });
      continue;
    }
    if (event.type === "peekumi.error" || (event.type === "error" && event.message)) {
      items.push({ kind: "error", text: event.message });
      continue;
    }
    // Claude Code.
    if (event.type === "assistant")
      for (const part of event.message?.content || []) {
        if (part.type === "text" && part.text?.trim()) items.push({ kind: "text", text: part.text });
        else if (part.type === "tool_use") {
          const step = claudeStep(part);
          if (step) {
            steps.set(part.id, step);
            items.push(step);
          }
        }
      }
    if (event.type === "user")
      for (const part of event.message?.content || []) {
        const step = part.type === "tool_result" && steps.get(part.tool_use_id);
        if (!step) continue;
        step.output = resultText(part.content);
        step.failed = part.is_error === true;
        step.done = true;
      }
    if (event.type === "result" && event.is_error) items.push({ kind: "error", text: event.result || "The agent stopped with an error." });
    if (event.type === "result") items.push({ kind: "cost", cost: event.total_cost_usd || 0 });
    // Codex (item.completed) and Peekumi's own agent (an item alone).
    const item = event.item;
    if (item && (event.type === "item.completed" || !event.type)) {
      if (item.type === "agent_message" && item.text?.trim()) items.push({ kind: "text", text: item.text });
      else if (item.type === "command_execution") {
        const command = String(item.command || "").replace(/^\/bin\/\w+ -lc '(.*)'$/s, "$1");
        items.push({
          kind: "step",
          label: "Ran",
          code: command,
          output: item.aggregated_output,
          failed: typeof item.exit_code === "number" && item.exit_code !== 0,
          done: true,
          files: [],
          changed: [],
          targets: pathsIn(command).map((path) => ({ path })),
        });
      } else if (item.type === "file_change") {
        const paths = item.changes ? item.changes.map((c) => relative(c.path)) : [relative(item.path)];
        items.push({ kind: "step", label: `Changed ${paths.map(fileName).join(", ")}`, files: paths, changed: paths, targets: paths.map((path) => ({ path })), done: true });
      } else if (item.type === "mcp_tool_call" && item.server === "peekumi_graph")
        items.push({ kind: "step", label: `Map · ${item.tool}`, done: true, files: [], changed: [], targets: item.arguments?.path ? [{ path: item.arguments.path, symbol: item.arguments.name }] : [] });
    }
  }
  // Steps that never got a result belong to a turn that is still running, or that stopped.
  return items;
}

/** The session's cost so far, from the agents' own reports. */
const costOf = (items) => items.filter((i) => i.kind === "cost").reduce((sum, i) => sum + i.cost, 0);

/**
 * The session view and composer.
 * @param {object} deps
 * @param {(path: string, body: object) => Promise<object>} deps.write POSTs JSON; throws on an error.
 * @param {() => Promise<void>} deps.refresh Reloads the workflow state and redraws.
 * @param {(text: string, error?: boolean) => void} deps.notice Shows a short message.
 * @param {() => {anchor: object, sha: string}|null} deps.context The selection on the map.
 * @param {(job: string) => object|null} deps.using The device's agent choice for a job.
 * @param {(id: string) => Promise<void>} deps.openTask Opens a run in the Tasks view.
 * @param {(run: object, path?: string) => Promise<void>} deps.showOnMap Shows the session's
 *   branch on the map, at a file when `path` is given.
 * @param {(target: object) => Promise<void>} deps.openPlace Moves the map to a place that a
 *   message names (see `POST /api/references`), and keeps the session on screen.
 * @param {(body: object) => Promise<{references: object}>} deps.references Finds those places.
 * @param {() => boolean} deps.pointed True when the owner chose a place on the map since
 *   their last message (a reply then carries it as a pointer).
 * @param {() => void} deps.sent Called after a reply is sent.
 * @param {() => void} deps.back Returns to the Tasks list.
 */
export function createSession({ write, refresh, notice, context, using, openTask, showOnMap, openPlace, references, pointed = () => true, sent = () => {}, back }) {
  // The places that the names in a session's messages point at, for the current text.
  let places = { key: "", map: {} },
    findingPlaces = false;
  let draft = "",
    ending = false,
    denyNote = "",
    // The request last brought into view, so a redraw does not move the reader again.
    shownRequest = null;
  const action = (text, fn, primary = false, cls = "") => {
    const b = el("button", "btn" + (primary ? " primary" : "") + (cls ? " " + cls : ""), text);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        notice(e.message, true);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  const agentName = (r) => ({ claude: "Claude", codex: "Codex", openrouter: "OpenRouter" })[r.agent] || r.agent;
  const anchorLabel = (a) =>
    a.kind === "repo" ? "Repository" : [a.path?.split("/").pop(), a.symbol].filter(Boolean).join(" · ");

  /** The agent's request to run a command, with the owner's three answers. */
  function approvalCard(r) {
    const a = r.approval;
    const card = el("section", "session-approval");
    card.setAttribute("aria-label", "The agent asks to run a command");
    card.append(el("strong", "", a.tool === "Bash" ? "The agent asks to run a command" : `The agent asks to use ${a.tool}`));
    card.append(el("pre", "session-command", a.input));
    if (a.reason) card.append(el("p", "read-note", `Why: “${a.reason}”`));
    const words = a.input.trim().split(/\s+/);
    const twoWords = ["npm", "npx", "pnpm", "yarn", "bun", "cargo", "git", "go", "pip", "pip3", "uv", "poetry", "make", "docker", "python", "python3"];
    const rule = a.tool !== "Bash" ? a.tool : twoWords.includes(words[0]) && words[1] && !words[1].startsWith("-") ? words.slice(0, 2).join(" ") : words[0];
    const label = el("label", "workflow-field", "A note for the agent (optional)");
    const note = el("input");
    note.value = denyNote;
    note.setAttribute("aria-label", "A note for the agent");
    note.oninput = () => (denyNote = note.value);
    label.append(note);
    const decide = (decision) => async () => {
      await write(`/api/runs/${r.id}/approval`, { approval: a.id, decision, message: decision === "deny" ? denyNote : "" });
      denyNote = "";
      await refresh();
    };
    const buttons = el("div", "session-approval-actions");
    buttons.append(action("Allow once", decide("allow"), true));
    // A command with several parts has no safe rule: allow it once, or allow everything.
    if (a.tool !== "Bash" || !chained(a.input)) buttons.append(action(`Allow ${rule} in this session`, decide("session")));
    buttons.append(action("Allow all commands", decide("all")), action("Deny", decide("deny"), false, "danger"));
    card.append(buttons, label);
    // A new request comes into view once, from its top, so its command is visible.
    if (shownRequest !== a.id) {
      shownRequest = a.id;
      requestAnimationFrame(() => card.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
    return card;
  }

  /** One step: what the agent did, a mark for its result, and its output when opened. */
  function stepRow(step, r, index) {
    const row = el("details", "session-step" + (step.failed ? " failed" : ""));
    row.dataset.key = `step-${index}`;
    const summary = el("summary");
    const mark = el("span", "session-mark", step.done ? (step.failed ? "✗" : "✓") : "");
    if (!step.done && r.status === "running") mark.classList.add("is-running");
    summary.append(mark, el("span", "session-label", step.label));
    if (step.code) summary.append(el("code", "session-code", step.code));
    row.append(summary);
    if (step.note) row.append(el("p", "read-note", step.note));
    for (const path of [...new Set(step.changed.length ? step.changed : step.files)].filter(Boolean)) {
      const open = el("button", "link-button code-link", `Show ${path} on the map`);
      open.type = "button";
      open.onclick = () => showOnMap(r, path);
      row.append(open);
    }
    if (step.output?.trim()) row.append(el("pre", "taskpre session-output", step.output.trim().slice(-6000)));
    return row;
  }

  /** The Session view: the conversation, live state, and the session's actions. */
  function render(body, r) {
    const items = timeline(r.output || "");
    // One row that stays at the top: back, the title, the state, and Stop while it works.
    const head = el("div", "session-head");
    const backButton = iconButton(el("button", "session-icon"), "back", "Back to tasks");
    backButton.type = "button";
    backButton.onclick = back;
    const state = r.approval ? "Needs you" : r.status === "running" ? "Working" : live(r) ? "Your turn" : "Ended";
    const status = el("span", "session-status");
    status.dataset.state = r.approval ? "needs" : r.status;
    status.append(el("span", "session-dot"), document.createTextNode(state));
    head.append(backButton, el("h2", "session-title", r.title || "Session"), status);
    if (r.status === "running") {
      const stop = iconButton(el("button", "session-icon session-stop"), "stop", "Stop");
      stop.type = "button";
      stop.onclick = async () => {
        stop.disabled = true;
        try {
          await write(`/api/runs/${r.id}/cancel`, {});
          await refresh();
        } catch (e) {
          notice(e.message, true);
        } finally {
          stop.disabled = false;
        }
      };
      head.append(stop);
    }
    // The header sits above the scrolling conversation, not in it.
    const host = document.querySelector("#sessionHead");
    if (host) host.replaceChildren(head);
    else body.append(head);

    const log = conversation(r, items);
    if (r.approval) log.append(approvalCard(r));
    if (r.status === "running" && !r.approval) {
      const working = el("div", "session-working");
      const queued = (r.messages || []).filter((m) => !m.delivered).length;
      working.append(
        peek("working", { className: "session-working-peek" }),
        el("span", "pending-text", queued ? `Working · ${queued} message${queued === 1 ? "" : "s"} waiting for the next turn` : "Working"),
      );
      log.append(working);
    }
    if (r.message && r.status !== "running") log.append(el("p", "read-note", r.message));
    body.append(log);
    renderActions(body, r);
  }

  /** The conversation of a session: the owner's messages, the agent's text and steps. */
  function conversation(r, items = timeline(r.output || "")) {
    const log = el("div", "session-log");
    log.setAttribute("aria-label", "Session conversation");
    log.setAttribute("aria-live", "polite");
    // Names in backticks link to their place on the map, as in Ask.
    const words = items.filter((i) => i.kind === "text" || i.kind === "owner").map((i) => i.text).join("\n");
    const key = `${r.id}:${words.length}`;
    if (places.key !== key && !findingPlaces && words.includes("`")) {
      findingPlaces = true;
      const head = r.results?.length ? "refs/heads/" + r.branch : r.base;
      references({ base: r.base, head, about: r.comments?.[0]?.anchor?.path || "", text: words })
        .then((found) => (places = { key, map: found.references || {} }))
        .catch(() => (places = { key, map: places.map }))
        .finally(() => {
          findingPlaces = false;
          // A running session redraws at its next poll anyway.
          if (r.status !== "running") refresh();
        });
    }
    const linked = { links: places.map, onLink: (target) => openPlace(target) };
    const lastStep = r.status === "running" ? items.map((i) => i.kind).lastIndexOf("step") : -1;
    // Steps in a row form one compact list.
    let steps = null;
    items.forEach((item, index) => {
      if (item.kind !== "step") steps = null;
      if (item.kind === "owner") {
        const bubble = el("div", "session-owner");
        bubble.append(richText(item.text, "session-text", linked));
        const parts = item.anchors.filter((a) => a.kind !== "repo");
        if (parts.length) {
          // Where the owner pointed, as quiet text under the message.
          bubble.append(el("p", "session-anchors", "↳ " + parts.map(anchorLabel).join(", ")));
        }
        log.append(bubble);
      } else if (item.kind === "text") log.append(richText(item.text, "session-text session-agent", linked));
      else if (item.kind === "step") {
        if (!steps) {
          steps = el("div", "session-steps");
          log.append(steps);
        }
        const row = stepRow(item, r, index);
        // The step the agent takes now; the map marks its place.
        if (index === lastStep) row.classList.add("is-current");
        steps.append(row);
      }
      else if (item.kind === "error") log.append(el("p", "session-error", item.text));
      else if (item.kind === "end" && item.status === "cancelled") log.append(el("p", "read-note session-turn-end", "Stopped by you."));
      else if (item.kind === "end" && item.status === "failed") log.append(el("p", "session-error", "The agent's turn failed."));
    });
    return log;
  }

  /** Below the conversation: the session's details, then quiet links: its changes on the
   * map, how it treats commands, and End session. */
  function renderActions(body, r) {
    const cost = costOf(timeline(r.output || ""));
    body.append(
      el("p", "session-info", [agentName(r) + (r.model ? " · " + r.model : ""), `${r.turns || 0} turn${r.turns === 1 ? "" : "s"}`, `${r.results?.length || 0} commit${r.results?.length === 1 ? "" : "s"}`, cost ? `$${cost.toFixed(2)}` : ""].filter(Boolean).join(" · ")),
    );
    const links = el("div", "session-links");
    const link = (text, fn) => {
      const b = el("button", "link-button", text);
      b.type = "button";
      b.onclick = async () => {
        try {
          await fn();
        } catch (e) {
          notice(e.message, true);
        }
      };
      return b;
    };
    if (r.results?.length) links.append(link("Changes on the map", () => showOnMap(r)));
    // How the session treats commands; the next turn starts with the new choice.
    const all = r.permissions === "allow";
    const mode = link(all ? "Commands: all allowed" : "Commands: ask first", async () => {
      await write(`/api/runs/${r.id}/permissions`, { mode: all ? "ask" : "allow" });
      await refresh();
    });
    mode.setAttribute("aria-pressed", String(all));
    mode.title = all ? "Commands run with no question. Tap to ask before commands outside the list" : "Commands outside the list wait for you. Tap to allow all commands";
    if (all) mode.classList.add("is-open");
    links.append(mode);
    if (r.status === "waiting" && !ending)
      links.append(link("End session", () => {
        ending = true;
        return refresh();
      }));
    if (links.childElementCount) body.append(links);
    if (r.status === "waiting" && ending) body.append(endPanel(r));
  }

  /** Ending: send the branch to the normal review, end without review, or keep working. */
  function endPanel(r) {
    const panel = el("section", "session-end");
    panel.setAttribute("aria-label", "End the session");
    const commits = r.results?.length || 0;
    panel.append(
      el("p", "read-note", commits
        ? `${commits} commit${commits === 1 ? "" : "s"}. Send to review, then approve and merge into ${r.watched?.replace("refs/heads/", "") || "main"}. The conversation stays with the work.`
        : "The agent made no commit. Ask it to commit its work, or end without review."),
    );
    const review = action("Send to review", async () => {
      await write(`/api/runs/${r.id}/end`, { review: true });
      ending = false;
      await openTask(r.id);
    }, true);
    review.disabled = !commits;
    const keep = el("button", "link-button", "Keep working");
    keep.type = "button";
    keep.onclick = () => {
      ending = false;
      refresh();
    };
    const row = el("div", "session-end-actions");
    row.append(
      review,
      action("End without review", async () => {
        await write(`/api/runs/${r.id}/end`, { review: false });
        ending = false;
        await refresh();
      }),
      keep,
    );
    panel.append(row);
    return panel;
  }

  /** The dock's composer in Session mode: a reply to the open session, with the selection
   * on the map as a pointer, or the first message of a new session. */
  function renderComposer(host, current) {
    const here = context();
    const box = el("section", "composer");
    // Only a place the owner chose goes with a reply, not where Follow moved the map.
    const pointer = here && here.anchor.kind !== "repo" && pointed() ? here.anchor : null;
    box.append(el("p", "composer-anchor", current ? (pointer ? anchorLabel(pointer) : "") : here ? anchorLabel(here.anchor) : ""));
    const label = el("label", "workflow-field dock-input");
    const input = el("textarea");
    input.rows = 1;
    input.maxLength = 12000;
    input.value = draft;
    const name = current ? "Reply to the agent" : "What do you want to work on?";
    input.setAttribute("aria-label", name);
    input.placeholder = current
      ? current.status === "running"
        ? "Steer the agent: it reads this after its current turn"
        : "Reply to the agent"
      : "What do you want to work on?";
    input.oninput = () => {
      draft = input.value;
      send.disabled = !draft.trim();
    };
    label.append(input);
    box.append(label);
    const buttons = el("div", "sel-acts draft-buttons");
    let permissions = savedPermissions();
    if (!current) {
      const mode = el("button", "btn session-mode", "");
      mode.type = "button";
      const show = () => {
        mode.textContent = permissions === "allow" ? "Allow all commands" : "Ask before commands";
        mode.setAttribute("aria-pressed", String(permissions === "allow"));
        mode.classList.toggle("is-open", permissions === "allow");
        mode.title = permissions === "allow" ? "The agent runs any command with no question" : "Commands outside the usual checks wait for you";
      };
      mode.onclick = () => {
        permissions = permissions === "allow" ? "ask" : "allow";
        savePermissions(permissions);
        show();
      };
      show();
      buttons.append(mode);
    }
    const send = action(current ? "Send" : "Start session", async () => {
      if (current) {
        await write(`/api/runs/${current.id}/message`, { text: draft, anchors: pointer ? [pointer] : [] });
        draft = "";
        sent();
        await refresh();
        return;
      }
      if (!here) throw Error("Select a part of the map first");
      const started = await write("/api/runs/session", { ...here, text: draft, using: using("task"), permissions });
      draft = "";
      await openTask(started.id);
    }, true);
    iconButton(send, current ? "send" : "check", current ? "Send to the agent" : "Start session");
    send.classList.add("icon-action");
    send.disabled = !draft.trim();
    buttons.append(send);
    box.append(buttons);
    host.append(box);
  }

  return { render, renderComposer, conversation };
}
