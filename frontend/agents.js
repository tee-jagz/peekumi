/** @module The owner's choice of provider, model and effort for Ask and for tasks.
 * The server lists the providers, the models that each provider reports (each with its own
 * effort levels) and whether each provider is ready (`GET /api/agents`); this module never
 * lists them itself. The choice is kept on this
 * device, for each repository, and goes with each Ask question, task preview and commit
 * message request as `using: {agent, model, effort}`; the server checks it there. Without a
 * saved choice, requests send none and the server uses its defaults. */

import {
  Actions,
  Button,
  Choices,
  Group,
  IconButton,
  InlineError,
  List,
  Modal,
  Note,
  PageHeader,
  Row,
  SegmentedControl,
  Stack,
  TextField,
  TitleEnd,
  openModal,
} from "./ui.js";

const JOBS = {
  ask: { title: "Ask", note: "Answers questions", heading: "Ask uses" },
  task: { title: "Tasks", note: "Changes code", heading: "Tasks use" },
};
/** A typed model name: the same rule the server checks. */
const validModel = (name) =>
  /^[A-Za-z0-9._:/@[\]][A-Za-z0-9._:/@[\]-]{0,99}$/.test(name);
/** An effort level as a label: "high" → "High", "xhigh" → "Extra high". */
const title = (word) =>
  word === "xhigh" ? "Extra high" : word[0].toUpperCase() + word.slice(1);
/** Effort levels from least to most, so a list joined from several models reads in order. */
const ORDER = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"];
const inOrder = (levels) =>
  [...new Set(levels)].sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
  );
/** A provider's models for `job`, after one "Default" row for the model it uses on its own
 * (none for a provider without a default model, such as OpenRouter). */
