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
import {
  Actions,
  Button,
  Code,
  Disclosure,
  EmptyState,
  Group,
  InlineError,
  Note,
  ProposalRow,
  TextArea,
} from "./ui.js";

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

  /** Starts an audit at `commit`; its rules join the list when it ends. When another agent
   * run holds the agent, the page waits and tries again while it is open. */
  async function start(commit) {
    try {
      const started = await sendJson("/api/rules/propose", {
        head: commit,
        using: using(),
      });
      if (started.busy) {
        shown.waiting = started.busy;
        redraw();
        setTimeout(() => {
          if (shown?.commit === commit && shown.waiting && showing())
            start(commit);
        }, 5000);
        return;
      }
      shown.waiting = "";
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
          {
            groups: r.trial?.groups || r.groups,
            rule: r.trial?.rule || r.rule,
          },
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
          ];
    return ProposalRow(
      {
        sentence: plainOf(r),
        meta: [
          r.principle,
          ...(r.value ? [`${r.value} value`] : []),
          ...numbers,
          ...(fresh ? ["new"] : []),
          ...(r.status === "drafted" ? ["drafted"] : []),
        ].join(" · "),
        breaks: r.added || r.problem ? null : trial.broke || 0,
        name: `Select the rule ${r.rule.id}`,
        checked: r.status === "selected" && usable(r),
        disabled: done || !usable(r),
        done,
        editOpen: !!edit.error,
        editor:
          !done &&
          TextArea({
            label: `Rule ${r.rule.id}`,
            value: edit.text,
            rows: 10,
            code: true,
            onInput: (event) => (edit.text = event.target.value),
            // Leaving the box tries the rule again, when its text changed.
            onChange: () => check(r),
          }),
        onToggle: (event) => {
          mark(r, event.target.checked ? "selected" : "proposed");
          update();
        },
      },
      Note(r.why),
      // The agent's view of the breaks now: on purpose or a mistake, and the cost of a fix. It
      // shows only when Peekumi measured a break.
      trial.broke > 0 && r.now && Note(`Now: ${r.now}`),
      r.problem &&
        (r.added
          ? Note(r.problem)
          : InlineError({ title: "Refused", text: r.problem })),
      (trial.warnings || []).map((warning) => Note(warning)),
      (trial.examples || [])
        .slice(0, 3)
        .map((b) => Note(Code(`${b.source} → ${b.target} (${b.kind})`))),
      trial.broke > 3 && Note(`${trial.broke - 3} more breaks`),
      parts.length > 0 && Note(`Also covers: ${parts.map(plainOf).join("; ")}`),
      edit.error && InlineError({ title: "Refused", text: edit.error }),
    );
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
    const tops = rules.filter((r) => !r.partOf || !ids.has(r.partOf));
    // A rule that is in the rule file now, or that went to an agent, is done: it leaves the
    // two sections for a closed list at the end.
    const done = (r) => r.added || r.status === "drafted";
    const roots = tops.filter((r) => !done(r));
    const finished = tops.filter(done);
    const breaking = (r) => !r.problem && (r.trial?.broke || 0) > 0;
    head("Proposed rules", {
      meta: tops.length
        ? `${plural(roots.length, "open rule")} · ${roots.filter(breaking).length} find a problem now`
        : "",
    });
    if (shown.error)
      body.append(InlineError({ title: "No audit", text: shown.error }));
    if (shown.waiting)
      body.append(
        EmptyState({
          state: "idle",
          title: "Waiting for the agent",
          text: shown.waiting,
        }),
      );
    if (!data) return body.append(Note("Reading the list…"));
    if (data.running)
      body.append(
        EmptyState({
          state: "thinking",
          title: "Proposing rules",
          text: `${agentName() || "The agent"} reads the architecture and the code, then proposes rules. This can take a few minutes. You can leave this page: Peekumi tells you when the rules are ready, if notifications are on.`,
        }),
      );
    else if (data.error)
      body.append(
        InlineError({ title: "The last audit failed", text: data.error }),
      );
    // An audit can find that nothing is missing: that is a good result, not an error.
    if (!data.running && !data.error && data.lastRun && data.lastAdded === 0)
      body.append(
        Note(
          "The last audit found no missing rule. The current rules are enough.",
        ),
      );
    if (!rules.length && !data.running)
      return body.append(
        Actions(
          {},
          Button({
            label: data.lastRun ? "Audit again" : "Audit the architecture",
            variant: "primary",
            onClick: () => start(commit),
          }),
        ),
      );
    if (rules.length)
      body.append(
        Note(
          `${data.provider || "The agent"} proposed these rules from the architecture, not from the imports that exist now. Each rule says which files must not use which. Select the rules to add; your selection stays. "Cannot check" counts relationships that Peekumi cannot resolve: they never break a rule.`,
        ),
      );
    const sendButton = Button({
        label: "",
        variant: "primary",
        onClick: async () => {
          sendButton.disabled = true;
          send(await draft());
        },
      }),
      saveButton = Button({
        label: "Save as drafts",
        onClick: async () => {
          saveButton.disabled = true;
          const ids = await draft();
          saved(ids.length);
          redraw();
        },
      });
    const update = () => {
      const n = picked().length;
      sendButton.textContent = `Add ${plural(n, "rule")} with an agent`;
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
        Group(
          { title: heading },
          Note(note),
          members.sort(order).map((r) =>
            row(
              r,
              update,
              earlier && r.firstSeen === data.lastRun,
              rules.filter((c) => c.partOf === r.id),
            ),
          ),
        ),
      );
    }
    if (roots.length) {
      update();
      body.append(Actions({}, sendButton, saveButton));
    }
    if (!roots.length && finished.length && !data.running)
      body.append(
        Note("No open rule: each rule is added or sent to an agent."),
      );
    if (finished.length)
      body.append(
        Disclosure(
          { summary: `Done (${finished.length})` },
          finished.map((r) =>
            Note(
              `${plainOf(r)} · ${r.added ? "in the rule file" : "sent to an agent"}`,
            ),
          ),
        ),
      );
    if (data.dropped?.length)
      body.append(
        Disclosure(
          {
            summary: `The last audit left out ${plural(data.dropped.length, "proposal")}`,
          },
          data.dropped.map((d) => Note(`${d.title}: ${d.reason}`)),
        ),
      );
    if (!data.running)
      body.append(
        Button({
          label: "Audit again",
          variant: "plain",
          onClick: () => start(commit),
        }),
      );
  }

  return { render };
}
