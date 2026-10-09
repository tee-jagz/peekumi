# Architecture

The production backend is Rust. The browser part stays plain JavaScript, HTML/CSS and SVG.

1. `backend/main.rs` uses Axum/Tokio to serve embedded assets and the token-protected API. These features keep the current contract: constant-time token checks, same-origin pairing, HttpOnly sessions that expire, security headers, authenticated owner writes and negotiated gzip. A bounded queue sends repository operations to a dedicated thread. Compression uses the blocking-work pool of Tokio.
2. `backend/engine.rs` reads Git trees/blobs, resolves imports, compares file and symbol identities, and supplies source/diffs. It keeps six immutable snapshots and six comparison results keyed by resolved commit pair and view. It resolves symbolic references on each request. Only commit SHAs that are already in the cache skip repeat resolution.

   `backend/process.rs` runs fixed Git/parser subprocess commands. It pipes the input, drains the output and applies a 30-second timeout. It never executes inspected code.
3. `backend/index.rs` owns a SQLite syntax index for each repository in the private state directory. Its content keys include the Git blob identity, the language and the parser version. It keeps up to 128 MiB of analysis payload. If persistence fails, it uses memory instead. It resolves imports again for each tree. Rust uses `index-rust/`, so the former Node index stays available for rollback.
4. `backend/adapters/mod.rs` defines the common `LanguageAdapter` interface (extensions, identity, capabilities, batch analysis and import resolution). Rust, Python and TypeScript implement it, and the engine dispatches through the registry. `backend/adapters/python_ast.py` and `backend/adapters/typescript_ast.mjs` are syntax helpers. Rust sends only cache misses through JSON stdin. Python batches and TypeScript batches run concurrently.

   Python uses the standard AST. The Node helper uses the TypeScript compiler to keep the JavaScript, TypeScript and Svelte metadata accurate. The helpers have no HTTP service. Python is embedded, and the configured parser root gives the location of the TypeScript helper and its package. If a helper is not available, Peekumi gives an explicit file-level fallback.
5. `frontend/` keeps the reference glass deck. `model.js` aggregates the hierarchy and the dependency edges. `canvas.js` gives SVG pan/pinch/zoom with HTML card contents. First, the frontend fetches a compact overview. When you open a file, it fetches the full symbols, imports, source and descriptions. It caches six comparisons and twelve files.

The old Node backend is in `test/reference/`. It is an equivalence oracle and a benchmark baseline, not a production service. `npm start` builds and runs the Rust executable. `Cargo.lock` pins the Rust dependencies.

## API

- `POST /api/session`: exchanges the access token for a session cookie.
- `GET /api/repo`: the name, the branch, the latest 80 first-parent commits (`moreCommits` is true when older commits exist) and the initial revisions.
- `GET /api/fixes?head=`: the dependency-rule breaks at a revision, grouped by the rule and the declaration that they reach. Each group has an instruction text and an anchor.
- `POST /api/fixes/propose`: `{head, using}`. It starts a fix proposal in the background and returns `{running: true}`. A proposal for the same commit that runs already also gives `{running: true}`. While an Ask answer, a rule audit or another proposal holds the agent, it returns `{busy}` and starts nothing, and the page tries again. The Ask agent reads the code with read-only lookups, with these groups as its context, and proposes fixes. The owner's devices get a notification when it ends.
- `GET /api/fixes/proposal?head=`: the saved proposal for `head`: `{running}` while it runs, then `{fixes, groups, provider}` or `{error}`. A proposal for another commit gives `{}`.
- `GET /api/push/key`, `POST` and `DELETE /api/push/subscribe`: Web Push notifications on owner devices when an agent finishes or needs the owner (refer to [WORKFLOW.md](WORKFLOW.md#notifications)).
- `POST /api/rules/propose`: `{head, using}`. It starts a rule audit in the background and returns `{running: true}`, also when an audit runs already. While an Ask answer or a fix proposal holds the agent, it returns `{busy}` and starts nothing, and the page tries again. The Ask agent audits the architecture with read-only lookups and proposes dependency rules, each under an engineering principle. Its rules join the saved list, and the owner's devices get a notification.
- `GET /api/rules/audit?head=`: the saved list of proposed rules, with each rule tried at `head`. A rule has `trial` (`checked`, `broke`, `unresolved`, `warnings`, `examples`) or `problem`. It has `added` when the configuration has the rule now. It also has `status`, `runs`, `running`, `error`, `dropped`, `principles`, `provider`, `configured` and `configFile`.
- `PATCH /api/rules/audit/<id>`: `{status}`, `proposed` (not selected), `selected` or `drafted`. It keeps the owner's choice for one rule.
- `POST /api/rules/check`: `{head, groups, rule}`. It tries one rule at `head`, added to the committed configuration, and returns the same `trial` numbers. A group name that the configuration uses for other patterns gets a new name (`ui-2`). The reply has the `groups` and the `rule` with that name. It refuses an invalid rule and a rule ID that the configuration has. It also refuses a rule that checks the same files as a current rule, or that a current rule covers.
- `GET /api/commits?before=`: the next 80 first-parent commits after commit `before`, and `more`.
- `GET /api/compare?base=&head=`: the complete comparison, for compatibility. Add `view=overview` to get file statuses, dependency edges, counts and compact colour previews of symbols.
- `GET /api/directories?base=&head=`: directory README summaries or Python package docstrings for a specific revision, with provenance and adapter capabilities.
- `GET /api/relationships?base=&head=&path=`: typed relationships, source sites, resolution evidence and before/after rule outcomes. The optional `view=overview` aggregates resolved file pairs for the initial map. With a path, the response includes incoming and outgoing evidence.
- `GET /api/source?base=&head=&path=`: before/after source, the direct Git diff, the symbol comparison, imports and metadata for a specific revision.

All API requests, except pairing, need a session or a bearer token. Peekumi uses the browser `textContent` to render repository strings. The internal `--stdio` protocol is for local tests and benchmarks. It is not an HTTP endpoint.

## Boundaries

Repository inspection is read-only. An explicit owner dispatch creates an isolated agent worktree. Source comes from committed Git objects. Uncommitted changes are an exception: `backend/worktree.rs` records them as a private commit on top of `HEAD`, in an object folder in the state folder. Only read-only Git commands read that folder. Peekumi does not follow symlinks. Restricted filenames, binary content, large files and submodules keep their labels.

Diffs disable external drivers and text conversion. Static dependencies do not prove runtime coupling. Peekumi does not invent architecture scores or health scores.

`backend/relationships.rs` normalizes adapter evidence, resolves candidate declarations through the shared index and compares relationship/rule outcomes. `backend/rules.rs` validates committed `.peekumi.json` files and checks directional constraints. Rule evaluation is separate from the syntax cache, so commits that change only the configuration can change violations.

## Review workflow

`workflow.rs` owns a separate persistent SQLite store for comments, audit events and frozen run tasks. `runner.rs` creates agent worktrees for explicit dispatches, supervises processes and gives run-scoped reports through stdio MCP. Only the owner HTTP session can verify a report. `frontend/workflow.js` adds Comments and Runs to the current review panel and polls active progress. Inspection stays read-only, and dispatch is the explicit write/execution boundary. See [WORKFLOW.md](WORKFLOW.md).
