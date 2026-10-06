/** @module The owner's choice of provider, model and effort for Ask and for tasks.
 * The server lists the providers, the models that each provider reports (each with its own
 * effort levels) and whether each provider is ready (`GET /api/agents`); this module never
 * lists them itself. The choice is kept on this
 * device, for each repository, and goes with each Ask question, task preview and commit
 * message request as `using: {agent, model, effort}`; the server checks it there. Without a
 * saved choice, requests send none and the server uses its defaults. */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const JOBS = {
  ask: { title: "Ask", note: "Answers questions", heading: "Ask uses" },
  task: { title: "Tasks", note: "Changes code", heading: "Tasks use" },
};
/** A typed model name: the same rule the server checks. */
const validModel = (name) => /^[A-Za-z0-9._:/@[\]][A-Za-z0-9._:/@[\]-]{0,99}$/.test(name);
/** An effort level as a label: "high" → "High", "xhigh" → "Extra high". */
const title = (word) =>
  word === "xhigh" ? "Extra high" : word[0].toUpperCase() + word.slice(1);
/** A provider's models for `job`, after one "Default" row for the model it uses on its own
 * (none for a provider without a default model, such as OpenRouter). */
function modelsOf(agent, job) {
  const listed = (agent.models[job] || []).filter((m) => m.id !== null);
  if (agent.defaultModel === false) return listed;
  const efforts = [...new Set(listed.flatMap((m) => m.efforts))];
  const fallback = (agent.models[job] || []).find((m) => m.id === null);
  return [
    {
      id: null,
      label: "Default",
      note: `The model ${agent.label} uses on its own`,
      efforts: fallback?.efforts?.length ? fallback.efforts : efforts,
    },
    ...listed,
  ];
}
/** Lists longer than this get a search box. */
const LONG = 12;

