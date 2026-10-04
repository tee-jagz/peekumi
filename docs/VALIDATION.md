# First integration validation

The name of Peekumi was Repo Strata, or Strata, until October 2026. The records below keep the command, file and archive names that we actually used at that time.

We did this validation on 29 September 2026 against the local Visalytics repository. The validation did not change the working tree of that repository.

## Comparison

- Base: `7cf0a97cd8f5386e9558d9b3bcefccd5b47464fa`
- Head: `8b1afb15a8f27e476e2a682308e41ba1d31acc9e`
- 1,706 tracked files in the comparison
- 60 changed files: 25 added, 35 modified, 0 removed
- 12,428 extracted symbols in the comparison
- 3,924 resolved internal import relationships at head
- Zero parser errors, after we excluded the Svelte JSON data scripts from TypeScript parsing
- The complete set of changed files matched `git diff --no-renames --name-only` exactly

On this host, the first cold comparison took approximately 6.4 seconds. This measurement was before the final Svelte adjustment. The snapshots are in a memory cache, and we can still optimise the cold-start latency. This record does not make a validated claim of sub-second performance.

## Automated checks

`npm test`: three suites passed. They cover Git change accounting, class attributes, constants, template changes, executable mode changes, removals and dependency resolution. They also cover full file patches, binary/restricted source handling, invalid revisions, parser failure, missing Python and reverse comparisons. The other items are authentication, cross-origin pairing rejection, session cookies and read-only API enforcement.

`npm run test:browser` against Visalytics passed at 390 × 844 and 1366 × 768. The tests covered token pairing, token removal from the URL, folder navigation, file search, source/diff loading and symbol highlighting. They also covered Before/After selection, changed-only filtering, empty search results, identical-revision comparison, browser errors and page overflow.

At both sizes, we captured and visually inspected the overview and component screens. We also captured readable source detail screens at both sizes. Text labels wrap in the cards. The source scrolls horizontally in its pane, and the page does not overflow. The screenshots stay in the ignored `test-results/` directory, because they contain private repository details. At first, the installed Chrome made repeated viewport tiles in a full-page screenshot, so the final captures used the matching Playwright Chromium build.

Without authentication, the LAN service returned HTTP 401. With authentication, it served the expected comparison. We did not test a physical phone or access from outside the LAN. The first Tailscale check used the default socket and did not find the active userspace daemon. We did not test Linux at this stage.

## Remaining product work

- Review the experience with the owner on a real phone. Look especially at the map density and the navigation depth.
- Improve the dependency routing and filtering for dense graphs.
- Add configurable import roots and aliases. Add rename continuity.
- Measure the real usage. Then examine persisted snapshot caching as an option.

## Remote access follow-up

With the explicit approval of the owner, we moved Strata to localhost. We configured a private Tailscale Serve route on port 4317 through the existing userspace daemon. We tested requests through `tailscale nc` to the Tailscale address of the node. Without authentication, the repository API returned 401. With the correct browser origin, token pairing returned 200. For Visalytics, the local authenticated repository API returned 200.

The owner must still do a check on a physical phone, and Tailscale must be connected on that phone. We did not create a public tunnel.

## Phone loading fix

The active server produced the warm comparison in approximately 70 ms, but it transferred 4,046,626 bytes without compression. We removed the symbol hashes from the viewer payload. The hashes still determine the symbol status on the server. We added negotiated gzip compression for JSON and static assets. The responses keep `no-store` and vary by `Accept-Encoding`. They also obey `gzip;q=0`.

A 390 × 844 Chromium test used 1 Mbps download throughput and 100 ms latency, and both snapshots were already warm. The time to a usable map was 33,503 ms before the change and 3,660 ms after it. The comparison transfer decreased to 356,462 bytes, and all 60 changed files stayed in the comparison. This test measures a simulated connection. It does not measure the physical phone of the owner or cold snapshot generation.

Regression checks cover compressed/uncompressed response equivalence, gzip opt-out, static HTML decoding, payload reduction and the removal of internal hashes. All engine/API tests pass.

## Mockup-based viewer correction

We replaced the initial dashboard with the visual foundation from the HTML mockup of the owner. This foundation includes the original colour tokens, the pastel backdrop, the glass sheets and the card styling. It also includes the commit chips, the selection strip and the responsive stage/panel layout. The live renderer adds nested package cards, curved selectable import edges, dashed external neighbours, module boundaries and symbol cards. Time uses first-parent commit history and sheets that peek. Diff uses explicit base/head and Before/After.

A tap selects, and a second tap opens with a zoom animation. Large maps scroll in the stage.

We kept the existing real Git analysis, private authentication, gzip responses, source/diff endpoints and all-file accounting. The scope adaptations are explicit. Structure replaces Health, which had no measurements. Changes/Source/Dependencies tabs replace Comments/Ask, which were not implemented. The viewer does not show sample metrics, rules, comments or agent runs as live data.

