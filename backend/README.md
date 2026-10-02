# Backend

The Rust backend serves the authenticated API, reads committed Git objects, compares revisions, and caches syntax analysis. It coordinates language adapters and supplies directory documentation to the frontend without executing inspected code.

- `main.rs`: Axum HTTP server, authentication, embedded frontend and repository worker.
- `engine.rs`: Git snapshots, comparisons, directory descriptions and adapter coordination.
- `relationships.rs`: shared relationship evidence, resolution and revision comparisons.
- `rules.rs`: committed dependency configuration validation and violation checks.
- `ask.rs`: bounded committed context (source, diff and static relationships for files and declarations; README, declarations and changed-file diffs for folders) and Claude conversations with every built-in tool disabled. Answers follow ASD-STE100; a conversation may span selections, and each earlier turn may say what it was `about`.
- `lookup.rs`: Ask's read-only lookup tools (`find_declarations`, `read_declaration`, `read_file`, `relationships`) over Streamable HTTP MCP at `/mcp/ask`, open only while one answer runs and limited to 12 calls.
- `workflow.rs`: durable draft instructions (stored as comments), frozen task previews, agent reports and owner verification.
- `runner.rs`: isolated agent worktrees, process supervision and scoped stdio MCP reporting.
- `index.rs`: persistent SQLite syntax cache.
- `process.rs`: bounded Git and parser subprocess execution.
- `adapters/`: the common language interface and its implementations.

Build from the repository root with `cargo build --release --locked`. Browser assets and the Python helper are embedded; the TypeScript helper remains beside the deployed parser root.

`sessions.rs` persists hashed browser sessions in private state so bookmarked viewer URLs remain signed in across restarts. Sessions expire after 30 days and are bound to the repository and current access token.

Codex runs use `exec --approve-for-me`, which selects the workspace-write sandbox with automatic approval review. Do not combine that preset with `--sandbox`: the CLI rejects the combination before executing the task.

A listener may register additional local repositories, each with an independent worker and workflow directory. Browser device sessions are shared at the server level with owner/read-only roles and explicit revocation. `pull_requests.rs` obtains PR context through the installed GitHub CLI and fetches private refs without changing the checkout. Configuration, workflow and analysis storage carry schema versions; newer workflow schemas are rejected.

Each adapter records a declaration's whole-syntax fingerprint plus a body fingerprint that excludes its signature and documentation. When a declaration changes, comparisons report `changes`: `signature` (parameters, return type, generics, bases or declared fields, from the declaration metadata), `documentation` (doc comments or docstrings) and `implementation` (the body). Fingerprints are structural, so whitespace-only edits leave a declaration unchanged; a change outside these parts reports an empty list. The compact overview preview carries the same labels.
