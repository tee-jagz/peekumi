# Backend

The Rust backend serves the authenticated API, reads committed Git objects, compares revisions, and caches syntax analysis. It coordinates language adapters and supplies directory documentation to the frontend without executing inspected code.

- `main.rs`: Axum HTTP server, authentication, embedded frontend and repository worker.
- `engine.rs`: Git snapshots, comparisons, directory descriptions and adapter coordination.
- `relationships.rs`: shared relationship evidence, resolution and revision comparisons.
- `rules.rs`: committed dependency configuration validation and violation checks.
- `ask.rs`: bounded committed context and tool-free Claude conversations.
- `workflow.rs`: durable draft comments, frozen task previews, agent reports and owner verification.
- `runner.rs`: isolated agent worktrees, process supervision and scoped stdio MCP reporting.
- `index.rs`: persistent SQLite syntax cache.
- `process.rs`: bounded Git and parser subprocess execution.
- `adapters/`: the common language interface and its implementations.

Build from the repository root with `cargo build --release --locked`. Browser assets and the Python helper are embedded; the TypeScript helper remains beside the deployed parser root.

`sessions.rs` persists hashed browser sessions in private state so bookmarked viewer URLs remain signed in across restarts. Sessions expire after 30 days and are bound to the repository and current access token.

Codex runs use `exec --approve-for-me`, which selects the workspace-write sandbox with automatic approval review. Do not combine that preset with `--sandbox`: the CLI rejects the combination before executing the task.
