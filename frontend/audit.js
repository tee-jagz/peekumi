/**
 * @module Proposed rules: an agent audits the repository's architecture and proposes
 * dependency rules for the rule engine, so the design stays true while the repository grows.
 *
 * The agent that the owner chose for Ask gets a high-level view first (the map of folders and
 * files, the folder descriptions, the dependency cycles now and the current `.peekumi.json`),
 * then reads the code through read-only lookups. It gets each rule from the job of each part
 * and an engineering principle, not from the imports that exist now, so it does not copy the
 * mistakes in the code.
 *
 * The audit runs on the server in the background (`POST /api/rules/propose`): the owner can
 * leave the page, and a notification says when the rules are ready. Each audit adds to a saved
 * list and replaces nothing; a check that an earlier audit proposed counts once. The list
 * (`GET /api/rules/audit?head=`) tries each rule at the map's commit: what it checks, what it
 * cannot check (unresolved relationships), its breaks now and warnings.
 *
 * The rules show under their principles, not selected at first. The owner's selection stays on
 * the server (`PATCH /api/rules/audit/<id>`), also after the next audit. An edit
 * is tried again (`POST /api/rules/check`). One button saves each selected rule as a draft
 * instruction on the rule file and opens the task form with them, so an agent adds them in its
 * own worktree, for the normal review. Another button only saves the drafts.
 */
import { peek } from "./peek.js";

/** Makes the page. `api(route, options)` reads JSON; `write(route, body)` posts it;
 * `head(title, {meta})` draws the page's header row; `revision()` is the map's head commit;
 * `using()` and `agentName()` are the Ask agent's choice and name; `send(ids)` opens the task
 * form with the draft instructions `ids` selected; `saved(n)` tells the owner that `n` drafts
 * were saved; `redraw()` draws the page again; `showing()` is true while the page is open. */
