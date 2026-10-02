# Architecture

The production backend is Rust. The browser remains plain JavaScript, HTML/CSS and SVG.

1. `backend/main.rs` serves embedded assets and the token-protected API with Axum/Tokio. Constant-time token checking, same-origin pairing, expiring HttpOnly sessions, security headers, authenticated owner writes and negotiated gzip preserve the existing contract. A bounded queue sends repository operations to a dedicated thread; compression uses Tokio's blocking-work pool.
2. `backend/engine.rs` reads Git trees/blobs, resolves imports, compares file and symbol identities, and supplies source/diffs. It retains six immutable snapshots and six comparison results keyed by resolved commit pair and view. Symbolic references are resolved on each request; only already-cached commit SHAs skip repeat resolution. `backend/process.rs` runs fixed Git/parser subprocess commands with piped input, output draining, and a 30-second timeout. It never executes inspected code.
3. `backend/index.rs` owns a per-repository SQLite syntax index under the private state directory. Its content keys include Git blob identity, language and parser version. It retains up to 128 MiB of analysis payload, falls back to memory if persistence fails, and resolves imports afresh for every tree. Rust uses `index-rust/` so the former Node index remains available for rollback.
4. `backend/adapters/mod.rs` defines the common `LanguageAdapter` interface (extensions, identity, capabilities, batch analysis and import resolution). Rust, Python and TypeScript implement it; the engine dispatches through the registry. `backend/adapters/python_ast.py` and `backend/adapters/typescript_ast.mjs` are syntax helpers. Rust sends only cache misses through JSON stdin; Python and TypeScript batches run concurrently. Python uses the standard AST; the Node helper uses the TypeScript compiler to preserve JavaScript, TypeScript and Svelte metadata accuracy. They expose no HTTP service. Python is embedded; the TypeScript helper and its package are found through the configured parser root. Missing helpers produce explicit file-level fallbacks.
5. `frontend/` retains the reference glass deck. `model.js` aggregates hierarchy and dependency edges; `canvas.js` provides SVG pan/pinch/zoom with HTML card contents. The frontend initially fetches a compact overview, then full symbols, imports, source and descriptions when opening a file. It caches six comparisons and twelve files.

The old Node backend is under `test/reference/`. It is an equivalence oracle and benchmark baseline, not a production service. `npm start` builds and runs the Rust executable. `Cargo.lock` pins the Rust dependencies.

## API

- `POST /api/session`: exchange the access token for a session cookie.
- `GET /api/repo`: name, branch, first-parent commit history and initial revisions.
- `GET /api/compare?base=&head=`: complete comparison for compatibility; add `view=overview` for file statuses, dependency edges, counts and compact symbol colour previews.
- `GET /api/directories?base=&head=`: revision-specific directory README summaries or Python package docstrings, with provenance and adapter capabilities.
- `GET /api/relationships?base=&head=&path=`: typed relationships, source sites, resolution evidence and before/after rule outcomes. Optional `view=overview` aggregates resolved file pairs for the initial map; a path includes incoming and outgoing evidence.
- `GET /api/source?base=&head=&path=`: before/after source, direct Git diff, symbol comparison, imports and revision-specific metadata.

API requests require a session or bearer token except pairing. Repository strings are rendered using browser `textContent`. The internal `--stdio` protocol exists for local tests and benchmarks; it is not an HTTP endpoint.

## Boundaries

Repository inspection is read-only; an explicit owner dispatch creates an isolated agent worktree. Source comes from committed Git objects, not working-tree traversal. Symlinks are not followed; restricted filenames, binary content, large files and submodules remain labelled. Diffs disable external drivers and text conversion. Static dependencies do not prove runtime coupling. No architecture or health scores are invented.

`backend/relationships.rs` normalizes adapter evidence, resolves candidate declarations through the shared index and compares relationship/rule outcomes. `backend/rules.rs` validates committed `.peekumi.json` files and checks directional constraints. Rule evaluation is separate from syntax caching, so configuration-only commits can change violations.

## Review workflow

`workflow.rs` owns a separate persistent SQLite store for comments, audit events and frozen run tasks. `runner.rs` creates explicitly dispatched agent worktrees, supervises processes, and exposes run-scoped reporting through stdio MCP. The owner HTTP session alone can verify a report. `frontend/workflow.js` extends the existing review panel with Comments and Runs and polls active progress. Inspection remains read-only; dispatch is the explicit write/execution boundary. See [WORKFLOW.md](WORKFLOW.md).
