/** @module Contextual, non-executing review conversations and explicit draft suggestions. */
import { iconButton } from "./icons.js";
import { richText } from "./text.js";
import { peek } from "./peek.js";
export function createAsk({ api, context, redraw, notice, makeDraft }) {
  const conversations = new Map();
  let selectedContext = null;
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
  function current() {
    const c = selectedContext || context(),
      key = JSON.stringify(c);
    if (!conversations.has(key)) {
      if (conversations.size >= 20)
        conversations.delete(conversations.keys().next().value);
      conversations.set(key, {
        context: c,
        messages: [],
        question: "",
        pending: false,
      });
    }
    return conversations.get(key);
  }
  return {
    open() {
      if (selectedContext && (current().question || current().pending)) return;
      selectedContext = context();
    },
    followSelection() {
      if (selectedContext && (current().question || current().pending)) return;
      const live = context();
      const identity = (c) =>
        JSON.stringify([c.anchor, c.base, c.head, c.side]);
      if (!selectedContext || identity(live) !== identity(selectedContext))
        selectedContext = live;
    },
    render(body, composerHost) {
      const chat = current(),
        c = chat.context,
        subject = c.anchor.symbol || c.anchor.path?.split("/").at(-1) || "this repository";
      const head = el("div");
      head.className = "ask-head";
      const note = el(
        "p",
        `Claude Code · ${c.base.slice(0, 7)} → ${c.head.slice(0, 7)} · reads committed code, runs nothing`,
      );
      note.className = "read-note";
      head.append(note);
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
      for (const message of chat.messages) {
        const bubble = el("article");
        bubble.className = "ask-message from-" + message.role;
        bubble.append(richText(message.text, "ask-text"));
        if (message.lookups?.length) {
          // Show what the answer read beyond the selection, so it can be judged.
          const read = el("p", "Looked up: " + [...new Set(message.lookups)].join(" · "));
          read.className = "read-note ask-lookups";
          bubble.append(read);
        }
        if (message.omitted?.length) {
          const limited = el("p", "Context limited: " + message.omitted.join("; "));
          limited.className = "read-note";
          bubble.append(limited);
        }
        if (message.suggestion) {
          const proposal = el("div");
          proposal.className = "ask-suggestion";
          const words = richText(message.suggestion, "workflow-text");
          proposal.append(
            el("span", "Suggested instruction"),
            words,
            btn("Save as draft instruction", async () => {
              await makeDraft({
                anchor: c.anchor,
                sha: c.sha,
                text: message.suggestion,
              });
            }),
          );
          bubble.append(proposal);
        }
        thread.append(bubble);
      }
      if (chat.pending) {
        const waiting = el("article");
        waiting.className = "ask-message from-assistant is-pending";
        waiting.setAttribute("aria-live", "polite");
        waiting.append(peek("thinking"), el("span", "Reading the code"));
        thread.append(waiting);
      }
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
      input.placeholder = `Ask about ${c.anchor.symbol || c.anchor.path?.split("/").at(-1) || "this repository"}`;
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
        const question = chat.question;
        const history = chat.messages
          .slice(-12)
          .map(({ role, text }) => ({ role, text }));
        // Bound prior dialogue separately from server-built source context.
        while (JSON.stringify(history).length > 11000) history.shift();
        // Show the question at once; the answer can take several seconds.
        chat.messages.push({ role: "user", text: question });
        chat.question = "";
        chat.pending = true;
        chat.reveal = true;
        redraw();
        try {
          const response = await api("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...c, question, history }),
          });
          chat.messages.push({
            role: "assistant",
            ...response.answer,
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
