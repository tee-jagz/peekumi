/** @module Contextual, non-executing review conversations and explicit draft suggestions.
 * One conversation runs for the session and stays in view as the map moves; each question is
 * about whatever was selected when it was sent, and is marked when that changes. Answers
 * stream in as Claude writes them; lookups show while they happen. */
import {
  Prose,
  Button,
  Message,
  Note,
  Peek,
  Pending,
  ReplyComposer,
  SubjectMark,
  Suggestion,
  Text,
  Thread,
} from "./ui.js";
export function createAsk({
  api,
  stream,
  context,
  redraw,
  notice,
  makeDraft,
  // A question was sent: the app shows its conversation.
  opened = () => {},
  changeTarget,
  addToChanges,
  openReference,
  // The name for questions about the whole comparison, such as "PR #3"; optional.
  rootSubject,
  // The agent choice for Ask on this device (see agents.js), sent with each question.
  using = () => null,
  // The places the answer reads, oldest first, and whether it still works (see focus.js).
  lookedAt = () => {},
  // A commit's short name: "uncommitted" for the snapshot of uncommitted changes.
  revisionName = (sha) => sha.slice(0, 7),
}) {
  const chat = {
    messages: [],
    question: "",
    pending: false,
    partial: "",
    live: [],
    reveal: false,
  };
  // Each branch has its own conversation, kept on the server with the repository's private
  // state, so a reload, an app update or another device picks it up where it left off.
  let branch = null;
  const threads = new Map();
  const historyRoute = (key) =>
    "/api/ask/history?branch=" + encodeURIComponent(key);
  /** Saves branch `key`'s conversation (the one shown, unless an answer finished elsewhere). */
  function save(key = branch, thread = chat.messages) {
    if (!key) return;
    let messages = thread.slice(-60);
    while (messages.length && JSON.stringify(messages).length > 120000)
      messages = messages.slice(1);
    api(historyRoute(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    }).catch(() => {
      /* The conversation still works in this page; it is saved again after the next answer. */
    });
  }
  /** A short name for what a question was about. */
  const subjectOf = (anchor) =>
    anchor.symbol ||
    anchor.path?.split("/").at(-1) ||
    rootSubject?.() ||
    "the repository";
  /** A button that runs `fn` once at a time, and tells the owner when it fails. */
  const btn = (label, fn) => {
    const b = Button({
      label,
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
  /** The in-progress reply: text as it streams (without a half-written suggestion line), or
   * Peek thinking until the first words arrive, plus any lookups made so far. */
  function pendingBubble(chat) {
    const text = chat.partial.replace(
      /\n?Suggested (instruction|comment):[^]*$/,
      "",
    );
    // Peek looks over its layers while Ask is reading the code, and thinks otherwise. The
    // reply is redrawn on every event, so the same Peek carries on rather than restarting.
    const mood = chat.live.length ? "peeking" : "thinking",
      current = document.querySelector(".pk-message.is-pending .peek-mark");
    return Message(
      { pending: true },
      text.trim()
        ? Prose(text)
        : [
            current?.dataset.state === mood
              ? current
              : Peek({ state: mood, size: "live" }),
            Pending("Reading the code"),
          ],
      chat.live.length > 0 &&
        Note("Looking up: " + [...new Set(chat.live)].join(" · ")),
    );
  }
  let painting = 0;
  /** Repaints only the streaming bubble, once per frame, so typing elsewhere is undisturbed. */
  function paint() {
    if (painting) return;
    painting = requestAnimationFrame(() => {
      painting = 0;
      document
        .querySelector(".pk-message.is-pending")
        ?.replaceWith(pendingBubble(chat));
    });
  }
  /** Sends `chat.question` about the current context: shows it at once, streams the answer
   * into this branch's conversation, and puts the question back when the answer fails. */
  async function send() {
    if (chat.pending || !chat.question.trim()) return;
    const question = chat.question,
      asked = context();
    // Earlier questions carry their subject, so follow-ups across selections make sense.
    const history = chat.messages.slice(-12).map(({ role, text, subject }) => ({
      role,
      text: (role === "user" ? `[About ${subject}] ${text}` : text).slice(
        0,
        8000,
      ),
    }));
    // Bound prior dialogue separately from server-built source context.
    while (JSON.stringify(history).length > 11000) history.shift();
    // Show the question at once; the answer can take several seconds. The answer joins
    // this branch's conversation even if the view moves to another branch meanwhile.
    const thread = chat.messages,
      key = branch;
    chat.pendingFor = key;
    thread.push({
      role: "user",
      text: question,
      subject: subjectOf(asked.anchor),
    });
    // Kept at once, so a reload during the answer does not lose the question.
    save(key, thread);
    chat.question = "";
    chat.pending = true;
    chat.partial = "";
    chat.live = [];
    chat.reveal = true;
    opened();
    redraw();
    // Where the answer looks, for the map: the place of each lookup that names one.
    const places = [];
    lookedAt(places, true);
    try {
      let response = null;
      // The answer streams in; each new model turn replaces earlier working text.
      await stream(
        "/api/ask",
        { ...asked, question, history, stream: true, using: using() },
        (event) => {
          if (event.type === "text") chat.partial += event.text;
          else if (event.type === "turn") chat.partial = "";
          else if (event.type === "lookup") {
            chat.live.push(event.text);
            if (event.place?.path) {
              places.push(event.place);
              lookedAt(places, true);
            }
          } else if (event.type === "error") throw new Error(event.message);
          else if (event.type === "done") response = event;
          paint();
        },
      );
      if (!response) throw new Error("The answer stopped before it finished.");
      thread.push({
        role: "assistant",
        asked,
        ...response.answer,
        references: response.references || {},
        omitted: response.context.omitted,
        lookups: response.lookups || [],
      });
      save(key, thread);
    } catch (e) {
      // Put the question back so it can be retried or edited.
      thread.pop();
      save(key, thread);
      if (!chat.question) chat.question = question;
      notice(e.message, true);
    } finally {
      // The trail of what the answer read stays on the map until the next question.
      lookedAt(places, false);
      chat.pending = false;
      chat.partial = "";
      chat.live = [];
      chat.reveal = true;
      redraw();
    }
  }
  return {
    /** Shows branch `key`'s conversation, loading its saved one the first time this page
     * opens that branch. Resolves true once a different conversation is in place. */
    async switchTo(key) {
      if (!key || key === branch) return false;
      branch = key;
      let thread = threads.get(key);
      if (!thread) {
        thread = [];
        threads.set(key, thread);
        chat.messages = thread;
        const saved = await api(historyRoute(key)).catch(() => ({
          messages: [],
        }));
        // Keep anything asked while it loaded after what was saved before.
        thread.unshift(...(saved.messages || []));
      }
      if (branch === key) chat.messages = thread;
      return true;
    },
    /** Asks `text` about the current selection (the map's composer), and opens the answer. */
    ask(text) {
      chat.question = text;
      return send();
    },
    /** True while an answer is on its way. */
    asking: () => chat.pending,
    /** True when this branch's conversation has messages (New conversation can clear it). */
    hasMessages: () => Boolean(chat.messages.length && !chat.pending),
    /** The last question of this branch's conversation, for the Conversations list. */
    lastQuestion: () =>
      chat.messages.filter((m) => m.role === "user").at(-1)?.text || "",
    /** Starts a new conversation on this branch. */
    clear() {
      if (chat.pending) return;
      chat.messages = [];
      threads.set(branch, chat.messages);
      chat.question = "";
      save();
      redraw();
    },
    /** Draws the conversation in `body` and its composer in `composerHost`; returns the
     * place that the next question is about, for the dock. */
    render(body, composerHost) {
      // New questions are about the current selection; earlier ones keep their own subject.
      const c = context(),
        subject = subjectOf(c.anchor);
      if (!chat.messages.length && !chat.pending)
        body.append(
          Text(
            `Ask about ${subject}: what it does, what changed or what to check. Answers use the code, its callers and dependencies at this revision, and can look up more of the repository read-only.`,
          ),
        );
      const thread = Thread();
      let lastSubject = null;
      for (const message of chat.messages) {
        // Mark the subject when it changes, so a moving conversation stays readable.
        if (message.role === "user" && message.subject !== lastSubject) {
          thread.append(SubjectMark("About " + message.subject));
          lastSubject = message.subject;
        }
        const links = {
          links: message.references || {},
          onLink: openReference,
        };
        // What the answer read beyond the selection, so it can be judged.
        const trimmed =
          message.omitted?.length > 0 && Note("Some context was trimmed");
        if (trimmed) trimmed.title = message.omitted.join("; ");
        thread.append(
          Message(
            { from: message.role },
            Prose(message.text, links),
            message.lookups?.length > 0 &&
              Note("Looked up: " + [...new Set(message.lookups)].join(" · ")),
            trimmed,
            message.suggestion &&
              Suggestion({
                text: Prose(message.suggestion, links),
                // While exploring a task's changes, a suggestion belongs with that task's
                // next round, which builds on the agent's work; a draft would start again
                // from main.
                action: message.added
                  ? Note("Added to requested changes")
                  : message.saved
                    ? Note("Added as a change")
                    : changeTarget()
                      ? btn("Add to requested changes", async () => {
                          await addToChanges(message);
                          message.added = true;
                          redraw();
                        })
                      : btn("Add as a change", async () => {
                          // Once only: the button gives way to a note, so a second tap adds
                          // nothing.
                          if (message.saved) return;
                          message.saved = true;
                          try {
                            await makeDraft({
                              anchor: message.asked.anchor,
                              sha: message.asked.sha,
                              text: message.suggestion,
                            });
                            save();
                          } catch (e) {
                            message.saved = false;
                            throw e;
                          } finally {
                            redraw();
                          }
                        }),
              }),
          ),
        );
      }
      // An answer still running for another branch's conversation shows there, not here.
      if (chat.pending && chat.pendingFor === branch)
        thread.append(pendingBubble(chat));
      body.append(thread);
      if (chat.reveal) {
        chat.reveal = false;
        // Once attached, put the latest question at the top so its answer reads from the start.
        const question = [...thread.querySelectorAll(".pk-message.is-user")].at(
          -1,
        );
        requestAnimationFrame(() =>
          question?.scrollIntoView({ block: "start", behavior: "smooth" }),
        );
      }
      // The dock shows the place above the composer (app.js), so the composer has none.
      composerHost.append(
        ReplyComposer({
          label: "Your question",
          placeholder: `Ask about ${subject}`,
          sendLabel: "Send question",
          busy: chat.pending,
          value: chat.question,
          docked: true,
          onInput: (text) => (chat.question = text),
          onSend: () => send(),
        }),
      );
      return `${[c.anchor.path?.split("/").at(-1) || rootSubject?.() || "Repository", c.anchor.symbol].filter(Boolean).join(" · ")} · ${revisionName(c.sha)}`;
    },
  };
}