Browser checks against Visalytics pass at 390 × 844 and 1366 × 768. They check authentication, fixed-viewport layout, select-before-open behaviour, zoom navigation and symbol/source inspection. They also check selectable dependency edges, Time peeks, Diff comparisons, Before/After, search and dark mode.

We captured and inspected the original mockup after the animations stopped. We also captured and inspected live overview, component, module, source-detail and dark-theme screenshots. Model regression tests cover loose root files, nested rollups and replacement imports with unchanged counts. They also cover the correct visibility of additions/removals in each view.

## SVG map, filtering, and declaration metadata

We added an SVG viewport around the reference-style card map and the vector links. We verified mouse drag, wheel pan, real browser touch pinch, zoom, Fit, reset and drag/pinch click suppression. We also verified that keyboard focus brings offscreen cards into view. Changes only filters hierarchy cards and import edges, but it keeps the external dependency context. The filter does not hide complete file diffs or the searchable file inventory.

The engine extracts Python module/class/function docstrings and annotations without execution. It also extracts TypeScript/JSDoc descriptions and declared types without execution. The inspector includes signatures, argument defaults and kinds, return annotations, class bases and typed fields. The details are specific to a revision, and the viewer gets them only with the opened file. The inspector labels missing types. It does not show inferred documentation.

Eight engine/model/API tests pass. They include metadata provenance, Python positional/keyword/variadic arguments, async signatures, JSDoc argument and return tags and generics. They also include class fields, revision switching and the exclusion of descriptions from initial comparisons. Browser integration against Visalytics passes at 390 × 844 and 1366 × 768. This includes the existing Time/Diff, source, dependency and authentication checks.

We visually inspected the phone and desktop metadata screens together with the map overview. Git still ignores the screenshots. The owner must still test the gestures on a physical phone.

On the same simulated 1 Mbps / 100 ms mobile connection, the new warm map became usable in 3,944 ms. The compressed comparison is 356,831 bytes. Before this change, it was 356,462 bytes. All 60 changed files stay in the comparison. Full declaration metadata does not increase the size of the initial repository map payload. This warm measurement does not include cold parsing.

## Incremental index and compact overview

We implemented content-addressed syntax reuse, a private SQLite index, a worker-backed CLI, asynchronous gzip and compact initial comparisons. Full symbol comparisons and unresolved imports now come with the file details. We kept the SVG map, file inventory, status rollups and dependency edges. Persistent data stays in the ignored `.strata/index/` directory. The inspected repository objects stay read-only.

We measured against Visalytics with `STRATA_BASELINE_ENGINE=.strata/stable/src/engine.mjs STRATA_PYTHON=/usr/bin/python3 node scripts/benchmark.mjs /path/to/visalytics HEAD~10 HEAD`:

| Measurement | Result |
| --- | ---: |
| Previous implementation, cold full comparison | 6,737 ms |
| New implementation, empty index and overview | 6,965 ms |
| New worker, existing disk index | 894 ms |
| Warm overview, median of five samples | 34 ms |
| Previous compressed comparison | 356,831 bytes |
| New compressed overview | 47,929 bytes |

The first indexing parsed 1,243 files and reused 1,177 analyses across the two snapshots. When the index opened again, it parsed zero files and reused 2,420 analyses. File paths, statuses and before/after dependency edges matched the previous engine exactly. In this measurement, the initial scan is not faster. The improvements are in reuse, restart behaviour, HTTP responsiveness and transfer size. Worker timings include worker initialization but not process startup, and we did not clear the filesystem cache of the operating system.

A separate browser comparison used three samples. It warmed both backends and used new 390 × 844 browser pages with 1 Mbps download throughput and 100 ms latency. The previous map-ready times were 3,932 / 3,950 / 3,958 ms. The new times were 1,421 / 1,421 / 1,410 ms. The median improved from 3,950 to 1,421 ms. This is simulated network performance, not a measurement on a physical phone.

Twelve automated tests pass. They include persistent reuse across a new repository instance, changed-blob-only parsing and moved relative-import resolution that does not change old snapshots. They also include overview/full-source equivalence, worker shutdown/error handling and memory fallback when the disk index is unavailable. Mobile and desktop browser checks pass against Visalytics. We inspected screenshots of the mobile file drill-down and the desktop overview.

This is the optimized Node baseline. We did not build or measure a Rust implementation or an equivalent end-to-end benchmark at this stage.

## Rust backend migration

