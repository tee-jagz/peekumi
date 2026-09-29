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
- Improve dependency visualisation beyond grouped, navigable relationship rows.
- Add configurable import roots and aliases, and rename continuity.
- Consider persisted snapshot caching after measuring real usage.

## Remote access follow-up

With the owner’s explicit approval, moved Strata to localhost and configured a private Tailscale Serve route on port 4317 through the existing userspace daemon. Tested requests through `tailscale nc` to the node’s Tailscale address: the repository API returned 401 without authentication, and token pairing returned 200 with the correct browser origin. The local authenticated repository API returned 200 for Visalytics. A physical phone check remains with the owner; the phone must have Tailscale connected. No public tunnel was created.

## Phone loading fix

The running server produced the warm comparison in about 70 ms, but transferred 4,046,626 bytes without compression. Removed symbol hashes from the viewer payload (hashes still determine symbol status on the server) and added negotiated gzip compression for JSON and static assets. Responses retain `no-store`, vary by `Accept-Encoding`, and honour `gzip;q=0`.

A 390 × 844 Chromium test with 1 Mbps download throughput and 100 ms latency measured time to a usable map at 33,503 ms before and 3,660 ms after, with both snapshots already warm. Comparison transfer fell to 356,462 bytes, with all 60 changed files preserved. This measures a simulated connection, not the owner's physical phone or cold snapshot generation. Regression checks cover compressed/uncompressed response equivalence, gzip opt-out, static HTML decoding, payload reduction, and removal of internal hashes. All engine/API tests pass.
