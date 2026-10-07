/**
 * @module Proposed fixes: the page that turns the dependency-rule breaks at the map's commit
 * into instructions for an agent.
 *
 * The server proposes the fixes (`GET /api/fixes?head=`): the breaks grouped by the rule and
 * the declaration they reach, each with an instruction text. On this page the owner selects
 * fixes (all at first), edits their text and clears the ones to leave out. Then one button
 * saves the selected fixes as draft instructions and opens the task form with them selected
 * (a batch of fixes in one task), and another only saves them. A fix that became a draft
 * shows as drafted, so a second visit does not draft it again.
 */

/** Makes the page. `api` reads JSON; `write(route, body)` posts it and returns the reply;
 * `head(title, {meta})` draws the page's header row; `revision()` is the map's head commit;
 * `send(ids)` opens the task form with the draft instructions `ids` selected; `saved(n)`
 * tells the owner that `n` drafts were saved; `redraw()` draws the page again. */
export function createFixes({
  api,
  write,
  head,
  revision,
  send,
  saved,
  redraw,
}) {
  // The fixes of one commit: its data, and the owner's choice and text for each fix.
  let shown = { commit: null, data: null, loading: false, error: "" };
  const choices = new Map(),
    drafted = new Map();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const plural = (n, word) =>
    `${n} ${n === 1 ? word : word.endsWith("x") ? word + "es" : word + "s"}`;

  function load(commit) {
    shown = { commit, data: null, loading: true, error: "" };
    choices.clear();
    api("/api/fixes?head=" + encodeURIComponent(commit))
      .then((data) => {
        if (shown.commit !== commit) return;
        shown = { commit, data, loading: false, error: "" };
        for (const fix of data.fixes)
          choices.set(fix.id, {
            selected: !drafted.has(`${commit}:${fix.id}`),
            text: fix.text,
          });
        redraw();
      })
      .catch((error) => {
        if (shown.commit !== commit) return;
        shown = { commit, data: null, loading: false, error: error.message };
        redraw();
      });
  }

  /** The selected fixes that are not drafted yet. */
  const picked = () =>
    (shown.data?.fixes || []).filter(
      (fix) =>
        choices.get(fix.id)?.selected &&
        !drafted.has(`${shown.commit}:${fix.id}`),
    );

  /** Saves the selected fixes as draft instructions; returns their IDs. */
  async function draft() {
    const ids = [];
    for (const fix of picked()) {
      const comment = await write("/api/comments", {
        anchor: fix.anchor,
        sha: shown.commit,
        text: choices.get(fix.id).text.trim(),
      });
      drafted.set(`${shown.commit}:${fix.id}`, comment.id);
      choices.get(fix.id).selected = false;
      ids.push(comment.id);
    }
    return ids;
  }

  /** Draws the page in `body`. */
  function render(body) {
    const commit = revision();
    if (shown.commit !== commit) load(commit);
    const fixes = shown.data?.fixes || [];
    const breaks = fixes.reduce((sum, fix) => sum + fix.count, 0);
    head("Proposed fixes", {
      meta: shown.data
        ? `${plural(fixes.length, "fix")} for ${plural(breaks, "rule break")}`
        : "",
    });
    if (shown.loading)
      return body.append(el("p", "read-note", "Reading the rule breaks…"));
    if (shown.error) return body.append(el("p", "rule-error", shown.error));
    const state = shown.data.checks?.state;
    if (state !== "evaluated")
      return body.append(
        el(
          "p",
          "read-note",
          state === "invalid"
            ? "The rule configuration (.peekumi.json) is invalid. Fix it first."
            : "This repository has no dependency rules (.peekumi.json).",
        ),
      );
    if (!fixes.length)
      return body.append(
        el("p", "read-note", "No rule breaks at this commit. Nothing to fix."),
      );
    body.append(
      el(
        "p",
        "read-note",
        "Each fix is an instruction for an agent. Select the fixes to make, edit their text, then send them together as one task.",
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
    for (const fix of fixes) {
      const choice = choices.get(fix.id);
      const done = drafted.has(`${shown.commit}:${fix.id}`);
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
      const target = fix.target.symbol
        ? `${fix.target.symbol} in ${fix.target.path.split("/").pop()}`
        : fix.target.path;
      title.append(
        el("strong", "", target),
        el(
          "small",
          "",
          `${fix.rule} · ${plural(fix.count, "break")} from ${plural(fix.sources.length, "file")}${done ? " · drafted" : ""}`,
        ),
      );
      label.append(check, title);
      const text = el("textarea", "fix-text");
      text.value = choice.text;
      text.rows = 4;
      text.disabled = done;
      text.setAttribute("aria-label", `Instruction for ${target}`);
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
    body.append(list, buttons);
  }

  return { render };
}
