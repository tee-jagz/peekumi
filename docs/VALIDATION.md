# First integration validation

Validated on 29 September 2026 against the local Visalytics repository, without modifying its working tree.

## Comparison

- Base: `7cf0a97cd8f5386e9558d9b3bcefccd5b47464fa`
- Head: `8b1afb15a8f27e476e2a682308e41ba1d31acc9e`
- 1,706 tracked files in the comparison
- 60 changed files: 25 added, 35 modified, 0 removed
- 12,428 extracted symbols in the comparison
- 3,924 resolved internal import relationships at head
- Zero parser errors after excluding Svelte JSON data scripts from TypeScript parsing
- The complete changed-file set matched `git diff --no-renames --name-only` exactly

The initial cold comparison took about 6.4 seconds on this host before the final Svelte adjustment. Snapshots are cached in memory; cold-start latency remains an optimisation opportunity. This is not a validated sub-second performance claim.

## Automated checks

`npm test`: three passing suites covering Git change accounting, class attributes, constants, template changes, executable mode changes, removals, dependency resolution, full file patches, binary/restricted source handling, invalid revisions, parser failure, missing Python, reverse comparisons, authentication, cross-origin pairing rejection, session cookies, and read-only API enforcement.

`npm run test:browser` against Visalytics: passed at 390 × 844 and 1366 × 768. Covered token pairing, token removal from the URL, folder navigation, file search, source/diff loading, symbol highlighting, Before/After selection, changed-only filtering, empty search results, identical-revision comparison, browser errors, and page overflow.

Captured and visually inspected overview and component screens at both sizes, plus readable source detail captures at both sizes. Text labels wrap in cards, source scrolls horizontally within its pane, and the page itself does not overflow. Screenshots stay in ignored `test-results/` because they include private repository details. The installed Chrome initially produced repeated viewport tiles in a full-page screenshot; final captures used the matching Playwright Chromium build.

The LAN service returned HTTP 401 without authentication and served the expected comparison with authentication. A physical phone and access from outside the LAN have not been tested. The initial Tailscale check used the default socket and missed the running userspace daemon. Linux is not yet tested.

## Remaining product work

- Review the experience with the owner on a real phone, especially map density and navigation depth.
- Improve dependency routing and filtering for dense graphs.
- Add configurable import roots and aliases, and rename continuity.
- Consider persisted snapshot caching after measuring real usage.

## Remote access follow-up

With the owner’s explicit approval, moved Strata to localhost and configured a private Tailscale Serve route on port 4317 through the existing userspace daemon. Tested requests through `tailscale nc` to the node’s Tailscale address: the repository API returned 401 without authentication, and token pairing returned 200 with the correct browser origin. The local authenticated repository API returned 200 for Visalytics. A physical phone check remains with the owner; the phone must have Tailscale connected. No public tunnel was created.

## Phone loading fix

The running server produced the warm comparison in about 70 ms, but transferred 4,046,626 bytes without compression. Removed symbol hashes from the viewer payload (hashes still determine symbol status on the server) and added negotiated gzip compression for JSON and static assets. Responses retain `no-store`, vary by `Accept-Encoding`, and honour `gzip;q=0`.

A 390 × 844 Chromium test with 1 Mbps download throughput and 100 ms latency measured time to a usable map at 33,503 ms before and 3,660 ms after, with both snapshots already warm. Comparison transfer fell to 356,462 bytes, with all 60 changed files preserved. This measures a simulated connection, not the owner's physical phone or cold snapshot generation. Regression checks cover compressed/uncompressed response equivalence, gzip opt-out, static HTML decoding, payload reduction, and removal of internal hashes. All engine/API tests pass.

## Mockup-based viewer correction

Replaced the initial dashboard with the visual foundation from the owner's HTML mockup: original colour tokens, pastel backdrop, glass sheets, card styling, commit chips, selection strip, and responsive stage/panel layout. The live renderer adds nested package cards, curved selectable import edges, dashed external neighbours, module boundaries, and symbol cards. Time uses first-parent commit history and peeking sheets; Diff uses explicit base/head and Before/After. Tap selects and a second tap opens with zoom animation. Large maps scroll within the stage.

Kept the existing real Git analysis, private authentication, gzip responses, source/diff endpoints, and all-file accounting. Scope adaptations are explicit: Structure instead of unmeasured Health, and Changes/Source/Dependencies tabs instead of unimplemented Comments/Ask. No sample metrics, rules, comments, or agent runs are presented as live data.

Browser checks against Visalytics pass at 390 × 844 and 1366 × 768 for authentication, fixed-viewport layout, select-before-open behaviour, zoom navigation, symbol/source inspection, selectable dependency edges, Time peeks, Diff comparisons, Before/After, search, and dark mode. Captured and inspected the original mockup after animations settled, plus live overview, component, module, source-detail, and dark-theme screenshots. Model regression tests cover loose root files, nested rollups, replacement imports with unchanged counts, and correct visibility of additions/removals in each view.

