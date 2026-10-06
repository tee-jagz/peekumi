# Extending Peekumi

This document tells you how to add a language, an agent provider or a tunnel provider. Each one has a contract, a place where you register it and a test that checks the contract. Keep the contract, and the interface needs no change: the app reads names, file extensions, capabilities and provider abilities from the server.

Open an issue with the **Language support** or **Agent provider** form before you start. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules that every change keeps.

## Add a language

A language adapter changes the source of one language into the shared model: declarations, documentation, explicit types, imports and relationship candidates. The engine does the rest (Git access, the cache, comparisons and the map). The contract is the `LanguageAdapter` trait in [backend/adapters/mod.rs](../backend/adapters/mod.rs).

### Choose a parser

An adapter can parse in two ways:

- **In the server, in Rust.** The Rust adapter uses the `syn` crate. This needs no other program on the computer.
- **With a helper program.** The Python adapter runs `python_ast.py` with the Python interpreter on the computer. The TypeScript adapter runs `typescript_ast.mjs` with Node and the `typescript` package. The helper reads source text and writes JSON.

Each parser must obey these rules:

- It parses the source text that it gets. It never imports, compiles, evaluates or runs the inspected code, and it never reads other files of the repository.
- It uses no network.
- The same input always gives the same output.
- A parse error is a result for that file, for example `{"symbols": [], "imports": [], "analysis": "parse error: …"}`. It does not stop the batch.
- If the helper's program is not on the computer, each file shows a label. Peekumi still shows the file.

### Steps

1. **Write the adapter** in `backend/adapters/<language>.rs`, and put a helper program beside it if you need one. Implement the trait:
   - `id`: a stable lower-case key, such as `python`. The cache and the analysis batches use it.
   - `name`: the name that people read, such as `Python`. The Details view shows it.
   - `extensions`: the file extensions, with no dot. Another adapter must not read the same extension.
   - `capabilities`: what the adapter extracts. Remove an item from the default list when the adapter does not do it.
   - `limitations`: one honest sentence about what the adapter does not do. Details shows it.
   - `identity`: the parser and its version, for example the interpreter version. A new identity makes the cache read the files again.
   - `analyze`: one JSON result for each `(path, source)` pair, in the same order. Use the same field names as [python_ast.py](../backend/adapters/python_ast.py): `symbols`, `imports`, `details`, `relationships` and `analysis`.
   - `resolve`: the repository paths that an import can mean. Return an empty list when the target is outside the repository or unknown. Never invent a target.
   - `resolve_relationship`: keep the default unless the language needs its own lookup.
2. **Register the adapter** in `all()` in `mod.rs`.
3. **Add each new file to the cache version** in `Repository::new` in [backend/engine.rs](../backend/engine.rs). A change to a parser then makes the index read the files again.
4. **If the helper needs a program,** add a setting for its path, as `PEEKUMI_PYTHON` and `PEEKUMI_NODE` do. Add a check to `peekumi doctor` in [scripts/manage.mjs](../scripts/manage.mjs). Make sure that the release bundle includes everything the helper needs. The bundle already copies `backend/adapters/`.
5. **Write tests:**
   - Rust unit tests in the adapter file: extraction of declarations, documentation and types without code that runs (see the tests in `rust.rs`), and import resolution.
   - An engine test with a small fixture repository, in `test/engine.test.mjs` or `test/relationships.test.mjs`. A change between two commits shows as added, changed or removed declarations. A call shows as a relationship.
   - The contract tests in `mod.rs` run with `npm run test:rust`. They check unique IDs and extensions, the name and the limitations, and that every adapter file is in the cache version.
6. **Update the documents:**
   - [backend/adapters/README.md](../backend/adapters/README.md): the new adapter in the list.
   - [RELATIONSHIPS.md](RELATIONSHIPS.md): the relationships that the language gives.
   - [DEVELOPMENT.md](DEVELOPMENT.md): the program that the adapter needs.
   - [CHANGELOG.md](../CHANGELOG.md): one line.

### Definition of done

- `npm run test:rust` and `npm test` pass.
- On a real repository in the language, the map shows the declarations of a file, and Details names the adapter and its limitations.
- A file with a syntax error and a computer without the helper's program each show a label, and the rest of the map works.

## Add an agent provider

A provider answers questions (Ask), changes code in a worktree (tasks), works with you turn by turn (sessions), or does some of these jobs. Peekumi has three today: Claude Code and Codex, which are programs on the computer, and OpenRouter, which is an API that Peekumi's own task agent uses. The contract is the `Agent` trait in [backend/agents.rs](../backend/agents.rs).

### Rules for every provider

- The agent works only in the worktree that Peekumi gives it. It never works in the inspected checkout.
- The agent reports through Peekumi's tools (the MCP bridge or the function tools). It cannot mark its own work as verified. Only the owner approves.
- A provider never sees a restricted file, and its API key stays on the server. The app sees only the last four characters of a key.
- A command that the session rules do not allow waits for the owner, unless the owner allowed all commands. Do not give a provider a wider rule than the rules in `backend/agent_session.rs`.

### Steps

