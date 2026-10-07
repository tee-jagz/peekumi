/**
 * @module Proposed fixes: the page that turns the dependency-rule breaks at the map's commit
 * into instructions for an agent.
 *
 * Peekumi groups the breaks first (`GET /api/fixes?head=`): one group for each rule and each
 * declaration that the breaks reach. Then the agent that the owner chose for Ask reads the
 * code, with those groups as its context, and proposes the fixes
 * (`POST /api/fixes/propose`). While it works, the groups show as context. If the agent
 * fails, the owner can try again, or use Peekumi's groups as the proposals.
 *
 * The owner selects fixes (all at first), edits their text and clears the ones to leave out.
 * One button saves the selected fixes as draft instructions and opens the task form with them
 * selected (a batch of fixes in one task); another only saves them. A drafted fix is not
 * drafted again.
 */
import { peek } from "./peek.js";

/** Makes the page. `api(route, options)` reads JSON; `write(route, body)` posts it;
 * `head(title, {meta})` draws the page's header row; `revision()` is the map's head commit;
 * `using()` and `agentName()` are the Ask agent's choice and name; `send(ids)` opens the task
 * form with the draft instructions `ids` selected; `saved(n)` tells the owner that `n` drafts
 * were saved; `redraw()` draws the page again. */
export function createFixes({
  api,
  write,
  head,
  revision,
  using,
  agentName,
  send,
  saved,
  redraw,
}) {
  // One commit's state: Peekumi's groups, the agent's proposal, and which list shows.
  let shown = null;
  // The owner's choice and text for each proposal, and the fixes already drafted, by key.
  const choices = new Map(),
    drafted = new Set();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const plural = (n, word) =>
    `${n} ${n === 1 ? word : word.endsWith("x") ? word + "es" : word + "s"}`;

  function load(commit) {
    shown = {
      commit,
      groups: null,
      state: null,
      error: "",
      agent: { status: "idle", fixes: [], provider: "", error: "" },
      mode: "agent",
    };
    api("/api/fixes?head=" + encodeURIComponent(commit))
      .then((data) => {
        if (shown.commit !== commit) return;
        shown.groups = data.fixes;
        shown.state = data.checks?.state;
        if (shown.groups.length) propose();
        else redraw();
      })
      .catch((error) => {
        if (shown.commit !== commit) return;
        shown.error = error.message;
        redraw();
      });
  }

  /** Asks the agent for proposals; Peekumi's groups go with the request as context. */
  function propose() {
    const commit = shown.commit;
    shown.mode = "agent";
    shown.agent = { status: "running", fixes: [], provider: "", error: "" };
    redraw();
    api("/api/fixes/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: commit, using: using() }),
    })
      .then((data) => {
        if (shown.commit !== commit) return;
        shown.agent = {
          status: "done",
          fixes: data.fixes,
          provider: data.provider || "",
          error: "",
        };
        for (const fix of data.fixes)
          choices.set(`${commit}:a:${fix.id}`, {
            selected: true,
            text: fix.text,
          });
        redraw();
      })
      .catch((error) => {
        if (shown.commit !== commit) return;
        shown.agent = {
          status: "failed",
          fixes: [],
          provider: "",
          error: error.message,
        };
        redraw();
      });
  }

  /** Uses Peekumi's own groups as the proposals. */
  function usePeekumi() {
    shown.mode = "peekumi";
    for (const group of shown.groups)
      if (!choices.has(`${shown.commit}:p:${group.id}`))
        choices.set(`${shown.commit}:p:${group.id}`, {
          selected: true,
          text: group.text,
        });
    redraw();
  }

  /** The proposals in the list that shows: `{key, title, line, anchor}`. */
  function items() {
    if (shown.mode === "peekumi")
      return shown.groups.map((g) => ({
        key: `${shown.commit}:p:${g.id}`,
        title: g.target.symbol
          ? `${g.target.symbol} in ${g.target.path.split("/").pop()}`
          : g.target.path,
        line: `${g.rule} · ${plural(g.count, "break")} from ${plural(g.sources.length, "file")}`,
        anchor: g.anchor,
      }));
    return shown.agent.fixes.map((f) => ({
      key: `${shown.commit}:a:${f.id}`,
      title: f.title,
      line: [
        f.rules.join(", "),
        plural(f.count, "break"),
        ...(f.files.length ? [f.files.join(", ")] : []),
      ].join(" · "),
      anchor: f.anchor,
    }));
  }

  /** The selected proposals that are not drafted yet. */
  const picked = () =>
    items().filter(
      (item) => choices.get(item.key)?.selected && !drafted.has(item.key),
    );

  /** Saves the selected proposals as draft instructions; returns their IDs. */
  async function draft() {
    const ids = [];
    for (const item of picked()) {
      const comment = await write("/api/comments", {
        anchor: item.anchor,
        sha: shown.commit,
        text: choices.get(item.key).text.trim(),
      });
      drafted.add(item.key);
      choices.get(item.key).selected = false;
      ids.push(comment.id);
    }
    return ids;
  }

  /** What Peekumi found, as plain lines: the agent's context, and the fallback. */
  function context(open) {
    const box = el("details", "fix-context");
    box.open = open;
    box.append(
      el(
        "summary",
        "",
        `What Peekumi found (${plural(shown.groups.length, "place")})`,
      ),
    );
    for (const g of shown.groups) {
      const target = g.target.symbol
        ? `${g.target.symbol} in ${g.target.path}`
        : g.target.path;
      box.append(
        el(
          "p",
          "fix-context-row",
          `${target} · ${g.rule} · ${plural(g.count, "break")} from ${g.sources.join(", ")}`,
        ),
      );
    }
    return box;
  }

  /** Draws the page in `body`. */
  function render(body) {
    const commit = revision();
    if (shown?.commit !== commit) load(commit);
    const breaks = (shown.groups || []).reduce((sum, g) => sum + g.count, 0);
    head("Proposed fixes", {
      meta: shown.groups?.length
        ? `${plural(breaks, "rule break")} in ${plural(shown.groups.length, "place")}`
        : "",
    });
    if (shown.error) return body.append(el("p", "rule-error", shown.error));
    if (!shown.groups)
      return body.append(el("p", "read-note", "Reading the rule breaks…"));
    if (shown.state !== "evaluated")
      return body.append(
        el(
          "p",
          "read-note",
          shown.state === "invalid"
            ? "The rule configuration (.peekumi.json) is invalid. Fix it first."
            : "This repository has no dependency rules (.peekumi.json).",
        ),
      );
    if (!shown.groups.length)
      return body.append(
        el("p", "read-note", "No rule breaks at this commit. Nothing to fix."),
      );

    const agent = shown.agent;
    if (shown.mode === "agent" && agent.status === "running") {
      const working = el("div", "fix-working");
      working.append(
        peek("thinking", { className: "fix-peek" }),
        el(
          "p",
          "",
          `${agentName() || "The agent"} reads the code and proposes fixes. This can take a minute or two.`,
        ),
      );
      return body.append(working, context(true));
    }
    if (shown.mode === "agent" && agent.status === "failed") {
      const tryAgain = el("button", "btn primary", "Try again"),
        fallback = el("button", "btn", "Use Peekumi's own proposals");
      tryAgain.type = fallback.type = "button";
      tryAgain.onclick = propose;
      fallback.onclick = usePeekumi;
      const buttons = el("div", "sel-acts fix-buttons");
      buttons.append(tryAgain, fallback);
      return body.append(
        el(
          "p",
          "rule-error",
          `The agent could not propose fixes: ${agent.error}`,
        ),
        buttons,
        context(true),
      );
    }

    body.append(
      el(
        "p",
        "read-note",
        shown.mode === "agent"
          ? `${agent.provider} read the code and proposed these fixes. Select the fixes to make, edit their text, then send them together as one task.`
          : "Peekumi's own proposals, one for each place. Select the fixes to make, edit their text, then send them together as one task.",
      ),
    );
    const list = el("div", "fix-list");
    // The buttons count the selection; a change to it updates them in place, so the text box
    // that the owner types in keeps its focus.
    const sendButton = el("button", "btn primary"),
      saveButton = el("button", "btn");
    const update = () => {
      const n = picked().length;
      sendButton.textContent = `Send ${plural(n, "fix")} to an agent`;
      saveButton.textContent = "Save as drafts";
      sendButton.disabled = saveButton.disabled = !n;
    };
    for (const item of items()) {
      const choice = choices.get(item.key);
      const done = drafted.has(item.key);
      const row = el("div", "fix-row" + (done ? " is-drafted" : ""));
      const label = el("label", "fix-head");
      const check = el("input");
      check.type = "checkbox";
      check.checked = choice.selected && !done;
      check.disabled = done;
      check.onchange = () => {
        choice.selected = check.checked;
        update();
      };
      const title = el("span", "fix-title");
      title.append(
        el("strong", "", item.title),
        el("small", "", item.line + (done ? " · drafted" : "")),
      );
      label.append(check, title);
      const text = el("textarea", "fix-text");
      text.value = choice.text;
      text.rows = 5;
      text.disabled = done;
      text.setAttribute("aria-label", `Instruction for ${item.title}`);
      text.oninput = () => (choice.text = text.value);
      row.append(label, text);
      list.append(row);
    }
    sendButton.type = saveButton.type = "button";
    sendButton.onclick = async () => {
      sendButton.disabled = true;
      send(await draft());
    };
    saveButton.onclick = async () => {
      saveButton.disabled = true;
      const ids = await draft();
      saved(ids.length);
      redraw();
    };
    const buttons = el("div", "sel-acts fix-buttons");
    buttons.append(sendButton, saveButton);
    update();
    const other = el(
      "button",
      "link-button fix-other",
      shown.mode === "agent" ? "Propose again ›" : "Ask the agent instead ›",
    );
    other.type = "button";
    other.onclick = propose;
    body.append(list, buttons, other, context(false));
  }

  return { render };
}