## SVG map, filtering, and declaration metadata

Added an SVG viewport around the reference-style card map and vector links. Verified mouse drag, wheel pan, real browser touch pinch, zoom, Fit, reset, drag/pinch click suppression, and keyboard focus bringing offscreen cards into view. Changes only filters hierarchy cards and import edges, retaining external dependency context. The filter does not hide complete file diffs or the searchable file inventory.

Python module/class/function docstrings and annotations, plus TypeScript/JSDoc descriptions and declared types, are extracted without execution. The inspector includes signatures, argument defaults and kinds, return annotations, class bases and typed fields. Details are revision-specific and fetched only with the opened file. Missing types are labelled; no inferred documentation is presented.

Eight engine/model/API tests pass, including metadata provenance, Python positional/keyword/variadic arguments, async signatures, JSDoc argument and return tags, generics, class fields, revision switching, and exclusion of descriptions from initial comparisons. Browser integration against Visalytics passes at 390 × 844 and 1366 × 768, including the existing Time/Diff, source, dependency and authentication checks. Visually inspected phone and desktop metadata screens alongside the map overview; screenshots remain ignored. Physical-phone gesture testing remains with the owner.

On the same simulated 1 Mbps / 100 ms mobile connection, the new warm map became usable in 3,944 ms. The compressed comparison is 356,831 bytes, versus 356,462 bytes before this change, with all 60 changed files preserved. Full declaration metadata does not inflate the initial repository map payload. Cold parsing remains separate from this warm measurement.

## Incremental index and compact overview

Implemented content-addressed syntax reuse, a private SQLite index, a worker-backed CLI, asynchronous gzip, and compact initial comparisons. Full symbol comparisons and unresolved imports now arrive with file details. The SVG map, file inventory, status rollups and dependency edges are preserved. Persistent data stays under ignored `.strata/index/`; inspected repository objects remain read-only.

Measured against Visalytics with `STRATA_BASELINE_ENGINE=.strata/stable/src/engine.mjs STRATA_PYTHON=/usr/bin/python3 node scripts/benchmark.mjs /Users/tolu/projects/visalytics HEAD~10 HEAD`:

| Measurement | Result |
| --- | ---: |
| Previous implementation, cold full comparison | 6,737 ms |
| New implementation, empty index and overview | 6,965 ms |
| New worker, existing disk index | 894 ms |
| Warm overview, median of five samples | 34 ms |
| Previous compressed comparison | 356,831 bytes |
| New compressed overview | 47,929 bytes |

First indexing parsed 1,243 files and reused 1,177 analyses across the two snapshots. Reopening the index parsed zero files and reused 2,420 analyses. File paths, statuses and before/after dependency edges matched the previous engine exactly. The initial scan is not faster in this measurement; the improvements are reuse, restart behaviour, HTTP responsiveness and transfer size. Worker timings include worker initialization but not process startup, and the operating system's filesystem cache was not cleared.

A separate three-sample browser comparison warmed both backends and used fresh 390 × 844 browser pages with 1 Mbps download throughput and 100 ms latency. Previous map-ready times: 3,932 / 3,950 / 3,958 ms. New times: 1,421 / 1,421 / 1,410 ms. Median improved from 3,950 to 1,421 ms. This is simulated network performance, not a physical-phone measurement.

Twelve automated tests pass, including persistent reuse across a fresh repository instance, changed-blob-only parsing, moved relative-import resolution without mutating old snapshots, overview/full-source equivalence, worker shutdown/error handling, and memory fallback when the disk index is unavailable. Mobile and desktop browser checks pass against Visalytics; screenshots of the mobile file drill-down and desktop overview were inspected. This is the optimized Node baseline. A Rust implementation and equivalent end-to-end benchmark have not been built or measured yet.

## Rust backend migration

The production service is now a Rust executable using Axum/Tokio, rusqlite with bundled SQLite, and a bounded repository-work queue. Rust owns HTTP, authentication, Git subprocesses, snapshots, comparison generation, dependency resolution and the persistent index. Python's AST and the TypeScript compiler remain isolated parser helpers; no Node HTTP backend runs. The former backend is under `test/reference/` for parity tests and benchmarking.

Five native Rust tests and sixteen Node-driven integration/model/reference tests pass. Native parity checks cover every fixture's full and compact comparison, before/after source and metadata, reverse and identical comparisons, removed files, class/method signatures, Svelte, restricted/binary/large/symlink content, executable modes, malformed source, Unicode filenames and large UTF-8 documentation, moving HEAD references, missing parsers, restart reuse and unavailable disk indexes. HTTP checks cover pairing, cross-origin rejection, token/cookie auth, read-only methods, bad refs/paths, static allowlists, gzip opt-out and security headers. Clippy passes with warnings denied.