export function createAgents({ api, repo }) {
  let catalog = null,
    loading = null;
  const key = () => "peekumi.agents." + (repo() || "default");
  function saved() {
    try {
      return JSON.parse(localStorage.getItem(key())) || {};
    } catch {
      return {};
    }
  }
  function set(job, choice) {
    const all = saved();
    all[job] = choice;
    try {
      localStorage.setItem(key(), JSON.stringify(all));
    } catch {
      /* Private mode: the choice lasts until the page closes. */
    }
    memory[job] = choice;
  }
  // A copy in memory, for browsers that cannot store it.
  const memory = {};
  /** Loads the agent list from the server once; `force` reads it again (for a new status). */
  function load(force = false) {
    if (force || (!catalog && !loading))
      loading = api("/api/agents")
        .then((data) => (catalog = data))
        .finally(() => (loading = null));
    return loading || Promise.resolve(catalog);
  }
  /** The choice to send for `job`: saved on this device, else null (the server's default). */
  const using = (job) => saved()[job] || memory[job] || null;
  /** The choice in effect for `job`, for display: the saved one, else the server's default. */
  const current = (job) => using(job) || catalog?.defaults[job] || null;
  /** "Claude · Opus · high": the model's label, or the agent and typed model name, and the
   * effort unless it is auto. Null until the agent list has loaded. */
  function describe(job) {
    const choice = current(job),
      agent = catalog?.agents.find((a) => a.id === choice?.agent);
    if (!agent) return null;
    const model = modelsOf(agent, job).find((m) => m.id === (choice.model ?? null));
    // A provider with no model yet (none saved, or an old choice) says so, never "null".
    const name = `${agent.short} · ${model ? model.label : choice.model || "choose a model"}`;
    return choice.effort && choice.effort !== "auto" ? `${name} · ${choice.effort}` : name;
  }
  /** The full name of the agent with `id`, such as "Claude Code". */
  const label = (id) => catalog?.agents.find((a) => a.id === id)?.label || id;

  /** Opens the Agents sheet: one row for each job, each opening its list. `job` opens that
   * list directly. `closed` runs when the sheet closes, so the caller can show the new choice. */
  async function open(job = null, closed = () => {}) {
    const dialog = el("dialog", "merge-dialog agents-dialog");
    dialog.setAttribute("aria-label", "Agents");
    const box = el("div", "merge-sheet");
    dialog.append(box);
    const close = () => {
      dialog.close();
      dialog.remove();
      closed();
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
    document.body.append(dialog);
    dialog.showModal();
    box.append(el("p", "read-note", "Checking your agents…"));
    // True while the owner types a model name, also when a listed model is the choice.
    let typing = false,
      // The model search text, and true while the owner enters a new API key.
      query = "",
      keying = false,
      // A provider that the owner looks at but cannot choose yet (it needs a key first): the
      // working choice stays until the key is saved.
      trying = null;
    try {
      await load(true);
    } catch (e) {
      box.replaceChildren(el("p", "merge-note", e.message));
      return;
    }
    const head = (title, back) => {
      const row = el("div", "agents-head");
      if (back) {
        const b = el("button", "agents-back", "‹");
        b.type = "button";
        b.setAttribute("aria-label", "Back to Agents");
        b.onclick = back;
        row.append(b);
      }
      row.append(el("h2", "merge-title", title));
      if (!back) {
        const x = el("button", "agents-back", "×");
        x.type = "button";
        x.setAttribute("aria-label", "Close");
        x.onclick = close;
        row.append(x);
      }
      return row;
    };
    const main = () => {
      const rows = el("div", "agents-rows");
      for (const [id, job] of Object.entries(JOBS)) {
        const row = el("button", "agents-row");
        row.type = "button";
        const text = el("span", "agents-text");
        text.append(el("strong", "", job.title), el("small", "", job.note));
        row.append(text, el("span", "agents-value", describe(id) || ""), el("span", "agents-chevron", "›"));
        row.onclick = () => list(id);
        rows.append(row);
      }
      box.replaceChildren(head("Agents"), rows, el("p", "read-note", "Saved on this device, for this repository."));
    };
    // One job's choice: the provider, then one of its models, then that model's effort.
    const list = (job) => {
      const choice = current(job),
        agents = catalog.agents.filter((a) => a.jobs.includes(job)),
        agent = agents.find((a) => a.id === (trying || choice?.agent)) || agents[0];
      const section = (text) => el("p", "agents-label", text);
      // Provider: one button each, with its problem when it is not ready.
      const providers = el("div", "seg agents-providers");
      providers.setAttribute("role", "group");
      providers.setAttribute("aria-label", "Provider");
      for (const a of agents) {
        const b = el("button", "", a.label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(a.id === agent.id));
        // A provider that only needs a key stays selectable: its list asks for the key.
        b.disabled = !a.status.ready && !a.key;
        if (!a.status.ready) b.title = a.status.reason;
        b.onclick = () => {
          typing = false;
          query = "";
          keying = false;
          // A provider without its key is shown with the key form, but not chosen.
          if (a.key && !a.key.set) {
            trying = a.id;
            return list(job);
          }
          trying = null;
          // Without a default model, start on the provider's first model.
          const first = a.defaultModel === false ? modelsOf(a, job)[0]?.id ?? null : null;
          set(job, { agent: a.id, model: first, effort: "auto" });
          list(job);
        };
        providers.append(b);
      }
      const problems = agents
        .filter((a) => !a.status.ready && !a.key)
        .map((a) => el("small", "agents-problem", `${a.label}: ${a.status.reason}`));
      // A provider with an API key: the key form until a key is saved, then its key row.
      if (agent.key && (!agent.key.set || keying)) {
        box.replaceChildren(head(JOBS[job].heading, main), section("Provider"), providers, ...keyForm(agent, job));
        box.querySelector(".agents-key input")?.focus();
        return;
      }
      // Models of the provider, as it reports them; Other model takes any name.
      const models = modelsOf(agent, job),
        group = el("div", "agents-rows");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Model");
      const chosen = models.find((m) => m.id === (choice?.agent === agent.id ? choice.model ?? null : null));
      const option = (title, note, checked, pick) => {
        const row = el("label", "agents-option");
        const radio = el("input");
        radio.type = "radio";
        radio.name = "agents-" + job;
        radio.checked = checked;
        radio.onchange = pick;
        const text = el("span", "agents-text");
        text.append(el("span", "", title), el("small", "", note));
        row.append(radio, text);
        return row;
      };
      // A long list (OpenRouter has hundreds of models) gets a search box.
      const search = el("input", "agents-search");
      search.type = "search";
      search.placeholder = `Search ${models.length} models`;
      search.setAttribute("aria-label", "Search models");
      search.value = query;
      const shown = (m) =>
        !query || `${m.label} ${m.id} ${m.note}`.toLowerCase().includes(query.toLowerCase());
      search.oninput = () => {
        query = search.value;
        for (const row of group.querySelectorAll(".agents-option[data-model]"))
          row.hidden = !shown(models[Number(row.dataset.model)]);
      };
      for (const model of models)
        group.append(
          Object.assign(
            option(model.label, model.note, !typing && model === chosen, () => {
              typing = false;
              set(job, { agent: agent.id, model: model.id, effort: "auto" });
              list(job);
            }),
            { hidden: !shown(model) },
          ),
        );
      group.querySelectorAll(".agents-option").forEach((row, i) => (row.dataset.model = i));
      group.append(
        option("Other model", "Type its name", typing || !chosen, () => {
          typing = true;
          list(job);
          box.querySelector(".agents-custom input")?.focus();
        }),
      );
      const custom = el("div", "agents-custom");
      custom.hidden = Boolean(chosen) && !typing;
      const name = el("input");
      name.type = "text";
      name.placeholder = "Model name";
      name.setAttribute("aria-label", "Model name");
      name.autocomplete = "off";
      name.value = chosen ? "" : choice?.model || "";
      const use = el("button", "btn", "Use");
      use.type = "button";
      const problem = el("small", "agents-problem");
      use.onclick = () => {
        const typed = name.value.trim();
        if (!validModel(typed)) {
          problem.textContent = "Use only letters, digits and ._:/@-[] in a model name.";
          return;
        }
        typing = false;
        set(job, { agent: agent.id, model: typed, effort: choice?.effort || "auto" });
        list(job);
      };
      const line = el("div", "agents-custom-line");
      line.append(name, use);
      custom.append(line, problem);
      // Effort: the levels of the chosen model (all of the provider's for a typed name).
      const levels = chosen?.efforts?.length
        ? chosen.efforts
        : [...new Set(models.flatMap((m) => m.efforts || []))];
      const efforts = el("div", "agents-efforts");
      efforts.setAttribute("role", "group");
      efforts.setAttribute("aria-label", "Effort");
      for (const effort of ["auto", ...levels]) {
        const b = el("button", "agents-effort", title(effort));
        b.type = "button";
        b.setAttribute("aria-pressed", String((choice?.effort || "auto") === effort));
        b.onclick = () => {
          set(job, { agent: agent.id, model: choice?.agent === agent.id ? choice.model ?? null : null, effort });
          list(job);
        };
        efforts.append(b);
      }
      const auto = chosen?.defaultEffort
        ? `Auto uses ${chosen.defaultEffort}.`
        : "Auto lets the provider decide.";
      const keyRow = [];
      if (agent.key?.set) {
        const row = el("div", "agents-keyrow");
        row.append(el("span", "", `API key •••• ${agent.key.end}`));
        if (agent.key.fromEnvironment) row.append(el("small", "", "From PEEKUMI_OPENROUTER_KEY"));
        else {
          const replace = el("button", "btn link-button", "Replace");
          replace.type = "button";
          replace.onclick = () => {
            keying = true;
            list(job);
          };
          const remove = el("button", "btn link-button agents-remove", "Remove");
          remove.type = "button";
          remove.onclick = async () => {
            catalog = await api("/api/agents/openrouter-key", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            list(job);
          };
          row.append(replace, remove);
        }
        keyRow.push(
          row,
          el(
            "p",
            "agents-privacy",
            job === "ask"
              ? `Ask sends your question and the code it reads to ${agent.label}, which sends them to the provider of the model. Ask still only reads.`
              : `The task sends your instructions and the code it reads to ${agent.label}, which sends them to the provider of the model.`,
          ),
        );
      }
      if (agent.notes?.[job]) keyRow.unshift(el("p", "read-note", agent.notes[job]));
      box.replaceChildren(
        head(JOBS[job].heading, main),
        section("Provider"),
        providers,
        ...problems,
        ...keyRow,
        section("Model"),
        ...(models.length > LONG ? [search] : []),
        group,
        custom,
        section("Effort"),
        efforts,
        el(
          "p",
          "read-note",
          `${auto} Higher effort works more carefully, but slower.` +
            (job === "task" ? " A new task uses this; each task keeps the choice it started with." : ""),
        ),
      );
    };
    /** The form that adds a provider's API key; the server tests the key before it saves it. */
    function keyForm(agent, job) {
      const form = el("form", "agents-key"),
        input = el("input"),
        save = el("button", "btn primary", "Test and save"),
        problem = el("small", "agents-problem");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = `${agent.label} API key`;
      input.setAttribute("aria-label", `${agent.label} API key`);
      save.type = "submit";
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        problem.textContent = "Testing the key…";
        try {
          catalog = await api("/api/agents/openrouter-key", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: input.value }),
          });
          keying = false;
          const fresh = catalog.agents.find((a) => a.id === agent.id);
          const first = modelsOf(fresh, job)[0]?.id ?? null;
          // The key works: now the provider becomes the choice, on its first model.
          if (trying === agent.id || (current(job)?.agent === agent.id && !current(job).model))
            set(job, { agent: agent.id, model: first, effort: "auto" });
          trying = null;
          list(job);
        } catch (e) {
          problem.textContent = e.message;
          save.disabled = false;
        }
      };
      const cancel = el("button", "btn", "Cancel");
      cancel.type = "button";
      cancel.onclick = () => {
        keying = false;
        list(job);
      };
      const buttons = el("div", "merge-buttons");
      buttons.append(...(agent.key.set ? [cancel] : []), save);
      form.append(input, problem, buttons);
      return [
        el("p", "agents-label", `${agent.label} API key`),
        form,
        el(
          "p",
          "read-note",
          `You make a key in your ${agent.label} account. The server keeps it in Peekumi's private state folder, and only your user account can read it. The app never shows the key again, only its last 4 characters.`,
        ),
      ];
    }
    if (job) list(job);
    else main();
  }
  return { load, using, current, describe, label, open };
}
