# Development

This document tells you how to build, run, test and benchmark Peekumi from a checkout. It also tells you what the analysis covers and does not cover. For everyday installation, see [SETUP.md](SETUP.md). For the interface, see [USER-GUIDE.md](USER-GUIDE.md).

Peekumi uses a Rust backend (Axum/Tokio and SQLite). This backend reads committed Git objects and serves the current SVG mobile web interface. Inspection does not change the working tree, the branches or the hooks. An explicit agent dispatch creates a separate run branch and worktree.

## Code layout

- [frontend/](../frontend/README.md): the browser map, navigation and the review panel.
- [backend/](../backend/README.md): the API, Git analysis and the persistent cache.
- [backend/adapters/](../backend/adapters/README.md): the shared language contract and the parser implementations. To add a language or an agent provider, see [EXTENDING.md](EXTENDING.md).
- [scripts/](../scripts/README.md): tools to build, launch, package and benchmark.
- [test/](../test/README.md): regression tests and browser tests.
- [docs/](README.md): the product, the architecture and the original design context.

## Layout and lint

- `npm run format` makes the layout of the JavaScript, the CSS, the HTML and the YAML files (Prettier), and of the Rust code (rustfmt). `npm run format:check` only checks it.
- `npm run lint` runs `clippy` with warnings as errors, and it checks the writing rules of the documents (`scripts/lint-docs.mjs`).

CI runs both on each pull request. The settings are in `.prettierrc.json`, `.prettierignore`, `rustfmt.toml` and `.editorconfig`.

## Run from a checkout

To build, you need these items:

- A current stable Rust toolchain (edition 2024).
- A C toolchain for the bundled SQLite.
- Git.
- Node.js 22.13+ for the npm commands and the TypeScript parser.

