# Repo Strata

Explore a repository and its changes from your phone, from the overall structure down to the implementation.

Strata uses a Rust backend (Axum/Tokio and SQLite) to read committed Git objects and serve the existing SVG mobile web interface. Inspection leaves the working tree, branches and hooks untouched. Explicit agent dispatch creates a separate run branch and worktree.

## Directory responsibilities

- [frontend/](frontend/README.md): browser map, navigation and review panel.
- [backend/](backend/README.md): API, Git analysis and persistent cache.
- [backend/adapters/](backend/adapters/README.md): shared language contract and parser implementations.
- [scripts/](scripts/README.md): build, launch and benchmarking tools.
- [test/](test/README.md): regression and browser tests.
- [docs/](docs/README.md): product, architecture and original design context.

Strata displays each directory's committed README opening paragraph as its description. It prefers README.md, README.rst, README.txt, then README (case-insensitive), with a Python __init__.py module docstring as fallback. It uses only documentation in that directory, shows its source and revision, and provides a link to read the complete file. Descriptions are limited to 600 characters and rendered as plain text. Before/After selects documentation from the corresponding commit.

## Run

Requirements to build: a current stable Rust toolchain (edition 2024), a C toolchain for bundled SQLite, Git, and Node.js 22.13+ for the npm commands and TypeScript parser. Python 3.9+ enables Python symbol extraction. Missing parsers produce labelled file-level inspection. Install Rust with [rustup](https://rust-lang.org/tools/install/).

```sh
npm ci
npm start -- /path/to/repository
```

`npm start` builds and launches the Rust executable. You can also use `cargo build --release --locked` and run `./target/release/strata /path/to/repository` directly. The web assets and Python helper are embedded in the binary. JavaScript/TypeScript/Svelte extraction uses the bundled `backend/adapters/typescript_ast.mjs` helper and installed `typescript` package; when moving the binary, pass `--parser-root /path/to/repo-strata` (or `STRATA_PARSER_ROOT`) to locate them. `STRATA_NODE` selects its Node executable. No Node HTTP service runs.

Open the access link printed in the terminal. The token in its URL fragment is exchanged for an HttpOnly session cookie and removed from browser history. The session lasts seven days or until the service restarts. Local access credentials live in `.strata/`, which is excluded from Git. `--state-dir /private/path` changes the credential and index location.

Choose an initial comparison:

```sh
npm start -- /path/to/repository --base HEAD~10 --head HEAD
```

On a Mac with multiple Python installations, choose a working interpreter explicitly:

```sh
STRATA_PYTHON=/usr/bin/python3 npm start -- /path/to/repository --base HEAD~10
```

## Open from your phone

Bind to the host's private network address:

```sh
npm start -- /path/to/repository --host 192.168.1.20 --port 4317
```

Open the printed access link on a phone on the same trusted Wi-Fi network. For access away from home, bind Strata to localhost and use Tailscale Serve, or put the service behind an authenticated HTTPS reverse proxy. For example: `tailscale serve --bg --http=4317 http://127.0.0.1:4317`. Your phone must be connected to the same Tailscale network. Userspace Tailscale installations may require `--socket=/path/to/tailscaled.sock` before `serve`. With HTTPS, add `--secure-cookie`. Plain HTTP does not encrypt source or session cookies: use it only on a trusted local network. Do not expose this port directly to the public internet.

The Rust service uses Git subprocesses and has been built and tested on this Intel Mac mini. Linux and other architectures have not yet been exercised here.

## Explore

- Select explicit base and head commits. The commit strip and comparison picker list the latest 80 first-parent commits from HEAD; startup flags can select other Git revisions.
- Explore the glass card deck from the supplied mockup. Tap once to select, then tap the selected card or Open to zoom in. Nested packages follow the repository's actual structure.
- Added is green, modified is purple, removed is red, unchanged is grey. Text labels accompany colour.
- Use Time to review each commit against its first parent; tap a peeking sheet or commit chip to move through history. Use Diff to choose a base and switch the map between Before and After.
- Pan the SVG map by dragging with a finger or mouse, or scrolling. Pinch or Control/Command-scroll to zoom; use +/−, Fit, or 1:1 for explicit controls. Keyboard users can focus the map and use arrows and +/−. The review panel scrolls independently.
- Turn on Changes only to hide unchanged cards at every level, while keeping changed parent folders available for drill-down. Changed dependencies retain their external neighbours as context. File-level edits can have no changed symbols; the complete source diff remains available.
- Use file search, breadcrumbs, and the scoped Changes list to navigate.
- Select curved dependency lines in the map, then inspect their endpoints in Dependencies. Neighbours appear as dashed cards. These are static import relationships, not a runtime call graph.
- Structure shows the current topology; Changes colours the comparison. Health scoring is not yet measured.
- Open a symbol to highlight it in the full source. Switch between Before, After and a complete file diff.
- Open a file for its module description, then select a class or function for documented descriptions, signatures, arguments, defaults, annotations, returns, and declared class fields. The inspector follows Before/After and labels missing annotations.
- Refresh to discover new commits. Uncommitted work is not included.

## Analysis and limitations

Rust uses the native `syn` parser for modules, structs, enums, traits, methods, functions, documentation comments and explicit types. Macros are never expanded; conditional compilation is not evaluated. Rust imports follow conventional `crate`, `self`, `super` and module paths; custom `#[path]` and Cargo workspace resolution are not supported.

Python uses `ast`; JavaScript and TypeScript use the TypeScript compiler parser. Svelte script blocks use the same parser, with non-JavaScript data scripts excluded. Templates remain visible in file diffs. Files are considered changed using Git object identity and file mode, so constants, templates, comments, and changes outside extracted symbols remain visible.

Declaration details are loaded only when opening a file, keeping the initial map compact. Python descriptions come from module/class/function docstrings; TypeScript and JavaScript use JSDoc plus explicit AST declarations, including Svelte scripts. Module JSDoc requires `@module`, `@file`, or `@fileoverview`. Types are not inferred, documentation is not generated, and directory descriptions are not synthesized. Python docstring prose is preserved rather than guessing parameter types from arbitrary documentation formats.

Python imports resolve relative paths and unique dotted-module suffixes. JavaScript imports resolve relative paths and the conventional Svelte `$lib` alias. Other aliases, dynamic imports without a literal target, and ambiguous Python modules remain unresolved. Import lists include external or unresolved imports explicitly. Custom module resolution and full Svelte template analysis are future work.

Every tracked file appears, including tests and unsupported languages. Binary files, symlinks, submodules, files above 512 KiB, and common secret filenames are labelled without source previews. This filename restriction is not a secret scanner; the viewer is private because other source files can contain sensitive code or data.

Renames currently appear as removal plus addition. Symbol identity is qualified name within a file, and duplicate names are not independently tracked. Parse failures fall back to file-level inspection. Up to six snapshots are cached in memory. A private SQLite syntax index under `.strata/index-rust/` reuses unchanged Git blobs across commits and restarts. The key includes parser implementation, language, TypeScript/Node version and Python interpreter/version. Dependency resolution is rebuilt for each tree, so moves and changed import targets remain accurate. Retained index payload is capped at 128 MiB per repository; deleting this directory forces reindexing. If the disk index is unavailable, analysis falls back to memory. There is no history backfill. Explicit agent runs are described in the workflow guide below.

A bounded work queue sends repository analysis and SQLite operations to a dedicated Rust thread. Axum/Tokio handles HTTP independently; gzip runs in the blocking-work pool. The phone initially receives file statuses, dependencies and compact symbol previews; opening a file fetches its full symbols, imports, documentation, source and diff. The previous Node backend is retained under `test/reference/` solely for compatibility tests and benchmarking.

## Verify

```sh
npm run test:rust
npm test
npx playwright install chromium
npm run test:browser
```

Test against a different repository:

```sh
STRATA_TEST_REPO=/path/to/visalytics STRATA_TEST_BASE=HEAD~10 npm run test:browser
```

`STRATA_BROWSER_CHANNEL=chrome` uses an installed Chrome instead of Playwright's downloaded Chromium. Browser tests save local screenshots under `test-results/`; these can contain inspected code and are never committed.

See [MVP scope](docs/MVP.md), [architecture](docs/ARCHITECTURE.md), and [first integration results](docs/VALIDATION.md).

## Benchmark indexing

```sh
STRATA_PYTHON=/usr/bin/python3 node scripts/benchmark-rust.mjs /path/to/repository HEAD~10 HEAD
```

Build first with `npm run build:rust`. The benchmark starts both implementations on loopback with temporary private indexes. It compares cold and warm API responses, restarts Rust with the persisted index, checks complete comparison equivalence, and verifies selected source/metadata responses. It cleans up the temporary processes and indexes. Browser/network timings are separate.

## This workspace

The preview inspects `/Users/tolu/projects/visalytics` on localhost port 4317, using a ten-commit comparison. It is reachable privately at `http://tolu-mac-mini.tailb34901.ts.net:4317/` with Tailscale enabled on the client. The Tailscale daemon uses `/Users/tolu/.config/tailscale/tailscaled.sock`; Serve forwards port 4317 to `http://127.0.0.1:4317`. The previous LAN URL has been retired. Its access link is in `.strata/access-link.txt`; its process ID and logs are in `.strata/server.pid` and `.strata/server.log`. The live executable and TypeScript helper are copied into `.strata/runtime/` for a stable deployment; parser resolution uses that directory. This background preview does not start automatically after a reboot. To stop it, inspect the saved PID and stop that process. Use the commands above to restart it or run on another host.

The self-inspection viewer uses port 4318 and `.strata/self/` for its private state, token and logs. It compares commit `93aed95` with `HEAD`, showing the Rust migration and subsequent changes. Both viewers read committed code, so commit changes before refreshing the comparison. Repository-specific cookies allow both viewers to stay signed in on the same hostname.

## Original context

The original specification and prototype archive are preserved in [docs/context](docs/context/README.md). The archive's HTML mockup is the visual and interaction reference. [The current MVP scope](docs/MVP.md) defines which features are implemented.

## Relationships and dependency rules

The Dependencies panel now distinguishes static imports, calls, implementations and inheritance, with source evidence and explicit unresolved/ambiguous targets. Commit `.strata.json` to define path groups and forbidden relationship kinds. Violations and configuration errors are revision-specific; no rules are inferred from directory descriptions. See [relationship support and configuration](docs/RELATIONSHIPS.md) for examples and language limitations.

## Review and steer

Use **Comment** on a selection, then **Prepare run** to choose drafts and preview the exact task. Dispatch starts Codex or Claude Code in a dedicated worktree. Agent reports link commits and check evidence back to comments; **Review fix**, **Verify**, or **Reopen** completes the loop. See [the workflow guide](docs/WORKFLOW.md) for setup, persistence and boundaries.
