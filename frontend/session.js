/** @module Live sessions: a conversation with a coding agent that works on its own branch
 * (backend/agent_session.rs). The owner's messages start agent turns; this module shows the
 * conversation, each step the agent takes with its output, the agent's command requests, and
 * the way to end the session in the normal review. */
import {
  Prose,
  Actions,
  ApprovalPrompt,
  Button,
  Command,
  IconButton,
  InlineError,
  Message,
  Note,
  PageHeader,
  Peek,
  Pending,
  ReplyComposer,
  RuleCheck,
  StatusLabel,
  StepList,
  StepRow,
  TextField,
  Thread,
} from "./ui.js";

/** True for a session that is still open: an agent turn runs, or it waits for the owner. */
export const live = (r) =>
  r?.kind === "session" && ["running", "waiting"].includes(r.status);

/** True for a command with several parts, which a session rule cannot cover (see
 * backend/agent_session.rs). */

/** How a new session treats commands on this device: "ask" (the default) or "allow". */
const PERMISSIONS = "peekumi.session.permissions";
export function savedPermissions() {
  try {
    return localStorage.getItem(PERMISSIONS) === "allow" ? "allow" : "ask";
  } catch {
    return "ask";
  }
}
export function savePermissions(mode) {
  try {
    localStorage.setItem(PERMISSIONS, mode);
  } catch {}
}

/** What a live session does now, for the sheet's header outside its view: a title, a short
 * label, the command or file to highlight, and the path the agent works on (for the map).
 * `tail` is the session; its steps come from the items this device has read. */
/** The word for each of Peek's activity poses (frontend/peek.js). */
const ACTIVITY_WORDS = {
  reading: "Reading",
  searching: "Searching",
  editing: "Editing",
  creating: "Creating",
  running: "Running",
};
export function activity(tail) {
  if (tail.approval)
    return {
      state: "needs",
      title: "Needs you",
      label:
        tail.approval.tool === "Bash"
          ? "Allow this command?"
          : `Allow ${tail.approval.tool}?`,
      code: tail.approval.tool === "Bash" ? tail.approval.input : "",
    };
  if (tail.waitsForRepository)
    return {
      state: "queued",
      title: "Waiting",
      label: "Your message waits until the other agent finishes",
    };
  if (tail.status !== "running")
    return {
      state: "waiting",
      title: "Your turn",
      label: tail.summary
        ? tail.summary.split("\n")[0]
        : "The agent waits for your reply.",
    };
  const last = itemsOf(tail.id)
    .filter((i) => i.kind === "step" || i.kind === "text")
    .at(-1);
  if (!last) return { state: "running", title: "Working", label: "Starting" };
  if (last.kind === "text")
    return {
      state: "running",
      title: "Working",
      label: last.text.split("\n")[0],
    };
  const path = last.changed?.[0] || last.files?.[0] || "";
  return {
    state: "running",
    title: ACTIVITY_WORDS[last.activity] || "Working",
    pose: last.activity,
    label: last.label,
    code: last.code || "",
    path,
  };
}

/** A new ID for an owner message. The server keeps a message with the same ID once, so a send
 * that the device repeats (after a timeout, say) is not doubled. */