Python 3.9+ lets Peekumi extract Python symbols. If a parser is not available, Peekumi gives a file-level inspection with a label. Install Rust with [rustup](https://rust-lang.org/tools/install/).

```sh
npm ci
npm start -- /path/to/repository
```

`npm start` builds and starts the Rust executable. You can also use `cargo build --release --locked` and then run `./target/release/peekumi /path/to/repository` directly. The binary contains the web assets and the Python helper. For JavaScript/TypeScript/Svelte extraction, Peekumi uses the bundled `backend/adapters/typescript_ast.mjs` helper and the installed `typescript` package.

If you move the binary, use `--parser-root /path/to/peekumi` (or `PEEKUMI_PARSER_ROOT`) to find the helper and the package. `PEEKUMI_NODE` selects the Node executable for the helper. No Node HTTP service runs.

Open the access link that the terminal shows. Peekumi exchanges the token in the URL fragment of the link for an HttpOnly session cookie and removes the token from the browser history. The session lasts 30 days and continues after service restarts. After you open the private link one time, bookmark the plain viewer URL or add it to the home screen of your phone.

While you keep the state directory and the access token, you can use the original private link again. If you rotate the token, the remembered browsers become invalid. The local access credentials are in `.peekumi/`, and Git excludes this directory. `--state-dir /private/path` changes the location of the credentials and the index.

Choose an initial comparison:

```sh
npm start -- /path/to/repository --base HEAD~10 --head HEAD
```

On a Mac with more than one Python installation, explicitly choose an interpreter that works:

```sh
PEEKUMI_PYTHON=/usr/bin/python3 npm start -- /path/to/repository --base HEAD~10
```

## Open a checkout run from your phone

Bind to the private network address of the host:

```sh
npm start -- /path/to/repository --host 192.168.1.20 --port 4317
```

On a phone on the same trusted Wi-Fi network, open the access link that the terminal shows. For access away from home, use one of these methods:

- Bind Peekumi to localhost and use Tailscale Serve. For example: `tailscale serve --bg --http=4317 http://127.0.0.1:4317`. Your phone must be on the same Tailscale network. Userspace Tailscale installations can need `--socket=/path/to/tailscaled.sock` before `serve`.
- Put the service behind an authenticated HTTPS reverse proxy.

If you use HTTPS, add `--secure-cookie`. Plain HTTP does not encrypt source or session cookies. Use plain HTTP only on a trusted local network. Do not expose this port directly to the public internet.

The Rust service uses Git subprocesses. It was built and tested on an Intel Mac mini. A from-source install and the Linux x86_64 release archive were verified in clean Debian 12 and Ubuntu 22.04 containers. In these checks, Peekumi ran in the foreground with `peekumi serve`. The Linux systemd service and the ARM builds are not tested yet.

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

`PEEKUMI_BROWSER_CHANNEL=chrome` uses an installed Chrome, not the Chromium that Playwright downloads. Browser tests save local screenshots in `test-results/`. These screenshots can contain inspected code, and they never go into a commit.

See [MVP scope](MVP.md), [architecture](ARCHITECTURE.md), and [first integration results](VALIDATION.md).

## Benchmark indexing

```sh
PEEKUMI_PYTHON=/usr/bin/python3 node scripts/benchmark-rust.mjs /path/to/repository HEAD~10 HEAD
```

First, build with `npm run build:rust`. The benchmark starts the two implementations on loopback with temporary private indexes. It compares cold API responses and warm API responses. It restarts Rust with the persisted index, checks that the complete comparisons are equivalent and verifies selected source/metadata responses. Then it removes the temporary processes and indexes. Browser/network timings are separate.

## Analysis and limitations

Rust uses the native `syn` parser for modules, structs, enums, traits, methods, functions, documentation comments and explicit types. Peekumi never expands macros, and it does not evaluate conditional compilation. Rust imports follow conventional `crate`, `self`, `super` and module paths. Peekumi does not support custom `#[path]` or Cargo workspace resolution.

Python uses `ast`. JavaScript and TypeScript use the TypeScript compiler parser. Svelte script blocks use the same parser, but Peekumi excludes non-JavaScript data scripts. Templates stay visible in file diffs. Peekumi uses the Git object identity and the file mode to find changed files. Thus, constants, templates, comments and changes outside extracted symbols stay visible.

Peekumi loads declaration details only when you open a file, so the initial map stays compact. Python descriptions come from module/class/function docstrings. TypeScript and JavaScript use JSDoc and explicit AST declarations, which include Svelte scripts. Module JSDoc must have `@module`, `@file`, or `@fileoverview`. Peekumi does not infer types, generate documentation or synthesize directory descriptions. Peekumi keeps Python docstring prose as it is, and it does not guess parameter types from arbitrary documentation formats.

Python imports resolve relative paths and unique dotted-module suffixes. JavaScript imports resolve relative paths and the conventional Svelte `$lib` alias. Other aliases, dynamic imports without a literal target and ambiguous Python modules stay unresolved. Import lists explicitly include external imports or unresolved imports. Custom module resolution and full analysis of Svelte templates are future work.

Peekumi shows every tracked file, which includes tests and unsupported languages. Binary files, symlinks, submodules, files above 512 KiB and common secret filenames have labels and no source previews. This filename restriction is not a secret scanner. The viewer is private because other source files can contain sensitive code or data.

Renames currently show as a removal and an addition. Symbol identity is the qualified name in a file, and Peekumi does not track duplicate names independently. If a parse fails, Peekumi uses file-level inspection instead. Peekumi caches up to six snapshots in memory.

A private SQLite syntax index in `.peekumi/index-rust/` uses unchanged Git blobs again across commits and restarts. The key includes the parser implementation, the language, the TypeScript/Node version and the Python interpreter/version. Peekumi builds the dependency resolution again for each tree, so moves and changed import targets stay accurate. The retained index payload has a limit of 128 MiB for each repository. If you delete this directory, Peekumi must index again. If the disk index is not available, the analysis uses memory instead.

There is no history backfill. [WORKFLOW.md](WORKFLOW.md) describes explicit agent runs.

A bounded work queue sends repository analysis and SQLite operations to a dedicated Rust thread. Axum/Tokio handles HTTP independently, and gzip runs in the blocking-work pool. First, the phone receives file statuses, dependencies and compact symbol previews. When you open a file, the phone fetches the full symbols, imports, documentation, source and diff of that file. Peekumi keeps the previous Node backend in `test/reference/` only for compatibility tests and benchmarks.

### Directory descriptions

Peekumi shows the first paragraph of the committed README of each directory as the description of that directory. It prefers README.md, then README.rst, then README.txt, then README (case-insensitive). If there is no README, it uses the module docstring of a Python __init__.py file. It uses only documentation in that directory, shows its source and revision, and gives a link to the complete file. Descriptions have a limit of 600 characters, and Peekumi shows them as plain text. Before/After selects the documentation from the related commit.
