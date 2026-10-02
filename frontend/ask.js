/** @module Contextual, non-executing review conversations and explicit draft suggestions.
 * One conversation runs for the session and stays in view as the map moves; each question is
 * about whatever was selected when it was sent, and is marked when that changes. Answers
 * stream in as Claude writes them; lookups show while they happen. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";
export function createAsk({
  stream,
  context,
  redraw,
  notice,
  makeDraft,
  openReference,
}) {
  const chat = {
    messages: [],
    question: "",
    pending: false,
    partial: "",
    live: [],
    reveal: false,
  };
  /** A short name for what a question was about. */
  const subjectOf = (anchor) =>
    anchor.symbol || anchor.path?.split("/").at(-1) || "the repository";
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (label, fn) => {
    const b = el("button", label);
    b.type = "button";
    b.className = "btn";
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
  /** The in-progress reply: text as it streams (without a half-written suggestion line), or
   * Peek thinking until the first words arrive, plus any lookups made so far. */
  function pendingBubble(chat) {
    const waiting = el("article");
    waiting.className = "ask-message from-assistant is-pending";
    waiting.setAttribute("aria-live", "polite");
    const text = chat.partial.replace(/\n?Suggested (instruction|comment):[^]*$/, "");
    if (text.trim()) {
      waiting.classList.add("is-streaming");
      waiting.append(richText(text, "ask-text"));
    } else {
      const label = el("span", "Reading the code");
      label.className = "pending-text";
      waiting.append(peek("thinking"), label);
    }
    if (chat.live.length) {
      const read = el("p", "Looking up: " + [...new Set(chat.live)].join(" · "));
      read.className = "read-note ask-lookups";
      waiting.append(read);
    }
    return waiting;
  }
  let painting = 0;
  /** Repaints only the streaming bubble, once per frame, so typing elsewhere is undisturbed. */
  function paint() {
    if (painting) return;
    painting = requestAnimationFrame(() => {
      painting = 0;
      document
        .querySelector(".ask-message.is-pending")
        ?.replaceWith(pendingBubble(chat));
    });
  }
  return {
    render(body, composerHost) {
      // New questions are about the current selection; earlier ones keep their own subject.
      const c = context(),
        subject = subjectOf(c.anchor);
      // The header already shows the comparison; only the conversation's controls sit here.
      const head = el("div");
      head.className = "ask-head";
      if (chat.messages.length && !chat.pending)
        head.append(
          btn("New conversation", () => {
            chat.messages = [];
            chat.question = "";
            redraw();
          }),
        );
      body.append(head);
      if (!chat.messages.length && !chat.pending) {
        const empty = el(
          "p",
          `Ask about ${subject}: what it does, what changed or what to check. Answers use the code, its callers and dependencies at this revision, and can look up more of the repository read-only.`,
        );
        empty.className = "empty ask-empty";
        body.append(empty);
      }
      const thread = el("div");
      thread.className = "ask-thread";
      let lastSubject = null;
      for (const message of chat.messages) {
        // Mark the subject when it changes, so a moving conversation stays readable.
        if (message.role === "user" && message.subject !== lastSubject) {
          const about = el("p", "About " + message.subject);
          about.className = "ask-about";
          thread.append(about);
          lastSubject = message.subject;
        }
        const bubble = el("article");
        bubble.className = "ask-message from-" + message.role;
        const links = { links: message.references || {}, onLink: openReference };
        bubble.append(richText(message.text, "ask-text", links));
        if (message.lookups?.length) {
          // Show what the answer read beyond the selection, so it can be judged.
          const read = el("p", "Looked up: " + [...new Set(message.lookups)].join(" · "));
          read.className = "read-note ask-lookups";
          bubble.append(read);
        }
        if (message.omitted?.length) {
          const limited = el("p", "Some context was trimmed");
          limited.className = "read-note";
          limited.title = message.omitted.join("; ");
          bubble.append(limited);
        }
        if (message.suggestion) {
          const proposal = el("div");
          proposal.className = "ask-suggestion";
          const words = richText(message.suggestion, "workflow-text", links);
          proposal.append(
            el("span", "Suggested instruction"),
            words,
            btn("Save as draft instruction", async () => {
              await makeDraft({
                anchor: message.asked.anchor,
                sha: message.asked.sha,
                text: message.suggestion,
              });
            }),
          );
          bubble.append(proposal);
        }
        thread.append(bubble);
      }
      if (chat.pending) thread.append(pendingBubble(chat));
      body.append(thread);
      if (chat.reveal) {
        chat.reveal = false;
        // Once attached, put the latest question at the top so its answer reads from the start.
        const question = [...thread.querySelectorAll(".from-user")].at(-1);
        requestAnimationFrame(() =>
          question?.scrollIntoView({ block: "start", behavior: "smooth" }),
        );
      }
      const form = el("form"),
        label = el("label", "Your question"),
        input = el("textarea");
      label.className = "workflow-field";
      form.className = "dock-form";
      input.rows = 1;
      input.placeholder = `Ask about ${subject}`;
      input.setAttribute("aria-label", "Your question");
      label.classList.add("dock-input");
      label.firstChild.textContent = "";
      input.maxLength = 8000;
      input.value = chat.question;
      input.required = true;
      input.oninput = () => {
        chat.question = input.value;
      };
      label.append(input);
      form.append(label);
      const submit = iconButton(
        el("button"),
        chat.pending ? "pending" : "send",
        chat.pending ? "Thinking…" : "Send question",
      );
      submit.className = "btn primary icon-action";
      submit.type = "submit";
      submit.disabled = chat.pending;
      form.append(submit);
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (chat.pending || !chat.question.trim()) return;
        const question = chat.question,
          asked = context();
        // Earlier questions carry their subject, so follow-ups across selections make sense.
        const history = chat.messages.slice(-12).map(({ role, text, subject }) => ({
          role,
          text: (role === "user" ? `[About ${subject}] ${text}` : text).slice(0, 8000),
        }));
        // Bound prior dialogue separately from server-built source context.
        while (JSON.stringify(history).length > 11000) history.shift();
        // Show the question at once; the answer can take several seconds.
        chat.messages.push({ role: "user", text: question, subject: subjectOf(asked.anchor) });
        chat.question = "";
        chat.pending = true;
        chat.partial = "";
        chat.live = [];
        chat.reveal = true;
        redraw();
        try {
          let response = null;
          // The answer streams in; each new model turn replaces earlier working text.
          await stream("/api/ask", { ...asked, question, history, stream: true }, (event) => {
            if (event.type === "text") chat.partial += event.text;
            else if (event.type === "turn") chat.partial = "";
            else if (event.type === "lookup") chat.live.push(event.text);
            else if (event.type === "error") throw new Error(event.message);
            else if (event.type === "done") response = event;
            paint();
          });
          if (!response) throw new Error("The answer stopped before it finished.");
          chat.messages.push({
            role: "assistant",
            asked,
            ...response.answer,
            references: response.references || {},
            omitted: response.context.omitted,
            lookups: response.lookups || [],
          });
        } catch (e) {
          // Put the question back so it can be retried or edited.
          chat.messages.pop();
          if (!chat.question) chat.question = question;
          notice(e.message, true);
        } finally {
          chat.pending = false;
          chat.partial = "";
          chat.live = [];
          chat.reveal = true;
          redraw();
        }
      };
      const anchor = el(
        "p",
        `${[c.anchor.path?.split("/").at(-1) || "Repository", c.anchor.symbol].filter(Boolean).join(" · ")} · ${c.sha.slice(0, 7)}`,
      );
      anchor.className = "composer-anchor";
      anchor.title = anchor.textContent;
      composerHost.append(anchor, form);
    },
  };
}