`npm run test:browser` now launches Rust. It passes against Visalytics at 390 × 844 and 1366 × 768 for SVG pan/pinch/zoom, filtering, source and metadata, Time/Diff, dependency selection, dark mode and authentication. Mobile and desktop metadata screenshots were inspected. Full Visalytics comparisons match the Node reference exactly, including 1,706 files, 60 changed files, symbol status/ranges and all dependency edges. Selected Python and TypeScript source/metadata responses also match.

The first direct port was slower than Node (97 ms versus 56 ms warm API median). Changed Git invocation to use `-C`, avoiding process-wide working-directory changes; reused immutable comparison results; skipped re-resolving already-cached commit SHAs; and ran the Python and TypeScript parsing batches concurrently. Repeated the same benchmark with the release executable:

| Local API measurement | Optimized Node reference | Rust |
| --- | ---: | ---: |
| Empty-index comparison request (single run) | 7,176 ms | 7,187 ms |
| Warm comparison request (median of five) | 53 ms | 44 ms |
| Compressed overview | 47,929 bytes | 46,764 bytes |

A restarted Rust process with the existing index handled its first comparison request in 1,233 ms. A separate restarted-process check reported zero parsed files and 2,420 reused analyses. These request measurements exclude service startup, include JSON transfer/decoding on loopback, use release builds and symbolic Git refs, and do not clear operating-system filesystem caches. They do not establish a general language-performance claim.

On a fresh 390 × 844 browser page with simulated 1 Mbps download and 100 ms latency, warmed Node map-ready times were 1,871 / 1,452 / 1,410 ms; Rust times were 1,434 / 1,436 / 1,395 ms. Medians were 1,452 and 1,434 ms respectively: the phone experience is effectively maintained, not a dramatic speedup. The first-ever repository scan remains about seven seconds. Physical phone and Linux checks remain outstanding.

Deployed a stable copy of the release executable and TypeScript helper under `.strata/runtime/`, reusing the existing access token and private Tailscale route. Verified the live PID is the Rust executable, all 12,428 symbols are present, both parsers are available, authenticated compact comparisons match over Tailscale, source metadata loads, and unauthenticated API requests return 401.

## Static relationships and dependency rules

Added adapter-emitted call/heritage evidence, a shared declaration resolver and committed `.strata.json` constraints. Rust trait implementations and supertraits, Python inheritance, and TypeScript/JavaScript heritage use the same relationship model. Named calls resolve conservatively; dynamic receivers, shadowing, ambiguous declarations and unsupported targets stay explicit. Configuration is evaluated independently on each side of a comparison, so rule-only changes remain reviewable.

Twenty Node-driven regression/model/API tests and nine native Rust tests pass. Added coverage for all three language adapters, imported aliases, local calls, shadowing, nested-body attribution, ambiguous traits, negative Rust impls, incoming references, rule-only changes, reversed comparisons, malformed config, uncommitted configuration isolation and authentication. Clippy passes with warnings denied.

Browser checks at 390×844 and 1366×768 cover real Strata adapter files and Visalytics, plus a fixture that deliberately violates rules. The fixture verifies directory rollup badges, Before/After outcomes, retention under Changes only, typed call edges, unresolved evidence and navigation back to source. Mobile and desktop relationship screenshots were inspected.

Visalytics produced no parser/availability gaps. Its committed tree has no `.strata.json`, so no policy compliance is claimed. The first relationship-enabled scan with an empty index took approximately 12–13 seconds on this host. The first implementation returned 6,030,292 bytes of repeated overview JSON. Compact file pairs reduced that to 128,865 JSON bytes / 13,496 gzip bytes for 1,173 pairs, with ordinary imports reused from the existing file overview and detailed symbol evidence loaded lazily. These sizes cover the relationship response only, not the complete initial page.

## Review workflow (2026-09-29)

The comments/run slice adds durable anchored drafts, immutable previews, isolated Codex/Claude launchers, run-scoped stdio MCP reports and owner verification. Automated validation uses a deterministic local agent, not a paid model session.

- 24 Node-driven tests and 9 native Rust tests cover the existing engine and new workflow. Strict Clippy checks pass.
- New integration cases cover draft/ref conflicts, duplicate dispatch, one active run, attribution checks, cross-run report rejection, flagging, unreported outcomes, verification notes, reopening, persistence, cancellation, missing executables and service interruption.
- The browser workflow completes draft → preview → dispatch → commit/MCP report → inspect → verify at 390×844 and 1366×768. A source-Before regression checks the saved SHA and symbol anchor.
- Existing map, source, dependency and relationship browser checks pass. Visalytics also passes the phone and desktop inspection suite without modifying its checkout. Workflow screenshots were visually inspected.
- Installed Codex and Claude Code sign-in status commands succeed on this host. Their real paid execution, model behavior and test quality have not been exercised by this validation.

See [WORKFLOW.md](WORKFLOW.md) for current-status history semantics, polling, process recovery, permissions and remaining specification items.