function modelsOf(agent, job) {
  const listed = (agent.models[job] || []).filter((m) => m.id !== null);
  if (agent.defaultModel === false) return listed;
  const efforts = inOrder(listed.flatMap((m) => m.efforts));
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
    loading = null,
    // Counts the lists that a save returned (a new API key). A read that started before a save
    // never replaces the list that the save returned.
    saves = 0;
  /** Keeps the list that a save returned. */
  const saveResult = (data) => {
    saves++;
    catalog = data;
    return data;
  };
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
  /** Loads the agent list from the server once; `force` reads it again (for a new status). A
   * read that a save overtook keeps the newer list. */
  function load(force = false) {
    if (force || (!catalog && !loading)) {
      const at = saves;
      loading = api("/api/agents")
        .then((data) => {
          if (at === saves) catalog = data;
          return catalog;
        })
        .finally(() => (loading = null));
    }
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
    const model = modelsOf(agent, job).find(
      (m) => m.id === (choice.model ?? null),
    );
    // A provider with no model yet (none saved, or an old choice) says so, never "null".
    const name = `${agent.short} · ${model ? model.label : choice.model || "choose a model"}`;
    return choice.effort && choice.effort !== "auto"
      ? `${name} · ${choice.effort}`
      : name;
  }
  /** A name before the agent list has loaded: the ID with a capital, such as "Codex". It
   * starts the list loading, so the next drawing has the real name. */
  const fallback = (id) => {
    if (!catalog) load().catch(() => {});
    return id ? id[0].toUpperCase() + id.slice(1) : "";
  };
  /** The full name of the agent with `id`, such as "Claude Code". */
  const label = (id) =>
    catalog?.agents.find((a) => a.id === id)?.label || fallback(id);
  /** The short name of the agent with `id`, such as "Claude". */
  const short = (id) =>
    catalog?.agents.find((a) => a.id === id)?.short || fallback(id);
  /** True when the agent with `id` asks the owner before commands in a session (the server's
   * `asksBeforeCommands`). Until the list loads it is false, and the list starts to load. */
  const asksBeforeCommands = (id) => {
    if (!catalog) load().catch(() => {});
    return Boolean(
      catalog?.agents.find((a) => a.id === id)?.asksBeforeCommands,
    );
  };

  /** Opens the Agents sheet: one row for each job, each opening its list. `job` opens that
   * list directly. `closed` runs when the sheet closes, so the caller can show the new choice. */
  async function open(job = null, closed = () => {}) {
    let hide = null;
    const close = () => {
      hide?.();
      closed();
    };
    const dialog = Modal(
      { label: "Agents", onClose: close },
      Note("Checking your agents…"),
    );
    const box = dialog.querySelector(".pk-modal-body");
    hide = openModal(dialog);
    // True while the owner types a model name, also when a listed model is the choice.
    let typing = false,
      // The model search text, and true while the owner enters a new API key.
      query = "",
      keying = false,
      // A provider that the owner looks at but cannot choose yet (it needs a key first): the
      // working choice stays until the key is saved.
      trying = null,
      // The problem with a typed model name, shown under its field.
      modelError = null;
    try {
      await load(true);
    } catch (e) {
      box.replaceChildren(
        InlineError({ title: "No agent list", text: e.message }),
      );
      return;
    }
    const head = (title, back) =>
      PageHeader({
        title,
        back: Boolean(back),
        backLabel: "Back to Agents",
        onBack: back,
        actions: back
          ? []
          : [
              IconButton({
                icon: "close",
                label: "Close",
                quiet: true,
                onClick: close,
              }),
            ],
      });
    const main = () =>
      box.replaceChildren(
        head("Agents"),
        List(
          ...Object.entries(JOBS).map(([id, job]) =>
            Row({
              title: job.title,
              meta: job.note,
              end: TitleEnd(describe(id) || ""),
              onClick: () => list(id),
            }),
          ),
        ),
        Note("Saved on this device, for this repository."),
      );
    /** One choice from a list: a segmented control for two to four, else rows. */
    const pick = (label, options, value, onChange) =>
      options.length >= 2 && options.length <= 4
        ? SegmentedControl({ label, options, value, onChange })
        : Choices({
            label,
            options: options.map((o) => ({ ...o, title: o.label })),
            value,
            onChange,
          });
    // One job's choice: the provider, then one of its models, then that model's effort.
    const list = (job) => {
      const choice = current(job),
        agents = catalog.agents.filter((a) => a.jobs.includes(job)),
        agent =
          agents.find((a) => a.id === (trying || choice?.agent)) || agents[0];
      // Provider: one each, with its problem when it is not ready. A provider that only needs
      // a key stays selectable: its list asks for the key.
      const providers = pick(
        "Provider",
        agents.map((a) => ({
          value: a.id,
          label: a.label,
          disabled: !a.status.ready && !a.key,
          title: a.status.ready ? null : a.status.reason,
        })),
        agent.id,
        (id) => {
          const a = agents.find((x) => x.id === id);
          typing = false;
          query = "";
          keying = false;
          modelError = null;
          // A provider without its key is shown with the key form, but not chosen.
          if (a.key && !a.key.set) {
            trying = a.id;
            return list(job);
          }
          trying = null;
          // Without a default model, start on the provider's first model.
          const first =
            a.defaultModel === false ? (modelsOf(a, job)[0]?.id ?? null) : null;
          set(job, { agent: a.id, model: first, effort: "auto" });
          list(job);
        },
      );
      const problems = agents
        .filter((a) => !a.status.ready && !a.key)
        .map((a) => Note(`${a.label}: ${a.status.reason}`));
      // A provider with an API key: the key form until a key is saved, then its key row.
      if (agent.key && (!agent.key.set || keying)) {
        box.replaceChildren(
          head(JOBS[job].heading, main),
          Group({ title: "Provider" }, providers),
          ...keyForm(agent, job),
        );
        box.querySelector('input[type="password"]')?.focus();
        return;
      }
      // Models of the provider, as it reports them; Other model takes any name.
      const models = modelsOf(agent, job);
      const chosen = models.find(
        (m) =>
          m.id === (choice?.agent === agent.id ? (choice.model ?? null) : null),
      );
      const shown = (m) =>
        !query ||
        `${m.label} ${m.id} ${m.note}`
          .toLowerCase()
          .includes(query.toLowerCase());
      const group = Choices({
        label: "Model",
        value: typing || !chosen ? "other" : String(models.indexOf(chosen)),
        options: [
          ...models.map((m, i) => ({
            value: String(i),
            title: m.label,
            meta: m.note,
            hidden: !shown(m),
          })),
          { value: "other", title: "Other model", meta: "Type its name" },
        ],
        onChange: (value) => {
          modelError = null;
          if (value === "other") {
            typing = true;
            list(job);
            box.querySelector('input[name="model"]')?.focus();
            return;
          }
          typing = false;
          set(job, {
            agent: agent.id,
            model: models[Number(value)].id,
            effort: "auto",
          });
          list(job);
        },
      });
      // A long list (OpenRouter has hundreds of models) gets a search box.
      const search = TextField({
        label: "Search models",
        type: "search",
        value: query,
        placeholder: `Search ${models.length} models`,
        autocomplete: "off",
        onInput: (event) => {
          query = event.target.value;
          for (const row of group.querySelectorAll("[data-value]"))
            if (row.dataset.value !== "other")
              row.hidden = !shown(models[Number(row.dataset.value)]);
        },
      });
      // A typed model name, for Other model.
      const useTyped = () => {
        const typed = box.querySelector('input[name="model"]').value.trim();
        if (!validModel(typed)) {
          modelError = "Use only letters, digits and ._:/@-[] in a model name.";
          return list(job);
        }
        typing = false;
        modelError = null;
        set(job, {
          agent: agent.id,
          model: typed,
          effort: choice?.effort || "auto",
        });
        list(job);
      };
      const custom =
        (typing || !chosen) &&
        Stack(
          TextField({
            label: "Model name",
            name: "model",
            value: chosen ? "" : choice?.model || "",
            placeholder: "Model name",
            autocomplete: "off",
            error: modelError,
            onEnter: useTyped,
          }),
          Actions({}, Button({ label: "Use", onClick: useTyped })),
        );
      // Effort: the levels of the chosen model (all of the provider's for a typed name).
      const levels = chosen?.efforts?.length
        ? chosen.efforts
        : inOrder(models.flatMap((m) => m.efforts || []));
      const efforts = pick(
        "Effort",
        ["auto", ...levels].map((effort) => ({
          value: effort,
          label: title(effort),
        })),
        choice?.effort || "auto",
        (effort) => {
          set(job, {
            agent: agent.id,
            model: choice?.agent === agent.id ? (choice.model ?? null) : null,
            effort,
          });
          list(job);
        },
      );
      const auto = chosen?.defaultEffort
        ? `Auto uses ${chosen.defaultEffort}.`
        : "Auto lets the provider decide.";
      const keyRow = [];
      if (agent.key?.set)
        keyRow.push(
          Row({
            title: `API key •••• ${agent.key.end}`,
            meta: agent.key.fromEnvironment
              ? "From PEEKUMI_OPENROUTER_KEY"
              : null,
            chevron: false,
          }),
          !agent.key.fromEnvironment &&
            Actions(
              {},
              Button({
                label: "Replace",
                variant: "plain",
                onClick: () => {
                  keying = true;
                  list(job);
                },
              }),
              Button({
                label: "Remove",
                variant: "danger",
                onClick: async () => {
                  saveResult(
                    await api("/api/agents/openrouter-key", {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: "{}",
                    }),
                  );
                  list(job);
                },
              }),
            ),
          Note(
            job === "ask"
              ? `Ask sends your question and the code it reads to ${agent.label}, which sends them to the provider of the model. Ask still only reads.`
              : `The task sends your instructions and the code it reads to ${agent.label}, which sends them to the provider of the model.`,
          ),
        );
      if (agent.notes?.[job]) keyRow.unshift(Note(agent.notes[job]));
      box.replaceChildren(
        head(JOBS[job].heading, main),
        Group({ title: "Provider" }, providers, ...problems, ...keyRow),
        Group(
          { title: "Model" },
          models.length > LONG && search,
          group,
          custom,
        ),
        Group(
          { title: "Effort" },
          efforts,
          Note(
            `${auto} Higher effort works more carefully, but slower.` +
              (job === "task"
                ? " A new task uses this; each task keeps the choice it started with."
                : ""),
          ),
        ),
      );
    };
    /** The form that adds a provider's API key; the server tests the key before it saves it. */
    function keyForm(agent, job) {
      let saving = false;
      const save = async () => {
        if (saving) return;
        saving = true;
        const input = box.querySelector('input[type="password"]');
        status.textContent = "Testing the key…";
        try {
          saveResult(
            await api("/api/agents/openrouter-key", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: input.value }),
            }),
          );
          keying = false;
          const fresh = catalog.agents.find((a) => a.id === agent.id);
          const first = modelsOf(fresh, job)[0]?.id ?? null;
          // The key works: now the provider becomes the choice, on its first model.
          if (
            trying === agent.id ||
            (current(job)?.agent === agent.id && !current(job).model)
          )
            set(job, { agent: agent.id, model: first, effort: "auto" });
          trying = null;
          list(job);
        } catch (e) {
          status.textContent = e.message;
          saving = false;
        }
      };
      const status = Note();
      status.setAttribute("role", "status");
      return [
        Group(
          { title: `${agent.label} API key` },
          TextField({
            label: `${agent.label} API key`,
            type: "password",
            autocomplete: "off",
            placeholder: `${agent.label} API key`,
            onEnter: save,
          }),
          status,
          Actions(
            {},
            agent.key.set &&
              Button({
                label: "Cancel",
                onClick: () => {
                  keying = false;
                  list(job);
                },
              }),
            Button({
              label: "Test and save",
              variant: "primary",
              onClick: save,
            }),
          ),
          Note(
            `You make a key in your ${agent.label} account. The server keeps it in Peekumi's private state folder, and only your user account can read it. The app never shows the key again, only its last 4 characters.`,
          ),
        ),
      ];
    }
    if (job) list(job);
    else main();
  }
  /** Why the provider chosen for `job` cannot run now, or null when it is ready. */
  const problem = (job) => {
    const choice = current(job),
      agent = catalog?.agents.find((a) => a.id === choice?.agent);
    return agent && !agent.status.ready
      ? `${agent.label}: ${agent.status.reason}`
      : null;
  };
  return {
    load,
    using,
    current,
    describe,
    label,
    short,
    asksBeforeCommands,
    problem,
    open,
  };
}
