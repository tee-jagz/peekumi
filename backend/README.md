# Backend

The Rust backend serves the authenticated API. It reads committed Git objects and the uncommitted changes, compares revisions and keeps a cache of syntax analysis. It controls the language adapters and supplies directory documentation to the frontend. It does not execute the inspected code.

- `main.rs`: The Axum HTTP server, authentication, the embedded frontend and the operations of the repository worker.
- `worker.rs`: The worker thread. It runs queued operations in order through one handler that it gets from `main.rs`.
- `engine.rs`: Git snapshots, comparisons, directory descriptions and the control of the adapters.
- `relationships.rs`: Shared relationship evidence, relationship resolution and comparisons of revisions.
- `rules.rs`: Validation of the committed dependency configuration, and checks for violations.
- `ask.rs`: Limited committed context and Claude conversations. For files and declarations, the context is the source, the diff, the static relationships and the code that calls them. For folders, the context is the README, the declarations and the diffs of changed files. Each conversation has all built-in tools disabled and uses low effort on a fast model. The answer comes as one whole reply or as a stream of events. Answers follow ASD-STE100 Simplified Technical English.
- `lookup.rs`: The read-only lookup tools for Ask (`find_declarations`, `search_code`, `read_declaration`, `read_file`, `relationships`, `highlight`, `route`). They use Streamable HTTP MCP at `/mcp/ask`. The tools are open only while one answer runs, and they accept a maximum of 30 calls.
- `audit.rs`: The saved list of proposed rules for one repository, and the rule audit that runs in the background. It has the audit agent's instructions. Each audit adds to the list. A rule that checks the same files counts once, and the owner's choices stay.
- `fix_proposals.rs`: Proposed fixes as a background job, with the agent's instructions. It keeps the last proposal with its commit, and it tells the owner's devices when the proposal ends.
- `agent_call.rs`: The read-only agent. It runs the agent that the owner chose for Ask, with every built-in tool off and only the read-only lookups. Ask, the rule audit and Proposed fixes use it, so no service uses another service.
- `workflow.rs`: Durable draft instructions (the backend keeps them as comments), frozen task previews, agent reports and owner verification.
- `runner.rs`: Isolated agent worktrees, the supervision of processes and scoped reports through stdio MCP. It also runs the turns of a session, and its bridge has the `approve` tool for a session agent's command requests.
- `run_store.rs`: The `RunStore` trait. The runner and the task agent use it to read and change runs, and they do not use the `Workflow` type. `workflow.rs` implements it for `Workflow`.
- `agent_session.rs`: Sessions, a live conversation with an agent on its own branch. It starts a session, keeps the owner's messages for the next turn, stores the agent's command requests and the owner's decisions, and ends a session in the normal review.
- `index.rs`: The persistent SQLite syntax cache.
- `process.rs`: Limited execution of Git and parser subprocesses.
- `push.rs`: Web Push notifications to the owner's devices. It keeps the subscriptions and the VAPID key in the server's private folder. It encrypts each message for its device (RFC 8291) and sends it with `curl`. It accepts only the endpoints of known push services.
- `worktree.rs`: Uncommitted changes as a private commit on top of `HEAD`. Its objects go to a folder in the state folder, never to the repository. Only read-only Git commands read that folder.
- `hash.rs`: The SHA-256 fingerprint for cache keys, parser versions, declaration identities and stored secrets.
- `adapters/`: The common language interface and its implementations.

Run `cargo build --release --locked` from the repository root to build the backend. The build embeds the browser assets and the Python helper. The TypeScript helper stays next to the deployed parser root.

`sessions.rs` keeps hashed browser sessions in private state. Thus, bookmarked viewer URLs stay signed in after a restart. Sessions expire after 30 days. A session is valid only for its repository and the current access token.

Codex runs use `exec --approve-for-me`. This preset selects the workspace-write sandbox with automatic approval review. Do not use this preset together with `--sandbox`. The CLI rejects that combination before it executes the task.

A listener can register more local repositories. Each repository has an independent worker and an independent workflow directory. The owner access token can add or remove a repository, but a device session can never do this. To add a repository while the server runs, send `POST /api/repositories` with `{path}`. To remove a repository, send `DELETE /api/repositories/<id>`. You cannot remove the first repository or a repository with an active run.

When you remove a repository, its worker stops and the server releases the lock on its state folder. All repositories on the server share the browser device sessions. Each device session has an owner role or a read-only role, and you can revoke it explicitly. `graph_brief.rs` writes the repository map of a task: every folder, file and declaration name at the start commit, with no code. When the map is larger than 12,000 characters, it folds whole subtrees or the files of one folder, and it keeps the folders of the instructions open. `lookup.rs` serves the read-only code graph lookups at `/mcp/ask` for Ask and, with a separate grant for each run, for task agents. Its `highlight` tool opens one folder, file or declaration of the map, and its `route` tool finds the call paths to a declaration or between two declarations. `task_agent.rs` is Peekumi's own task agent for a provider that is only an API (OpenRouter): the model works through file, commit and reporting tools in the worktree, and no tool runs commands. `agents.rs` defines the providers (now Claude Code, Codex and OpenRouter) behind one interface: their jobs, their models (each provider reports them; `codex debug models` and `claude --help`), status check and task command. It also checks the choice that the app sends as `using`. `merge.rs` merges an approved task into the watched branch when the owner confirms it, only as a fast-forward and never with a push. It also undoes that merge, merges the watched branch into a task branch that is behind (a conflict starts a round for the agent), and commits the owner's own files that are in the way. `pull_requests.rs` lists PRs, reads the details of one PR and fetches a PR into private refs. It uses the installed GitHub CLI and does not change the checkout. The configuration, workflow and analysis storage have schema versions, and the server rejects newer workflow schemas.

Each adapter records a whole-syntax fingerprint and a body fingerprint for each declaration. The body fingerprint does not include the signature and the documentation. When a declaration changes, comparisons report `changes`. This list can contain these values:

- `signature`: The parameters, return type, generics, bases or declared fields, from the declaration metadata.
- `documentation`: The doc comments or docstrings.
- `implementation`: The body.

The fingerprints are structural. Thus, an edit that changes only whitespace does not change the declaration. If a change is outside these parts, the comparison reports an empty list. The compact overview preview shows the same labels.
