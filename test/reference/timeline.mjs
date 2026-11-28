/** @module A frozen copy of the session timeline parser that frontend/session.js used before
 * the server read conversations (backend/conversation.rs). The conversation test compares the
 * server's items with this parser on the same logs, so the move changes nothing that the app
 * shows. Do not change it to make a test pass. */
/** A path inside the session's worktree, relative to the repository. */
const relative = (path = "") =>
  path.includes("/worktree/") ? path.split("/worktree/").pop() : path;
const fileName = (path = "") => relative(path).split("/").pop();

/** File and folder paths named in a command or a search, relative to the repository: what
 * the agent looks at when it runs `sed -n 1,40p backend/lookup.rs` or `grep -rn x backend/`.
 * Options, variables, URLs, globs and paths outside the worktree are left out. */
function pathsIn(text = "") {
  const found = [];
  for (const raw of String(text).split(/[\s'"`;|&()<>=,]+/)) {
    let token = relative(raw)
      .replace(/^\.\//, "")
      .replace(/:\d+(:\d+)?$/, "")
      .replace(/[:,.]$/, "");
    // `backend/` names a folder.
    const folder = /^[\w.-]+\/$/.test(token);
    token = token.replace(/\/$/, "");
    if (
      !token ||
      token.length > 200 ||
      /^[-$~/]/.test(token) ||
      token.includes("://") ||
      token.includes("..") ||
      /[*?{}[\]\\]/.test(token)
    )
      continue;
    if (
      !folder &&
      !token.includes("/") &&
      !/^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(token)
    )
      continue;
    if (/^\d+(\.\d+)+$/.test(token)) continue;
    found.push(token);
  }
  return [...new Set(found)].slice(0, 4);
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
  const step = {
    kind: "step",
    id: part.id,
    files: [],
    changed: [],
    targets: [],
  };
  const file = relative(input.file_path || input.notebook_path || "");
  const at = (paths) => paths.filter(Boolean).map((path) => ({ path }));
  switch (part.name) {
    case "Read":
      return {
        ...step,
        activity: "reading",
        label: `Read ${fileName(file)}`,
        files: [file],
        targets: at([file]),
      };
    case "Edit":
    case "MultiEdit":
      return {
        ...step,
        activity: "editing",
        label: `Edited ${fileName(file)}`,
        files: [file],
        changed: [file],
        targets: at([file]),
      };
    case "Write":
      return {
        ...step,
        activity: "creating",
        label: `Wrote ${fileName(file)}`,
        files: [file],
        changed: [file],
        targets: at([file]),
      };
    case "Bash":
      return {
        ...step,
        activity: "running",
        label: "Ran",
        code: input.command,
        note: input.description,
        targets: at(pathsIn(input.command)),
      };
    case "Glob":
      return {
        ...step,
        activity: "searching",
        label: "Listed files",
        code: input.pattern,
        targets: at(pathsIn(input.path)),
      };
    case "Grep":
      return {
        ...step,
        activity: "searching",
        label: "Searched",
        code: input.pattern,
        targets: at(pathsIn(input.path)),
      };
    case "TodoWrite":
    case "mcp__peekumi__get_run":
      return null;
  }
  if (part.name.startsWith("mcp__peekumi_graph__")) {
    const tool = part.name.slice("mcp__peekumi_graph__".length);
    const target =
      input.to?.name ||
      input.name ||
      input.query ||
      input.text ||
      input.path ||
      "";
    const path = input.path || input.to?.path;
    // A map lookup names the file and, often, the declaration: that is where the agent looks.
    const targets = [
      input.from,
      input.to,
      input.path ? { path: input.path, name: input.name } : null,
    ]
      .filter((t) => t?.path)
      .map((t) => ({ path: t.path, symbol: t.name || undefined }));
    return {
      ...step,
      activity: "reading",
      label: `Map · ${tool}`,
      code: target,
      files: path ? [path] : [],
      targets,
    };
  }
  return { ...step, label: part.name };
}

/** Reads a session log into a timeline: the owner's messages, the agent's text, its steps
 * with their output, the end of each turn, Peekumi's rule check after it, and errors. It reads Claude Code's stream-json,
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
        items.push({
          kind: "owner",
          text: m.text,
          anchors: m.anchors || [],
          turn: event.turn,
        });
      continue;
    }
    if (event.type === "peekumi.turn") {
      items.push({ kind: "end", status: event.status, turn: event.turn });
      continue;
    }
    // Peekumi's own rule check at the end of a turn (backend/runner.rs).
    if (event.type === "peekumi.rules") {
      items.push({ kind: "rules", check: event.check || {}, turn: event.turn });
      continue;
    }
    if (
      event.type === "peekumi.error" ||
      (event.type === "error" && event.message)
    ) {
      items.push({ kind: "error", text: event.message });
      continue;
    }
    // Claude Code.
    if (event.type === "assistant")
      for (const part of event.message?.content || []) {
        if (part.type === "text" && part.text?.trim())
          items.push({ kind: "text", text: part.text });
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
        // A Write over a file that exists edits it (Claude Code says "updated").
        if (step.activity === "creating" && /\bupdated\b/i.test(step.output))
          step.activity = "editing";
        step.done = true;
      }
    if (event.type === "result" && event.is_error)
      items.push({
        kind: "error",
        text: event.result || "The agent stopped with an error.",
      });
    if (event.type === "result")
      items.push({ kind: "cost", cost: event.total_cost_usd || 0 });
    // Codex (item.completed) and Peekumi's own agent (an item alone).
    const item = event.item;
    if (item && (event.type === "item.completed" || !event.type)) {
      if (item.type === "agent_message" && item.text?.trim())
        items.push({ kind: "text", text: item.text });
      else if (item.type === "command_execution") {
        const command = String(item.command || "").replace(
          /^\/bin\/\w+ -lc '(.*)'$/s,
          "$1",
        );
        items.push({
          kind: "step",
          activity: "running",
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
        const paths = item.changes
          ? item.changes.map((c) => relative(c.path))
          : [relative(item.path)];
        const failed = item.status === "failed";
        items.push({
          kind: "step",
          // Only new files: creating. Any other change: editing.
          activity: item.changes?.every((c) => c.kind === "add")
            ? "creating"
            : "editing",
          label: `${failed ? "Could not change" : "Changed"} ${paths.map(fileName).join(", ")}`,
          files: paths,
          changed: failed ? [] : paths,
          targets: paths.map((path) => ({ path })),
          done: true,
          failed,
        });
      } else if (
        item.type === "mcp_tool_call" &&
        item.server === "peekumi_graph"
      )
        items.push({
          kind: "step",
          activity: "reading",
          label: `Map · ${item.tool}`,
          done: true,
          files: [],
          changed: [],
          targets: item.arguments?.path
            ? [{ path: item.arguments.path, symbol: item.arguments.name }]
            : [],
        });
    }
  }
  // Steps that never got a result belong to a turn that is still running, or that stopped.
  return items;
}