The production service is now a Rust executable. It uses Axum/Tokio, rusqlite with bundled SQLite and a bounded repository-work queue. Rust is responsible for HTTP, authentication, Git subprocesses, snapshots, comparison generation, dependency resolution and the persistent index. The Python AST and the TypeScript compiler stay as isolated parser helpers. No Node HTTP backend runs. The former backend is in `test/reference/` for parity tests and benchmarks.

Five native Rust tests and sixteen Node-driven integration/model/reference tests pass. Native parity checks cover the full and compact comparison of every fixture, before/after source and metadata, and reverse and identical comparisons. They also cover removed files, class/method signatures, Svelte, restricted/binary/large/symlink content, executable modes and malformed source. Other native checks cover Unicode filenames and large UTF-8 documentation, HEAD references that move, missing parsers, restart reuse and unavailable disk indexes. HTTP checks cover pairing, cross-origin rejection, token/cookie auth, read-only methods, bad refs/paths, static allowlists, gzip opt-out and security headers. Clippy passes with warnings denied.

`npm run test:browser` now starts Rust. It passes against Visalytics at 390 × 844 and 1366 × 768. It covers SVG pan/pinch/zoom, filtering, source and metadata, Time/Diff, dependency selection, dark mode and authentication. We inspected mobile and desktop metadata screenshots. Full Visalytics comparisons match the Node reference exactly, including 1,706 files, 60 changed files, symbol status/ranges and all dependency edges. Selected Python and TypeScript source/metadata responses also match.

The first direct port was slower than Node (97 ms versus 56 ms warm API median). We then made these changes:

1. We changed the Git invocation to use `-C`. This prevents changes to the working directory of the complete process.
2. We reused immutable comparison results.
3. We skipped a second resolution of commit SHAs that were already in the cache.
4. We ran the Python and TypeScript parsing batches concurrently.

We repeated the same benchmark with the release executable:

| Local API measurement | Optimized Node reference | Rust |
| --- | ---: | ---: |
| Empty-index comparison request (single run) | 7,176 ms | 7,187 ms |
| Warm comparison request (median of five) | 53 ms | 44 ms |
| Compressed overview | 47,929 bytes | 46,764 bytes |

A restarted Rust process with the existing index handled its first comparison request in 1,233 ms. A separate restarted-process check reported zero parsed files and 2,420 reused analyses. These request measurements do not include service startup. They include JSON transfer/decoding on loopback. They use release builds and symbolic Git refs, and they do not clear operating-system filesystem caches. They do not prove a general claim about language performance.

The test used a new 390 × 844 browser page with simulated 1 Mbps download and 100 ms latency. The warmed Node map-ready times were 1,871 / 1,452 / 1,410 ms. The Rust times were 1,434 / 1,436 / 1,395 ms. The medians were 1,452 ms for Node and 1,434 ms for Rust. Thus, the phone experience stays effectively the same, and there is no large speedup. The very first repository scan still takes approximately seven seconds.

The physical phone and Linux checks are still not done.

We deployed a stable copy of the release executable and the TypeScript helper in `.strata/runtime/`. The deployment reused the existing access token and the private Tailscale route. We verified these conditions:

- The live PID is the Rust executable.
- All 12,428 symbols are present.
- Both parsers are available.
- Authenticated compact comparisons match over Tailscale.
- Source metadata loads.
- Unauthenticated API requests return 401.

## Static relationships and dependency rules

We added call/heritage evidence that the adapters emit, a shared declaration resolver and committed `.strata.json` constraints. Rust trait implementations and supertraits, Python inheritance, and TypeScript/JavaScript heritage use the same relationship model. Named calls resolve conservatively. Dynamic receivers, shadowing, ambiguous declarations and unsupported targets stay explicit. The engine evaluates the configuration independently on each side of a comparison. Thus, you can still review rule-only changes.

Twenty Node-driven regression/model/API tests and nine native Rust tests pass. We added coverage for all three language adapters, imported aliases, local calls, shadowing, nested-body attribution and ambiguous traits. We also added coverage for negative Rust impls, incoming references, rule-only changes, reversed comparisons, malformed config, uncommitted configuration isolation and authentication. Clippy passes with warnings denied.

Browser checks at 390×844 and 1366×768 cover real Strata adapter files and Visalytics. They also cover a fixture that violates rules intentionally. The fixture verifies directory rollup badges, Before/After outcomes, retention under Changes only and typed call edges. It also verifies unresolved evidence and navigation back to source. We inspected mobile and desktop relationship screenshots.

Visalytics produced no parser/availability gaps. Its committed tree has no `.strata.json`. Thus, we do not claim policy compliance. The first relationship-enabled scan with an empty index took approximately 12–13 seconds on this host. The first implementation returned 6,030,292 bytes of repeated overview JSON.

Compact file pairs decreased that size to 128,865 JSON bytes / 13,496 gzip bytes for 1,173 pairs. The response reused ordinary imports from the existing file overview, and it loaded detailed symbol evidence lazily. These sizes are for the relationship response only. They do not include the complete initial page.