const messageId = () =>
  "m" +
  [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Each run's conversation as the server reads it (backend/conversation.rs): its items, the
 * epoch and number of the last change that this device has, and the files the run changed. */
const conversations = new Map();

/** Reads the items of run `id` that changed since this device's last read, with `api` (a GET
 * that returns JSON). The first read, and a read after the server restarted (a new epoch),
 * give the whole list. Returns the items. */
export async function syncItems(api, id) {
  const known = conversations.get(id);
  const query = known ? `?after=${known.seq}&epoch=${known.epoch}` : "";
  const read = await api(`/api/runs/${id}/items${query}`);
  const items = read.items || known.items.slice();
  for (const patch of read.patches || []) items[patch.index] = patch.item;
  items.length = read.total;
  conversations.set(id, {
    epoch: read.epoch,
    seq: read.seq,
    items,
    changed: read.changed || [],
  });
  return items;
}

/** The items of run `id` that this device has: empty before the first read. */
export const itemsOf = (id) => conversations.get(id)?.items || [];

/** The number of the last change of run `id` that this device has, for change checks. */
export const seqOf = (id) => conversations.get(id)?.seq || 0;

/** The files that run `id` changed, from the last read of its conversation. */
export const changedOf = (id) => conversations.get(id)?.changed || [];

/** Where a session's agent is and has been, from its steps: `current` (the newest place),
 * `trail` (up to four places before it, newest first), and `activity`, the pose of a step
 * that is not done yet. A place is `{path, symbol?}`. */
export function focusOf(items) {
  const places = items.flatMap((i) =>
    i.kind === "step" ? i.targets || [] : [],
  );
  const key = (p) => `${p.path}#${p.symbol || ""}`;
  const seen = new Set();
  const order = [];
  for (let i = places.length - 1; i >= 0 && order.length < 5; i--) {
    if (seen.has(key(places[i]))) continue;
    seen.add(key(places[i]));
    order.push(places[i]);
  }
  const newest = items.findLast((i) => i.kind === "step");
  return {
    current: order[0] || null,
    trail: order.slice(1),
    activity: newest?.done ? null : newest?.activity || null,
  };
}

/** The session's cost so far, from the agents' own reports. */
const costOf = (items) =>
  items.filter((i) => i.kind === "cost").reduce((sum, i) => sum + i.cost, 0);

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
 * @param {() => void} deps.back Returns to the view before the session.
 */
export function createSession({
  write,
  refresh,
  notice,
  context,
  using,
  agentName: nameOf = (id) => id,
  asksBeforeCommands = () => false,
  // What a provider's conversation can do (backend/conversation.rs): the view shows its
  // controls by these, never by the provider's name.
  capabilities = () => ({}),
  openTask,
  showOnMap,
  openPlace,
  references,
  pointed = () => true,
  sent = () => {},
  back,
}) {
  // The places that the names in a session's messages point at, for the current text.
  let places = { key: "", map: {} },
    findingPlaces = false;
  let draft = "",
    // The ID of the draft's message, kept across a failed send (see messageId).
    draftId = null,
    ending = false,
    denyNote = "",
    // The request last brought into view, so a redraw does not move the reader again.
    shownRequest = null;
  /** A button that runs `fn` once at a time, and tells the owner when it fails. */
  const action = (label, fn, variant = "secondary") => {
    const b = Button({
      label,
      variant,
      onClick: async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (e) {
          notice(e.message, true);
        } finally {
          b.disabled = false;
        }
      },
    });
    return b;
  };
  // Names and abilities come from the server's agent list (agents.js), never from IDs here.
  const agentName = (r) => nameOf(r.agent);
  const anchorLabel = (a) =>
    a.kind === "repo"
      ? "Repository"
      : [a.path?.split("/").pop(), a.symbol].filter(Boolean).join(" · ");

  /** The agent's request to run a command, with the owner's three answers. */
  function approvalCard(r) {
    const a = r.approval;
    const decide = (decision) => async () => {
      await write(`/api/runs/${r.id}/approval`, {
        approval: a.id,
        decision,
        message: decision === "deny" ? denyNote : "",
      });
      denyNote = "";
      await refresh();
    };
    const card = ApprovalPrompt({
      title:
        a.tool === "Bash"
          ? "The agent asks to run a command"
          : `The agent asks to use ${a.tool}`,
      command: a.input,
      reason: a.reason && `Why: “${a.reason}”`,
      // The note comes first: it goes with Deny, so it is written before the tap.
      note: TextField({
        label: "A note for the agent (optional)",
        value: denyNote,
        onInput: (event) => (denyNote = event.target.value),
      }),
      actions: [
        action("Allow once", decide("allow"), "primary"),
        // The server names the rule, or none when no rule is safe (a chained command, a
        // shell, sudo, git push…): then allow it once, or allow everything.
        a.rule && action(`Allow ${a.rule} in this session`, decide("session")),
        action("Allow all commands", decide("all")),
        action("Deny", decide("deny"), "danger"),
      ],
    });
    // A new request comes into view once, from its top, so its command is visible.
    if (shownRequest !== a.id) {
      shownRequest = a.id;
      requestAnimationFrame(() =>
        card.scrollIntoView({ block: "start", behavior: "smooth" }),
      );
    }
    return card;
  }

  /** One step: what the agent did, a mark for its result, and its output when opened. */
  function stepRow(step, r, index, current) {
    return StepRow(
      {
        key: `step-${index}`,
        label: step.label,
        code: step.code,
        current,
        state: step.done
          ? step.failed
            ? "failed"
            : "done"
          : r.status === "running"
            ? "now"
            : "open",
      },
      step.note && Note(step.note),
      [...new Set(step.changed.length ? step.changed : step.files)]
        .filter(Boolean)
        .map((path) =>
          Button({
            label: `Show ${path} on the map`,
            variant: "plain",
            onClick: () => showOnMap(r, path),
          }),
        ),
      step.output?.trim() && Command(step.output.trim().slice(-6000)),
    );
  }

  /** The Session view: the conversation, live state, and the session's actions. */
  function render(body, r) {
    const items = itemsOf(r.id);
    // One row that stays at the top: back, the title, the state, and Stop while it works.
    const state = r.approval
      ? "Needs you"
      : r.status === "running"
        ? "Working"
        : r.waitsForRepository
          ? "Waiting"
          : live(r)
            ? "Your turn"
            : "Ended";
    const can = capabilities(r.agent);
    const stop =
      r.status === "running" &&
      can.interrupt !== false &&
      IconButton({
        icon: "stop",
        label: "Stop",
        quiet: true,
        onClick: async () => {
          stop.disabled = true;
          try {
            await write(`/api/runs/${r.id}/cancel`, {});
            await refresh();
          } catch (e) {
            notice(e.message, true);
          } finally {
            stop.disabled = false;
          }
        },
      });
    const head = PageHeader({
      title: r.title || "Session",
      meta: StatusLabel({
        state: r.approval
          ? "needs"
          : r.waitsForRepository
            ? "queued"
            : r.status,
        text: state,
      }),
      actions: stop ? [stop] : [],
      onBack: back,
    });
    // The header sits above the scrolling conversation, not in it (app.js #viewHead).
    const host = document.querySelector("#viewHead");
    if (host) host.replaceChildren(head);
    else body.append(head);

    const log = conversation(r, items);
    if (r.approval) log.append(approvalCard(r));
    // Messages that wait for a turn show as the owner wrote them, with when they go.
    for (const m of (r.messages || []).filter((x) => !x.delivered))
      log.append(
        Message(
          { from: "user" },
          Prose(m.text),
          Note(
            r.waitsForRepository
              ? "Waits until the other agent finishes"
              : r.status === "running"
                ? "Goes to the agent after this turn"
                : "Goes with your next message",
          ),
        ),
      );
    if (r.status === "running" && !r.approval) {
      // Peek and the word show what the agent does now: reading, editing, and so on.
      const now = activity(r);
      log.append(
        Message(
          { pending: true },
          Peek({ state: now.pose || "working", size: "live" }),
          Pending(now.title),
        ),
      );
    }
    // The conversation already says "Stopped by you."; a note that repeats it is left out.
    if (
      r.message &&
      r.status !== "running" &&
      !r.waitsForRepository &&
      !/^Stopped\./.test(r.message)
    )
      log.append(Note(r.message));
    body.append(log);
    renderActions(body, r);
  }

  /** The conversation of a session: the owner's messages, the agent's text and steps. */
  function conversation(r, items = itemsOf(r.id)) {
    const log = Thread();
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Session conversation");
    log.setAttribute("aria-live", "polite");
    // Names in backticks link to their place on the map, as in Ask.
    const words = items
      .filter((i) => i.kind === "text" || i.kind === "owner")
      .map((i) => i.text)
      .join("\n");
    const key = `${r.id}:${words.length}`;
    if (places.key !== key && !findingPlaces && words.includes("`")) {
      findingPlaces = true;
      const head = r.results?.length ? "refs/heads/" + r.branch : r.base;
      references({
        base: r.base,
        head,
        about: r.comments?.[0]?.anchor?.path || "",
        text: words,
      })
        .then((found) => (places = { key, map: found.references || {} }))
        .catch(() => (places = { key, map: places.map }))
        .finally(() => {
          findingPlaces = false;
          // A running session redraws at its next poll anyway.
          if (r.status !== "running") refresh();
        });
    }
    const linked = { links: places.map, onLink: (target) => openPlace(target) };
    const lastStep =
      r.status === "running"
        ? items.map((i) => i.kind).lastIndexOf("step")
        : -1;
    // Only the latest rule check offers a fix: an older one is about an older head.
    const lastRules = items.map((i) => i.kind).lastIndexOf("rules");
    // Steps in a row form one compact list.
    let steps = null;
    items.forEach((item, index) => {
      if (item.kind !== "step") steps = null;
      if (item.kind === "owner") {
        // Where the owner pointed, as quiet text under the message.
        const parts = item.anchors.filter((a) => a.kind !== "repo");
        log.append(
          Message(
            { from: "user" },
            Prose(item.text, linked),
            parts.length > 0 && Note("↳ " + parts.map(anchorLabel).join(", ")),
          ),
        );
      } else if (item.kind === "text")
        log.append(Message({}, Prose(item.text, linked)));
      else if (item.kind === "step") {
        if (!steps) {
          steps = StepList();
          log.append(steps);
        }
        // The step the agent takes now; the map marks its place.
        steps.append(stepRow(item, r, index, index === lastStep));
      } else if (item.kind === "rules")
        log.append(
          RuleCheck({
            check: item.check,
            actions:
              index === lastRules &&
              r.status === "waiting" &&
              item.check.addedCount > 0
                ? [
                    {
                      label: "Ask the agent to fix",
                      onClick: () => askToFix(r),
                    },
                  ]
                : [],
          }),
        );
      else if (item.kind === "error")
        log.append(InlineError({ title: "Error", text: item.text }));
      else if (item.kind === "end" && item.status === "cancelled")
        log.append(Note("Stopped by you."));
      else if (item.kind === "end" && item.status === "failed")
        log.append(
          InlineError({
            title: "The agent's turn failed",
            text: "Reply to try again, or end the session.",
          }),
        );
    });
    return log;
  }

  /** The owner's message that asks the agent to fix what the last rule check found. Peekumi
   * adds the fresh check to that turn's prompt (backend/runner.rs). */
  async function askToFix(r) {
    try {
      await write(`/api/runs/${r.id}/message`, {
        id: messageId(),
        text: "Fix the rule breaks that this session adds. Do not change the rule files to remove a break. If a break is needed, tell me why.",
        anchors: [],
      });
      await refresh();
    } catch (e) {
      notice(e.message, true);
    }
  }

  /** Below the conversation: the session's details, then quiet links: its changes on the
   * map, how it treats commands, and End session. */
  function renderActions(body, r) {
    const cost = costOf(itemsOf(r.id));
    body.append(
      Note(
        [
          agentName(r) + (r.model ? " · " + r.model : ""),
          `${r.turns || 0} turn${r.turns === 1 ? "" : "s"}`,
          `${r.results?.length || 0} commit${r.results?.length === 1 ? "" : "s"}`,
          cost ? `$${cost.toFixed(2)}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const link = (label, fn) =>
      Button({
        label,
        variant: "plain",
        onClick: async () => {
          try {
            await fn();
          } catch (e) {
            notice(e.message, true);
          }
        },
      });
    const links = [];
    if (r.results?.length)
      links.push(link("Changes on the map", () => showOnMap(r)));
    // How the session treats commands; the next turn starts with the new choice.
    const all = r.permissions === "allow";
    if (capabilities(r.agent).approvals ?? asksBeforeCommands(r.agent)) {
      const mode = link(
        all ? "Commands: all allowed" : "Commands: ask first",
        async () => {
          await write(`/api/runs/${r.id}/permissions`, {
            mode: all ? "ask" : "allow",
          });
          await refresh();
        },
      );
      mode.setAttribute("aria-pressed", String(all));
      mode.title = all
        ? "Commands run with no question. Tap to ask before commands outside the list"
        : "Commands outside the list wait for you. Tap to allow all commands";
      links.push(mode);
    }
    if (r.status === "waiting" && !ending)
      links.push(
        link("End session", () => {
          ending = true;
          return refresh();
        }),
      );
    if (links.length) body.append(Actions({}, links));
    if (r.status === "waiting" && ending) body.append(endPanel(r));
  }

  /** Ending: send the branch to the normal review, end without review, or keep working. */
  function endPanel(r) {
    const commits = r.results?.length || 0;
    const review = action(
      "Send to review",
      async () => {
        await write(`/api/runs/${r.id}/end`, { review: true });
        ending = false;
        await openTask(r.id);
      },
      "primary",
    );
    review.disabled = !commits;
    const panel = ApprovalPrompt({
      title: "End the session",
      icon: null,
      reason: commits
        ? `${commits} commit${commits === 1 ? "" : "s"}. Send to review, then approve and merge into ${r.watched?.replace("refs/heads/", "") || "main"}. The conversation stays with the work.`
        : "The agent made no commit. Ask it to commit its work, or end without review.",
      actions: [
        review,
        action("End without review", async () => {
          await write(`/api/runs/${r.id}/end`, { review: false });
          ending = false;
          await refresh();
        }),
        Button({
          label: "Keep working",
          variant: "plain",
          onClick: () => {
            ending = false;
            refresh();
          },
        }),
      ],
    });
    return panel;
  }

  /** The dock's composer in Session mode: a reply to the open session, with the selection
   * on the map as a pointer, or the first message of a new session (the send sheet starts
   * most sessions). Returns the place that goes with the message, for the dock. */
  function renderComposer(host, current, { named = false } = {}) {
    const here = context();
    // Only a place the owner chose goes with a reply, not where Follow moved the map.
    const pointer =
      here && here.anchor.kind !== "repo" && pointed() ? here.anchor : null;
    const send = async (text) => {
      // One ID for each draft: if this send fails and the owner sends again, the server keeps
      // the message once.
      if (text !== draft || !draftId) draftId = messageId();
      draft = text;
      try {
        if (current) {
          await write(`/api/runs/${current.id}/message`, {
            id: draftId,
            text: draft,
            anchors: pointer ? [pointer] : [],
          });
          draft = "";
          draftId = null;
          sent();
          await refresh();
          return;
        }
        if (!here) throw Error("Select a part of the map first");
        const started = await write("/api/runs/session", {
          ...here,
          text: draft,
          using: using("task"),
          permissions: savedPermissions(),
        });
        draft = "";
        await openTask(started.id);
      } catch (e) {
        notice(e.message, true);
      }
    };
    host.append(
      ReplyComposer({
        label: current ? "Reply to the agent" : "What do you want to work on?",
        // With more than one open session, the box says which one the reply goes to.
        placeholder: current
          ? named
            ? `Reply to “${(current.title || "Session").slice(0, 40)}”`
            : current.status === "running"
              ? capabilities(current.agent).steer
                ? "Steer the agent: it reads this now"
                : "Steer the agent: it reads this after its current turn"
              : "Reply to the agent"
          : "What do you want to work on?",
        sendLabel: current ? "Send to the agent" : "Start session",
        sendIcon: current ? "send" : "check",
        value: draft,
        docked: true,
        onInput: (text) => (draft = text),
        onSend: send,
      }),
    );
    return current
      ? pointer
        ? anchorLabel(pointer)
        : ""
      : here
        ? anchorLabel(here.anchor)
        : "";
  }

  return { render, renderComposer, conversation };
}