1. **Implement `Agent`** in `backend/agents.rs`, and add the provider to `registry()`:
   - `id`: a stable key, in lower case, saved in each choice and each run. Do not change it later.
   - `label` and `short`: the full name and the short name, such as "Claude Code" and "Claude". The app shows only these names.
   - `jobs`: `Ask`, `Task` or both.
   - `models`: the models for each job, from the provider itself where possible. Use a short built-in list only when the provider gives nothing.
   - `status`: whether the provider is installed and signed in, and what the owner must do when it is not.
   - `task_command`: the command that starts a task, with the reporting bridge connected. For an API provider, return `None` and make `runs_in_process` true.
   - Optional: `has_default_model`, `note`, `key` (for an API key) and `asks_before_commands` (true when its sessions use the approval bridge).
2. **For a program on the computer,** add a setting for its path (as `--codex` / `PEEKUMI_CODEX` do) and add it to `peekumi doctor` in `scripts/manage.mjs`.
3. **Write the log in Peekumi's format.** Many parts read the run's log: the task view, the session view, agent focus on the map and the last message. Write one JSON object on each line: `{"item": {"type": "agent_message", "text": …}}`, `{"item": {"type": "command_execution", "command": …, "exit_code": …}}` or `{"item": {"type": "file_change", "path": …, "status": "completed"}}`. Peekumi's own agent writes this format (see `backend/task_agent.rs`). If the provider writes another format, convert it, or add a reader to `frontend/session.js`, `agentActivity` in `frontend/workflow.js` and `last_message` in `backend/runner.rs`.
4. **For sessions,** read `launch.session` in `task_command`. On the first turn, the command starts a conversation. On later turns, it continues the conversation that `SessionTurn` names. If the provider gives its own conversation ID (as Codex does), make `backend/runner.rs` read it from the log after the first turn.
5. **For Ask,** add an engine to `backend/ask.rs`. A program needs its own engine. An API that is compatible with OpenRouter's chat API can use the same engine.
6. **For commit messages,** add the provider to the commit message request in `backend/merge.rs`, or leave it out. Without it, the owner writes the message.
7. **Write tests:**
   - Unit tests for the parts that read the provider's output, for example its model list (see `reads_efforts_and_aliases_from_help`).
   - A workflow test with a fake program or a fake API, in `test/workflow.test.mjs`. The provider gets a task, reports each instruction and finishes. A failed tool shows as failed. The real paid provider never runs in a test.
   - The contract test `registered_agents_keep_the_contract` runs with `npm run test:rust`. It checks the ID, the names, the jobs and the server's defaults.
8. **Update the documents:**
   - [WORKFLOW.md](WORKFLOW.md): the provider in the Agents section.
   - [SECURITY.md](../SECURITY.md): what the provider can do and what it cannot do.
   - [USER-GUIDE.md](USER-GUIDE.md): the provider in the Agents section.
   - [CHANGELOG.md](../CHANGELOG.md): one line.

### Definition of done

- `npm run test:rust` and `npm test` pass, and the new workflow test uses no real provider.
- The provider shows in **Agents** with its models, and its status says what to do when it is not ready.
- A task with the provider runs in its worktree, reports each instruction and waits for the owner's approval.
- If the provider does sessions, `npm run test:browser` passes.

## Add a tunnel provider

A tunnel lets a phone reach the Peekumi server. `peekumi share` uses private Tailscale by default. `peekumi share --tunnel cloudflare` makes a public, temporary URL. The providers are in [scripts/tunnel/](../scripts/tunnel/), and [scripts/manage.mjs](../scripts/manage.mjs) uses them.

### The interface

A provider is an object that a factory function makes, for example `createTailscaleProvider(run)`. The factory must not run a command, download a file or write a file. The object has these operations:

- `available()`: whether the tool is on the computer, as `{ok, detail}`. `peekumi doctor` shows it. It must not download or start anything.
- `status()`: the current state of the tunnel. It reads and does not change anything.
- `expose(port, status)`: makes the local port reachable. It never changes a configuration that was there before.
- `url(status)`: the HTTPS address for the phone.
- `close()`: a public provider only. It stops the tunnel.

### Rules

- A private tunnel (only your devices can reach it) can be the default. A public tunnel needs the explicit `--tunnel <name>` option each time. It shows a warning, and no setting, environment variable or saved configuration can turn it on.
- A public tunnel runs in the foreground and closes when the command stops. Peekumi never saves its address.
- A provider that downloads a program pins the version and checks the SHA-256 digest of each file before it runs the program (see `cloudflare-release.mjs`).
- Pairing still applies. A tunnel never gives access without a pairing link.

### Steps

1. Write `scripts/tunnel/<name>.mjs` with a factory function. Give it its command runner or its downloader as parameters, so the tests can replace them.
2. Add the name to `tunnelName` in `select.mjs`.
3. In `manage.mjs`, add the provider to `share`: for a private provider, as for Tailscale; for a public provider, as `shareCloudflare` does. Add `available()` to `peekumi doctor` when the provider needs a tool.
4. Write tests in `test/tunnel.test.mjs` with a fake runner: the provider keeps an existing configuration, it reports a missing tool clearly, and a public provider closes. Add the provider to the contract test "every tunnel provider keeps the contract".
5. Update [SETUP.md](SETUP.md) (how to use it), [SECURITY.md](../SECURITY.md) (who can reach the server), [scripts/README.md](../scripts/README.md) and [CHANGELOG.md](../CHANGELOG.md).
