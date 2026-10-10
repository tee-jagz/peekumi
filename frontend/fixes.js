/**
 * @module Proposed fixes: the page that turns the dependency-rule breaks at the map's commit
 * into instructions for an agent.
 *
 * Peekumi groups the breaks first (`GET /api/fixes?head=`): one group for each rule and each
 * declaration that the breaks reach. Then the agent that the owner chose for Ask reads the
 * code, with those groups as its context, and proposes the fixes. The proposal runs on the
 * server in the background (`POST /api/fixes/propose`), because it can take minutes: the
 * owner can leave the app, and a notification says when it ends. The page reads the saved
 * proposal for its commit (`GET /api/fixes/proposal?head=`) and starts one only when there is
 * none. While the agent works, the groups show as context. If the agent fails, the owner can
 * try again, or use Peekumi's groups as the proposals.
 *
 * The owner selects fixes (all at first), edits their text and clears the ones to leave out.
 * One button saves the selected fixes as draft instructions and opens the task form with them
 * selected (a batch of fixes in one task); another only saves them. A drafted fix is not
 * drafted again, also after a reload: the server's instructions say which were sent.
 */
import {
  Actions,
  Button,
  Disclosure,
  EmptyState,
  InlineError,
  Note,
  ProposalRow,
  TextArea,
} from "./ui.js";

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
  // True while the page is open: it reads the proposal's state only then.
  showing = () => true,
}) {
  // One commit's state: Peekumi's groups, the agent's proposal, and which list shows.
  let shown = null,
    polling = false;
  // The owner's choice and text for each proposal, and the fixes already drafted, by key.
  const choices = new Map(),
    drafted = new Set();
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
    // What was already sent, from the server: a fix whose text is a live instruction is not
    // sent again, also after a reload.
    api("/api/workflow")
      .then((w) => {
        if (shown.commit !== commit) return;
        shown.sent = new Set(
          (w.comments || [])
            .filter((c) => c.status !== "deleted")
            .map((c) => c.text.trim()),
        );
        redraw();
      })
      .catch(() => {});
    api("/api/fixes?head=" + encodeURIComponent(commit))
      .then((data) => {
        if (shown.commit !== commit) return;
        shown.groups = data.fixes;
        shown.state = data.checks?.state;
        if (shown.groups.length) follow(commit, true);
        else redraw();
      })
      .catch((error) => {
        if (shown.commit !== commit) return;
        shown.error = error.message;
        redraw();
      });
  }

  /** Reads the saved proposal for `commit`. With `first`, a commit with no proposal yet
   * starts one. While the proposal runs, the page reads it again every three seconds. */
  async function follow(commit, first = false) {
    let state;
    try {
      state = await api(
        "/api/fixes/proposal?head=" + encodeURIComponent(commit),
      );
    } catch (error) {
      if (shown.commit !== commit) return;
      shown.agent = {
        status: "failed",
        fixes: [],
        provider: "",
        error: error.message,
      };
      return redraw();
    }
    if (shown.commit !== commit) return;
    if (state.running) {
      shown.agent = { status: "running", fixes: [], provider: "", error: "" };
      if (!polling) {
        polling = true;
        setTimeout(() => {
          polling = false;
          if (shown?.commit === commit && showing()) follow(commit);
        }, 3000);
      }
    } else if (state.fixes) {
      shown.agent = {
        status: "done",
        fixes: state.fixes,
        provider: state.provider || "",
        error: "",
      };
      for (const fix of state.fixes)
        if (!choices.has(`${commit}:a:${fix.id}`))
          choices.set(`${commit}:a:${fix.id}`, {
            selected: true,
            text: fix.text,
          });
    } else if (state.error)
      shown.agent = {
        status: "failed",
        fixes: [],
        provider: "",
        error: state.error,
      };
    else if (first) return propose();
    redraw();
  }

  /** Starts a proposal on the server; Peekumi's groups go with it as context. */
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
      .then((started) => {
        if (shown.commit !== commit) return;
        if (!started.busy) return follow(commit);
        // Another agent run holds the agent: wait, and try again while the page is open.
        shown.agent = {
          status: "waiting",
          fixes: [],
          provider: "",
          error: started.busy,
        };
        redraw();
        setTimeout(() => {
          if (
            shown?.commit === commit &&
            shown.agent.status === "waiting" &&
            showing()
          )
            propose();
        }, 5000);
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

  /** True when proposal `item` is already an instruction (drafted here, or sent before). */
  const isDrafted = (item) =>
    drafted.has(item.key) ||
    Boolean(shown.sent?.has(choices.get(item.key)?.text?.trim()));
  /** The selected proposals that are not drafted yet. */
  const picked = () =>
    items().filter(
      (item) => choices.get(item.key)?.selected && !isDrafted(item),
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
  const context = (open) =>
    Disclosure(
      {
        summary: `What Peekumi found (${plural(shown.groups.length, "place")})`,
        open,
      },
      shown.groups.map((g) =>
        Note(
          `${g.target.symbol ? `${g.target.symbol} in ${g.target.path}` : g.target.path} · ${g.rule} · ${plural(g.count, "break")} from ${g.sources.join(", ")}`,
        ),
      ),
    );

  /** Draws the page in `body`. */
  function render(body) {
    const commit = revision();
    if (shown?.commit !== commit) load(commit);
    // Back on the page while the proposal runs: read its state again until it ends.
    else if (shown.agent.status === "running" && !polling) follow(commit);
    const breaks = (shown.groups || []).reduce((sum, g) => sum + g.count, 0);
    head("Proposed fixes", {
      meta: shown.groups?.length
        ? `${plural(breaks, "rule break")} in ${plural(shown.groups.length, "place")}`
        : "",
    });
    if (shown.error)
      return body.append(
        InlineError({ title: "No rule breaks", text: shown.error }),
      );
    if (!shown.groups) return body.append(Note("Reading the rule breaks…"));
    if (shown.state !== "evaluated")
      return body.append(
        EmptyState({
          title:
            shown.state === "invalid"
              ? "The rule configuration (.peekumi.json) is invalid. Fix it first."
              : "This repository has no dependency rules (.peekumi.json).",
        }),
      );
    if (!shown.groups.length)
      return body.append(
        EmptyState({
          state: "ready",
          title: "No rule breaks at this commit. Nothing to fix.",
        }),
      );

    const agent = shown.agent;
    if (
      shown.mode === "agent" &&
      (agent.status === "running" || agent.status === "waiting")
    )
      return body.append(
        EmptyState({
          state: agent.status === "waiting" ? "idle" : "thinking",
          title:
            agent.status === "waiting"
              ? "Waiting for the agent"
              : "Proposing fixes",
          text:
            agent.status === "waiting"
              ? agent.error
              : `${agentName() || "The agent"} reads the code and proposes fixes. This can take a few minutes. You can leave this page: Peekumi tells you when the fixes are ready, if notifications are on.`,
        }),
        context(true),
      );
    if (shown.mode === "agent" && agent.status === "failed")
      return body.append(
        InlineError({
          title: "The agent could not propose fixes",
          text: agent.error,
        }),
        Actions(
          {},
          Button({ label: "Try again", variant: "primary", onClick: propose }),
          Button({ label: "Use Peekumi's own proposals", onClick: usePeekumi }),
        ),
        context(true),
      );

    body.append(
      Note(
        shown.mode === "agent"
          ? `${agent.provider} read the code and proposed these fixes. Select the fixes to make, edit their text, then send them together as one task.`
          : "Peekumi's own proposals, one for each place. Select the fixes to make, edit their text, then send them together as one task.",
      ),
    );
    // The buttons count the selection; a change to it updates them in place, so the text box
    // that the owner types in keeps its focus.
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
      sendButton.textContent = `Send ${plural(n, "fix")} to an agent`;
      sendButton.disabled = saveButton.disabled = !n;
    };
    const rows = items().map((item) => {
      const choice = choices.get(item.key);
      const done = isDrafted(item);
      return ProposalRow({
        sentence: item.title,
        meta: item.line + (done ? " · drafted" : ""),
        breaks: null,
        name: `Select ${item.title}`,
        checked: choice.selected && !done,
        disabled: done,
        done,
        editLabel: "The instruction",
        editOpen: true,
        editor: TextArea({
          label: `Instruction for ${item.title}`,
          value: choice.text,
          rows: 5,
          disabled: done,
          onInput: (event) => (choice.text = event.target.value),
        }),
        onToggle: (event) => {
          choice.selected = event.target.checked;
          update();
        },
      });
    });
    update();
    body.append(
      ...rows,
      Actions({}, sendButton, saveButton),
      Button({
        label:
          shown.mode === "agent" ? "Propose again" : "Ask the agent instead",
        variant: "plain",
        onClick: propose,
      }),
      context(false),
    );
  }

  return { render };
}