## Review workflow (2026-09-29)

The comments/run slice adds durable anchored drafts, immutable previews, isolated Codex/Claude launchers, run-scoped stdio MCP reports and owner verification. Automated validation uses a deterministic local agent, not a paid model session.

- 24 Node-driven tests and 9 native Rust tests cover the existing engine and the new workflow. Strict Clippy checks pass.
- New integration cases cover draft/ref conflicts, duplicate dispatch, one active run, attribution checks, cross-run report rejection and flagging. They also cover unreported outcomes, verification notes, reopening, persistence, cancellation, missing executables and service interruption.
- The browser workflow completes draft → preview → dispatch → commit/MCP report → inspect → verify at 390×844 and 1366×768. A source-Before regression checks the saved SHA and the symbol anchor.
- Existing map, source, dependency and relationship browser checks pass. Visalytics also passes the phone and desktop inspection suite, and the suite does not change its checkout. We visually inspected the workflow screenshots.
- On this host, the sign-in status commands of the installed Codex and Claude Code are successful. This validation did not test their real paid execution, model behavior or test quality.

Refer to [WORKFLOW.md](WORKFLOW.md) for current-status history semantics, polling, process recovery, permissions and the remaining specification items.

### Comment and Ask navigation

The review panel now uses Comments and Ask. Run preparation and progress are nested under Comments. The additional Ask integration test checks committed context, disabled execution tools and a credential-free provider environment. It also checks that Ask does not create drafts or runs automatically. At phone and desktop sizes, browser checks test the sequence question → answer → explicitly saved draft. We inspected the screenshots.

Validation uses a deterministic local provider, not a live model request. The current suite has 25 Node-driven tests and 10 native Rust tests. A native regression verifies that Ask includes a selected declaration near the end of a large file.

## Clean Linux install (2026-10-02)

We followed `docs/SETUP.md` from source in an empty `debian:bookworm-slim` container (x86_64). The container had only the committed tree (`git archive HEAD`), Git 2.39, Python 3.11, the official Node 22.23.3 build and Rust 1.99. `npm ci` and `npm run build:rust` were successful. The release build took 1 minute 35 seconds on 4 CPUs. `strata install` and `strata doctor` passed every required check and labelled GitHub CLI, Claude Code, Codex and Tailscale as optional.

We registered a repository with two commits. Then `strata serve` started, and `strata pair` printed a link. Unauthenticated API requests returned 401, and pairing returned a session. The comparison accounted for all 156 files. It parsed 16 Rust files, 41 TypeScript files and 1 Python file, and labelled the rest as file-level or binary. It found the one changed file and classified its Python change as a signature change.

The service served source, declaration details, relationships and every interface asset, including the manifest and the service worker.

The container has no systemd user session, so `strata start` cannot install the background service. Before, it failed with a raw `systemctl` error. Now it explains the situation and recommends `strata serve`. It exits non-zero and does not leave a unit file, and `strata doctor` reports the missing service manager. We did not test the systemd service itself, ARM builds or a browser session against the container.

## Linux release archive (2026-10-02)

We built `strata-0.2.0-linux-x64.tar.gz` (52 MB) with `scripts/package.mjs` in an `ubuntu:22.04` container. This build matched the release workflow. The bundled server needs glibc 2.34 and the bundled Node needs 2.28. We installed it with `install.sh` (with `STRATA_ARCHIVE`) in new `debian:bookworm-slim` and `ubuntu:22.04` containers. These containers had only Git and curl, with no Node, Rust or Python.

In both containers:

- The installer refused an archive with a wrong checksum and showed "nothing was installed". The installer did not install anything.
- The real archive installed to `~/.local/lib/strata` with a link in `~/.local/bin`. The launcher of the first build resolved its directory from the link and could not find Node. The launcher now follows links first.
- `strata doctor` passed Git, Server, Node and the TypeScript parser. It marked Python, GitHub CLI, Claude Code, Codex, Tailscale and the background service as missing optional tools.
- `strata start` explained that no systemd user session exists and exited non-zero. `strata serve` ran in the foreground.
- Unauthenticated API requests returned 401 and pairing returned 200. The comparison found the changed files. The bundled TypeScript parser classified a JavaScript parameter change as a signature change.
- Without Python, the changed Python file had the label "Python unavailable · file-level analysis". After we installed Python 3.10 on Ubuntu, the comparison classified the same edit as a signature change. Doctor reported Python as available.
- The service served the page, `app.js`, the manifest and the service worker. After two more installs, one backup remained.

We did not yet run the macOS and ARM archives, the GitHub download path in `install.sh` or the release job. They need the workflow and a published release.
