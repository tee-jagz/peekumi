# Development

How to build, run, test and benchmark Peekumi from a checkout, and what its analysis does and does not cover. For everyday installation, see [SETUP.md](SETUP.md); for the interface, see [USER-GUIDE.md](USER-GUIDE.md).

Peekumi uses a Rust backend (Axum/Tokio and SQLite) to read committed Git objects and serve the existing SVG mobile web interface. Inspection leaves the working tree, branches and hooks untouched. Explicit agent dispatch creates a separate run branch and worktree.

## Code layout

- [frontend/](../frontend/README.md): browser map, navigation and review panel.
- [backend/](../backend/README.md): API, Git analysis and persistent cache.
- [backend/adapters/](../backend/adapters/README.md): shared language contract and parser implementations.
- [scripts/](../scripts/README.md): build, launch, packaging and benchmarking tools.
- [test/](../test/README.md): regression and browser tests.
- [docs/](README.md): product, architecture and original design context.

## Run from a checkout

Requirements to build: a current stable Rust toolchain (edition 2024), a C toolchain for bundled SQLite, Git, and Node.js 22.13+ for the npm commands and TypeScript parser. Python 3.9+ enables Python symbol extraction. Missing parsers produce labelled file-level inspection. Install Rust with [rustup](https://rust-lang.org/tools/install/).

```sh
npm ci
npm start -- /path/to/repository
```

`npm start` builds and launches the Rust executable. You can also use `cargo build --release --locked` and run `./target/release/peekumi /path/to/repository` directly. The web assets and Python helper are embedded in the binary. JavaScript/TypeScript/Svelte extraction uses the bundled `backend/adapters/typescript_ast.mjs` helper and installed `typescript` package; when moving the binary, pass `--parser-root /path/to/peekumi` (or `PEEKUMI_PARSER_ROOT`) to locate them. `PEEKUMI_NODE` selects its Node executable. No Node HTTP service runs.

Open the access link printed in the terminal. The token in its URL fragment is exchanged for an HttpOnly session cookie and removed from browser history. The session lasts 30 days and survives service restarts. After opening the private link once, bookmark the plain viewer URL or add it to your phone’s home screen. The original private link remains reusable while the state directory and access token are retained; rotating the token invalidates remembered browsers. Local access credentials live in `.peekumi/`, which is excluded from Git. `--state-dir /private/path` changes the credential and index location.

Choose an initial comparison:

```sh
npm start -- /path/to/repository --base HEAD~10 --head HEAD
```

On a Mac with multiple Python installations, choose a working interpreter explicitly:

```sh
PEEKUMI_PYTHON=/usr/bin/python3 npm start -- /path/to/repository --base HEAD~10
```

## Open a checkout run from your phone

Bind to the host's private network address:

```sh
npm start -- /path/to/repository --host 192.168.1.20 --port 4317
```

Open the printed access link on a phone on the same trusted Wi-Fi network. For access away from home, bind Peekumi to localhost and use Tailscale Serve, or put the service behind an authenticated HTTPS reverse proxy. For example: `tailscale serve --bg --http=4317 http://127.0.0.1:4317`. Your phone must be connected to the same Tailscale network. Userspace Tailscale installations may require `--socket=/path/to/tailscaled.sock` before `serve`. With HTTPS, add `--secure-cookie`. Plain HTTP does not encrypt source or session cookies: use it only on a trusted local network. Do not expose this port directly to the public internet.

The Rust service uses Git subprocesses and has been built and tested on an Intel Mac mini. A from-source install and the Linux x86_64 release archive have been verified in clean Debian 12 and Ubuntu 22.04 containers, running in the foreground with `peekumi serve`. The Linux systemd service and ARM builds have not yet been exercised.

## Test

```sh
npm run test:rust
npm test
npx playwright install chromium
npm run test:browser
```

Test against a different repository:

```sh
PEEKUMI_TEST_REPO=/path/to/visalytics PEEKUMI_TEST_BASE=HEAD~10 npm run test:browser
```

`PEEKUMI_BROWSER_CHANNEL=chrome` uses an installed Chrome instead of Playwright's downloaded Chromium. Browser tests save local screenshots under `test-results/`; these can contain inspected code and are never committed.

See [MVP scope](MVP.md), [architecture](ARCHITECTURE.md), and [first integration results](VALIDATION.md).

## Benchmark indexing

```sh
PEEKUMI_PYTHON=/usr/bin/python3 node scripts/benchmark-rust.mjs /path/to/repository HEAD~10 HEAD
```

Build first with `npm run build:rust`. The benchmark starts both implementations on loopback with temporary private indexes. It compares cold and warm API responses, restarts Rust with the persisted index, checks complete comparison equivalence, and verifies selected source/metadata responses. It cleans up the temporary processes and indexes. Browser/network timings are separate.

## Analysis and limitations

Rust uses the native `syn` parser for modules, structs, enums, traits, methods, functions, documentation comments and explicit types. Macros are never expanded; conditional compilation is not evaluated. Rust imports follow conventional `crate`, `self`, `super` and module paths; custom `#[path]` and Cargo workspace resolution are not supported.

Python uses `ast`; JavaScript and TypeScript use the TypeScript compiler parser. Svelte script blocks use the same parser, with non-JavaScript data scripts excluded. Templates remain visible in file diffs. Files are considered changed using Git object identity and file mode, so constants, templates, comments, and changes outside extracted symbols remain visible.

Declaration details are loaded only when opening a file, keeping the initial map compact. Python descriptions come from module/class/function docstrings; TypeScript and JavaScript use JSDoc plus explicit AST declarations, including Svelte scripts. Module JSDoc requires `@module`, `@file`, or `@fileoverview`. Types are not inferred, documentation is not generated, and directory descriptions are not synthesized. Python docstring prose is preserved rather than guessing parameter types from arbitrary documentation formats.

Python imports resolve relative paths and unique dotted-module suffixes. JavaScript imports resolve relative paths and the conventional Svelte `$lib` alias. Other aliases, dynamic imports without a literal target, and ambiguous Python modules remain unresolved. Import lists include external or unresolved imports explicitly. Custom module resolution and full Svelte template analysis are future work.

Every tracked file appears, including tests and unsupported languages. Binary files, symlinks, submodules, files above 512 KiB, and common secret filenames are labelled without source previews. This filename restriction is not a secret scanner; the viewer is private because other source files can contain sensitive code or data.

Renames currently appear as removal plus addition. Symbol identity is qualified name within a file, and duplicate names are not independently tracked. Parse failures fall back to file-level inspection. Up to six snapshots are cached in memory. A private SQLite syntax index under `.peekumi/index-rust/` reuses unchanged Git blobs across commits and restarts. The key includes parser implementation, language, TypeScript/Node version and Python interpreter/version. Dependency resolution is rebuilt for each tree, so moves and changed import targets remain accurate. Retained index payload is capped at 128 MiB per repository; deleting this directory forces reindexing. If the disk index is unavailable, analysis falls back to memory. There is no history backfill. Explicit agent runs are described in [WORKFLOW.md](WORKFLOW.md).

A bounded work queue sends repository analysis and SQLite operations to a dedicated Rust thread. Axum/Tokio handles HTTP independently; gzip runs in the blocking-work pool. The phone initially receives file statuses, dependencies and compact symbol previews; opening a file fetches its full symbols, imports, documentation, source and diff. The previous Node backend is retained under `test/reference/` solely for compatibility tests and benchmarking.

### Directory descriptions

Peekumi displays each directory's committed README opening paragraph as its description. It prefers README.md, README.rst, README.txt, then README (case-insensitive), with a Python __init__.py module docstring as fallback. It uses only documentation in that directory, shows its source and revision, and provides a link to read the complete file. Descriptions are limited to 600 characters and rendered as plain text. Before/After selects documentation from the corresponding commit.