export function createAudit({
  api,
  write,
  head,
  revision,
  using,
  agentName,
  send,
  saved,
  redraw,
  showing = () => true,
}) {
  // The saved list at one commit, and the owner's edits for each rule by ID.
  let shown = null,
    polling = false;
  const edits = new Map();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const plural = (n, word) => `${n} ${n === 1 ? word : word + "s"}`;
  const sendJson = (route, body, method = "POST") =>
    api(route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Reads the saved list at `commit`. The first visit starts the first audit. */
  async function load(commit, { first = false } = {}) {
    try {
      const data = await api(
        "/api/rules/audit?head=" + encodeURIComponent(commit),
      );
      if (shown?.commit !== commit) return;
      shown.data = data;
      shown.error = "";
      if (first && !data.running && !data.lastRun && !data.rules.length)
        return start(commit);
      if (data.running) poll(commit);
    } catch (error) {
      if (shown?.commit === commit) shown.error = error.message;
    }
    redraw();
  }

  /** Reads the list again every three seconds while an audit runs and the page is open. */
  function poll(commit) {
    if (polling) return;
    polling = true;
    setTimeout(async () => {
      polling = false;
      if (shown?.commit === commit && showing()) await load(commit);
    }, 3000);
  }

  /** Starts an audit at `commit`; its rules join the list when it ends. */
  async function start(commit) {
    try {
      await sendJson("/api/rules/propose", { head: commit, using: using() });
      shown.data = {
        ...(shown.data || { rules: [], dropped: [] }),
        running: {},
        error: null,
      };
      poll(commit);
    } catch (error) {
      shown.error = error.message;
    }
    redraw();
  }

  /** The owner's edit of rule `r`, or its saved text: `{text, trial, error}`. The groups are
   * the ones that the rule uses now (a group in the rule file keeps the file's patterns). */
  function editOf(r) {
    if (!edits.has(r.id))
      edits.set(r.id, {
        text: JSON.stringify(
          { groups: r.trial?.groups || r.groups, rule: r.rule },
          null,
          2,
        ),
        trial: null,
        error: "",
      });
    return edits.get(r.id);
  }

  /** Tries the edited text of rule `r` again. */
  async function check(r) {
    const edit = editOf(r);
    let parsed;
    try {
      parsed = JSON.parse(edit.text);
    } catch {
      edit.error = "The rule is not valid JSON.";
      return redraw();
    }
    try {
      edit.trial = await sendJson("/api/rules/check", {
        head: shown.commit,
        groups: parsed.groups,
        rule: parsed.rule,
      });
      edit.error = "";
    } catch (error) {
      edit.error = error.message;
    }
    redraw();
  }

  /** Keeps the owner's choice for rule `r` on the server. */
  function mark(r, status) {
    r.status = status;
    sendJson(`/api/rules/audit/${r.id}`, { status }, "PATCH").catch((error) => {
      shown.error = error.message;
      redraw();
    });
  }

  const usable = (r) => !r.problem && !editOf(r).error;
  /** The selected rules that can go to an agent. A rule that another rule covers goes with
   * that rule. */
  const picked = () =>
    (shown.data?.rules || []).filter(
      (r) => r.status === "selected" && usable(r) && !r.partOf,
    );
  /** Files in words: "frontend/" for "frontend/**", "a.js, b.js and 7 more in frontend/" for
   * files in one folder, or the first names and how many more. */
  function describe(patterns = []) {
    const names = patterns.map((p) => p.replace(/\/\*\*$/, "/"));
    const list = (items) =>
      items.length <= 3
        ? items.length > 1
          ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
          : items[0] || ""
        : `${items.slice(0, 2).join(", ")} and ${items.length - 2} more`;
    const folders = new Set(
      names.map((n) =>
        /[*?]|\/$/.test(n) ? null : n.slice(0, n.lastIndexOf("/")),
      ),
    );
    const [folder] = folders;
    if (names.length > 1 && folders.size === 1 && folder)
      return `${list(names.map((n) => n.slice(folder.length + 1)))} in ${folder}/`;
    return list(names);
  }
  /** The rule in one plain sentence: the agent's sentence, or one that Peekumi makes from the
   * rule and its groups (for rules from before the agent wrote one). */
  function plainOf(r) {
    if (r.plain) return r.plain;
    const groups = r.trial?.groups || r.groups || {};
    const rule = r.rule;
    // The files of one or more groups, as one list.
    const files = (...names) => describe(names.flatMap((n) => groups[n] || []));
    if (rule.layers)
      return `${rule.layers.map((l) => files(l)).join(" → ")}: a lower part must not use a part above it`;
    if (rule.only)
      return `${files(rule.from)} may use only ${files(...rule.only)}`;
    if (rule.to?.length === 1 && rule.to[0] === rule.from)
      return `${files(rule.from)} must not use each other`;
    return `${files(rule.from)} must not use ${files(...rule.to)}`;
  }
  // The order of values: the most valuable rules come first in each section.
  const rank = { high: 0, medium: 1, low: 2 };

  /** The instruction that adds one rule to the rule file. */
  function instruction(r, edited) {
    const data = shown.data;
    const file = data.configFile || ".peekumi.json";
    return [
      data.configured
        ? `Add the dependency rule "${edited.rule.id}" to ${file}.`
        : `Create ${file} at the repository root with {"version": 1, "groups": {}, "rules": []} if it does not exist. Then add the dependency rule "${edited.rule.id}" to it.`,
      `The rule: ${plainOf(r)}`,
      `Principle: ${r.principle}. ${r.why}`,
      "Add these groups if the file does not have them, with exactly these patterns:",
      "```json\n" + JSON.stringify(edited.groups, null, 2) + "\n```",
      "Add this rule to the rules list:",
      "```json\n" + JSON.stringify(edited.rule, null, 2) + "\n```",
      "Keep the other groups and rules as they are, and keep version 1. Do not change code to remove the breaks of this rule: the owner fixes them later.",
    ].join("\n\n");
  }

  /** Saves the selected rules as draft instructions on the rule file; returns their IDs. */
  async function draft() {
    const ids = [];
    const data = shown.data;
    const anchor = data.configured
      ? { kind: "file", path: data.configFile }
      : { kind: "repo", path: "" };
    for (const r of picked()) {
      const comment = await write("/api/comments", {
        anchor,
        sha: shown.commit,
        text: instruction(r, JSON.parse(editOf(r).text)),
      });
      mark(r, "drafted");
      ids.push(comment.id);
    }
    return ids;
  }

  /** One rule: its choice, its plain sentence, its numbers, why, the breaks now with the
   * agent's view of them, the rules that it covers and the rule to edit. `fresh` marks a rule
   * that the last audit added to a list from earlier audits; `parts` are the rules in the list
   * that it covers. */
  function row(r, update, fresh, parts = []) {
    const edit = editOf(r);
    const trial = edit.trial || r.trial || {};
    const done = r.status === "drafted" || r.added;
    const box = el("div", "fix-row audit-row" + (done ? " is-drafted" : ""));
    const label = el("label", "fix-head");
    const tick = el("input");
    tick.type = "checkbox";
    tick.checked = r.status === "selected" && usable(r);
    tick.disabled = done || !usable(r);
    tick.onchange = () => {
      mark(r, tick.checked ? "selected" : "proposed");
      update();
    };
    const id = r.rule.id;
    // What the rule checks now, and what it cannot check: a relationship that the engine
    // cannot resolve can never break a rule, so "no break" is only as good as this number.
    const numbers = r.added
      ? ["already in the rule file"]
      : r.problem
        ? ["refused now"]
        : [
            trial.checked
              ? `checks ${plural(trial.checked, "relationship")}`
              : "checks nothing now",
            ...(trial.unresolved ? [`cannot check ${trial.unresolved}`] : []),
            trial.broke
              ? `${plural(trial.broke, "break")} now`
              : "no break now",
          ];
    const title = el("span", "fix-title");
    title.append(
      el("strong", "", plainOf(r)),
      el(
        "small",
        "",
        [
          r.principle,
          ...(r.value ? [`${r.value} value`] : []),
          ...numbers,
          ...(fresh ? ["new"] : []),
          ...(r.status === "drafted" ? ["drafted"] : []),
        ].join(" · "),
      ),
    );
    label.append(tick, title);
    box.append(label, el("p", "audit-why", r.why));
    // The agent's view of the breaks now: on purpose or a mistake, and the cost of a fix. It
    // shows only when Peekumi measured a break.
    if (trial.broke && r.now) box.append(el("p", "audit-now", `Now: ${r.now}`));
    if (r.problem)
      box.append(el("p", r.added ? "rule-coverage" : "rule-error", r.problem));
    for (const warning of trial.warnings || [])
      box.append(el("p", "rule-warning", warning));
    for (const b of (trial.examples || []).slice(0, 3))
      box.append(
        el("p", "rule-added", `${b.source} → ${b.target} (${b.kind})`),
      );
    if (trial.broke > 3)
      box.append(el("p", "rule-coverage", `${trial.broke - 3} more breaks`));
    if (parts.length)
      box.append(
        el("p", "audit-parts", `Also covers: ${parts.map(plainOf).join("; ")}`),
      );
    if (edit.error) box.append(el("p", "rule-error", edit.error));
    if (!done) {
      const details = el("details", "audit-edit");
      details.open = !!edit.error;
      details.append(el("summary", "", "Edit rule"));
      const text = el("textarea", "fix-text audit-text");
      text.value = edit.text;
      text.rows = 10;
      text.spellcheck = false;
      text.setAttribute("aria-label", `Rule ${id}`);
      text.oninput = () => (edit.text = text.value);
      // Leaving the box tries the rule again, when its text changed.
      text.onchange = () => check(r);
      details.append(text);
      box.append(details);
    }
    return box;
  }

  /** Draws the page in `body`. */
  function render(body) {
    const commit = revision();
    if (shown?.commit !== commit) {
      shown = { commit, data: null, error: "" };
      load(commit, { first: true });
    }
    const data = shown.data;
    // Back on the page while an audit runs: read the list again until it ends.
    if (data?.running) poll(commit);
    const rules = data?.rules || [];
    // Each idea once: a rule that another rule covers shows under that rule.
    const ids = new Set(rules.map((r) => r.id));
    const roots = rules.filter((r) => !r.partOf || !ids.has(r.partOf));
    const breaking = (r) => !r.problem && (r.trial?.broke || 0) > 0;
    head("Proposed rules", {
      meta: roots.length
        ? `${plural(roots.length, "rule")} · ${roots.filter(breaking).length} find a problem now`
        : "",
    });
    if (shown.error) body.append(el("p", "rule-error", shown.error));
    if (!data) return body.append(el("p", "read-note", "Reading the list…"));
    if (data.running) {
      const working = el("div", "fix-working");
      working.append(
        peek("thinking", { className: "fix-peek" }),
        el(
          "p",
          "",
          `${agentName() || "The agent"} reads the architecture and the code, then proposes rules. This can take a few minutes. You can leave this page: Peekumi tells you when the rules are ready, if notifications are on.`,
        ),
      );
      body.append(working);
    } else if (data.error)
      body.append(
        el("p", "rule-error", `The last audit failed: ${data.error}`),
      );
    // An audit can find that nothing is missing: that is a good result, not an error.
    if (!data.running && !data.error && data.lastRun && data.lastAdded === 0)
      body.append(
        el(
          "p",
          "read-note audit-none",
          "The last audit found no missing rule. The current rules are enough.",
        ),
      );
    if (!rules.length && !data.running) {
      const first = el(
        "button",
        "btn primary",
        data.lastRun ? "Audit again" : "Audit the architecture",
      );
      first.type = "button";
      first.onclick = () => start(commit);
      return body.append(first);
    }
    if (rules.length)
      body.append(
        el(
          "p",
          "read-note",
          `${data.provider || "The agent"} proposed these rules from the architecture, not from the imports that exist now. Each rule says which files must not use which. Select the rules to add; your selection stays. "Cannot check" counts relationships that Peekumi cannot resolve: they never break a rule.`,
        ),
      );
    const sendButton = el("button", "btn primary"),
      saveButton = el("button", "btn");
    const update = () => {
      const n = picked().length;
      sendButton.textContent = `Add ${plural(n, "rule")} with an agent`;
      saveButton.textContent = "Save as drafts";
      sendButton.disabled = saveButton.disabled = !n;
    };
    // "New" only means something when earlier audits made the rest of the list.
    const earlier = rules.some((r) => r.firstSeen < data.lastRun);
    const order = (a, b) =>
      (rank[a.value] ?? 1) - (rank[b.value] ?? 1) ||
      (b.trial?.broke || 0) - (a.trial?.broke || 0);
    // Two sections: rules that find a problem now, and rules that stop a later mistake.
    for (const [heading, note, members] of [
      [
        "Finds a problem now",
        "The code breaks these rules now. A break can be a mistake, or a design that you chose: then leave the rule out.",
        roots.filter(breaking),
      ],
      [
        "Guards against future mistakes",
        "Nothing breaks these rules now. They stop a mistake later.",
        roots.filter((r) => !breaking(r)),
      ],
    ]) {
      if (!members.length) continue;
      body.append(
        el("h3", "workflow-group", heading),
        el("p", "audit-principle", note),
      );
      for (const r of members.sort(order))
        body.append(
          row(
            r,
            update,
            earlier && r.firstSeen === data.lastRun,
            rules.filter((c) => c.partOf === r.id),
          ),
        );
    }
    if (rules.length) {
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
      body.append(buttons);
    }
    if (data.dropped?.length) {
      const left = el("details", "fix-context");
      left.append(
        el(
          "summary",
          "",
          `The last audit left out ${plural(data.dropped.length, "proposal")}`,
        ),
      );
      for (const d of data.dropped)
        left.append(el("p", "fix-context-row", `${d.title}: ${d.reason}`));
      body.append(left);
    }
    if (!data.running) {
      const again = el("button", "link-button fix-other", "Audit again ›");
      again.type = "button";
      again.onclick = () => start(commit);
      body.append(again);
    }
  }

  return { render };
}
