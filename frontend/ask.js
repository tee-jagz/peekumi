/** @module Contextual, non-executing review conversations and explicit draft suggestions. */
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
      selectedContext = context();
    },
    followSelection() {
      const live = context();
      const identity = (c) =>
        JSON.stringify([c.anchor, c.base, c.head, c.side]);
      if (!selectedContext || identity(live) !== identity(selectedContext))
        selectedContext = live;
    },
    render(body, composerHost) {
      const chat = current(),
        c = chat.context;
      const title = el(
        "h3",
        "Ask about " + (c.anchor.symbol || c.anchor.path || "this repository"),
      );
      title.className = "workflow-group";
      const note = el(
        "p",
        `Claude Code · ${c.base.slice(0, 8)} → ${c.head.slice(0, 8)} · conversation only`,
      );
      note.className = "read-note";
      body.append(title, note);
      const help = el(
        "p",
        "Ask uses committed code, the comparison, rules and review comments. It cannot edit code or start a run. This conversation stays in this page until you reload.",
      );
      help.className = "read-note";
      body.append(help);
      for (const message of chat.messages) {
        const card = el("article");
        card.className = "workflow-card";
        card.append(el("strong", message.role === "user" ? "You" : "Ask"));
        const text = el("p", message.text);
        text.className = "workflow-text";
        card.append(text);
        if (message.omitted?.length)
          card.append(
            el("p", "Context limited: " + message.omitted.join("; ")),
          );
        if (message.suggestion) {
          const proposal = el("p", message.suggestion);
          proposal.className = "workflow-text";
          card.append(
            proposal,
            btn("Make draft comment", async () => {
              await makeDraft({
                anchor: c.anchor,
                sha: c.sha,
                text: message.suggestion,
              });
            }),
          );
        }
        body.append(card);
      }
      const form = el("form"),
        label = el("label", "Your question"),
        input = el("textarea");
      label.className = "workflow-field";
      form.className = "dock-form";
      input.rows = 2;
      input.placeholder = "Ask about this code…";
      input.setAttribute("aria-label", "Your question");
      label.classList.add("dock-input");
      label.firstChild.textContent = "";
      input.maxLength = 8000;
      input.value = chat.question;
      input.required = true;
      input.disabled = chat.pending;
      input.oninput = () => {
        chat.question = input.value;
      };
      label.append(input);
      form.append(label);
      const submit = el("button", chat.pending ? "Thinking…" : "Ask");
      submit.className = "btn primary";
      submit.type = "submit";
      submit.disabled = chat.pending;
      form.append(submit);
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (chat.pending || !chat.question.trim()) return;
        chat.pending = true;
        const question = chat.question;
        const history = chat.messages
          .slice(-12)
          .map(({ role, text }) => ({ role, text }));
        // Bound prior dialogue separately from server-built source context.
        while (JSON.stringify(history).length > 11000) history.shift();
        redraw();
        try {
          const response = await api("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...c, question, history }),
          });
          chat.messages.push(
            { role: "user", text: question },
            {
              role: "assistant",
              ...response.answer,
              omitted: response.context.omitted,
            },
          );
          chat.question = "";
        } catch (e) {
          notice(e.message, true);
        } finally {
          chat.pending = false;
          redraw();
        }
      };
      const anchor = el(
        "p",
        `${c.anchor.symbol || c.anchor.path || "Repository"} · ${c.sha.slice(0, 8)}`,
      );
      anchor.className = "composer-anchor";
      anchor.title = anchor.textContent;
      composerHost.append(anchor, form);
      const clear = btn("New conversation", () => {
        chat.messages = [];
        chat.question = "";
        redraw();
      });
      clear.disabled = chat.pending;
      body.append(clear);
    },
  };
}
