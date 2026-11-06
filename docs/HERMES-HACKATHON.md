# Hermes Risk Map progress

This record follows the v5 plan dated 2026-11-05.
The deadline is 2026-11-11 at 17:00 EST (22:00 London).
Local implementation and verification cover days 1 through 6.
Public submission remains with Tolu.

## Work location

Branch: `hermes/day-1`.
Worktree: `~/projects/peekumi-hermes-day1`.
Base: `e70e8c45bc36ae6156067dc831bd4141019116d0` in `~/projects/peekumi`.
The original checkout has unrelated work. This branch leaves it in place.
The plugin is staged in `integrations/hermes/` in this existing repository.
No new remote repository, push, PR or post was made.
The default CRAP threshold is 30.

## Acceptance criteria

| Item | State | Evidence |
| --- | --- | --- |
| P1: frozen baseline | Pass | Six Rust checks cover dirty starts, retry, identity, commits, expiry and cleanup |
| P1: retention | Pass | Active cleanup preserves source, frozen rules and accepted coverage evidence |
| P2: scoped token | Pass | Wrong repository and non-integration routes refused; immediate revocation; owner and reader behavior unchanged |
| P3: five endpoints | Pass | Real fixture responses validate against `docs/integrations.schema.json` |
| P3: frozen rules | Pass | A rule-file edit stays visible; checks still use baseline rules and exact import lines |
| P3: map | Pass | Real hierarchy, unresolved edges, unsupported labels, 300-node cap and disclosed aggregation |
| P4: measured risk | Pass | Independent crapper CLI agrees on the same exported source and accepted report |
| P4: evidence | Pass | Stale, absent and omitted coverage stays unknown; valid same-tree coverage clears risk |
| H1: gate | Pass | Real Hermes hooks and full native turn; cap becomes exhausted; final observer sees shell-only edits |
| H2: tools | Pass | Real registry dispatch; tests run only in fresh private copies; export uses private Git objects |
| H4: pane | Pass | Native Desktop loads the pane with the real SDK; screenshots show 42 to 6 and exact rule evidence |
| H5: skill | Done | Impact before edits, private measurement, explicit exceptions and honest unknown states |
| Day 5: validation | Pass | Manifest, declarations, security scan, no core override and Desktop surface |
| Day 5: clean install | Pass | Fresh analyzer prefix and fresh Hermes/Peekumi state checks |
| Day 6: recording | Review draft | Native recording below 90 seconds; scripted local provider is disclosed on screen |
| Submission | Owner action | Publish source, approve video, open catalog PR, post on X and send Typeform |

## Required boundaries

| ID | Boundary | Result |
| --- | --- | --- |
| B01 | Dirty start | Original dirty source, rules and path list stay frozen |
| B02 | Commit during a turn | Original baseline SHA stays fixed |
| B03 | Retry or restart | The same baseline reloads and renews its last-use time |
| B04 | Active cleanup | Source, rules and coverage evidence survive |
| B05 | Session end and 24-hour expiry | Only matching pins release |
| B06 | Wrong identity or repository | Request refused; sessions remain separate |
| B07 | Revocation | 401 without service restart |
| B08 | Other reads and every write route | Integration token refused; reader and owner checks pass |
| B09 | Stale, absent or omitted LCOV | Affected functions show unknown with reasons |
| B10 | Failed test or report command | Failed evidence is recorded; no pass is invented |
| B11 | Valid coverage, same source | New run recomputes risk and clears the finding |
| B12 | Measurement | Checkout bytes, including Git files, stay unchanged |
| B13 | Shell-only edit | Final observer refreshes to findings |
| B14 | Nudge cap | Final findings become exhausted; a later repair can still pass |
| B15 | Unknown coverage | No passed outcome |
| B16 | Service or analyzer outage | Visible unavailable; gate fails open |
| B17 | Rule-file change | Rule change finding and frozen-rule check |
| B18 | Inspection | Objects, refs, index time, configuration and files stay unchanged |
| B19 | Export | Private objects readable; restricted paths, links and unsafe archives refused |
| B20 | Map limits | Explicit labels, unresolved edges and real-parent aggregation |
| B21 | New Python function | Before shows new; after requires its own evidence |
| B22 | Provenance | Source receipt, report hash, fresh folder and both successful exits required |
| B23 | Local package | Fresh profile, enable, manifest validation and native pane load |
| B24 | Lost acceptance reply | Copy remains private; exact retry is idempotent; different replay refused |
| B25 | Partial file coverage | Parent stays grey when a function has unknown coverage |

## Release checks

- `npm test`: 111 tests pass.
- `npm run test:rust`: 58 tests pass.
- `npm run test:browser`: the full suite passes, including phone and desktop checks.
- `test/hermes/integration_e2e_test.py`: eleven checks pass with the clean analyzer and real Hermes environment.
- The same-source manual crapper comparison passes inside that suite.
- `test/hermes/gate_test.py`: seven checks pass.
- `test/hermes/measure_test.py`: two archive boundary checks pass.
- `test/hermes/hooks_probe.py`: two checks pass through the upstream turn seams.
- `test/hermes/crapper_probe.py`: one private-copy measurement check passes.
- `test/hermes/pane.mjs`: findings, repair, rule selection, unsupported language and narrow width pass.
- `test/hermes/native-pane.mjs`: the actual Desktop SDK and full scripted tool turn pass.
- `test/hermes/clean_install.py`: fresh setup, token, enable and `--install-deps` validation pass.
- `npm run format` and `npm run lint`: pass; no new document errors.

Native evidence is in `test-results/hermes/`.
The README keeps selected screenshots from our own fixture.
The 43-second MP4 has a visible scripted-provider disclosure.
The native test uses the normal Hermes read/write tools, tool bridge, hooks and finalizer.
It makes two real coverage runs and a real stop-gate nudge.
It uses no external model account.
This recording proves the integration path. It does not test model choice or model reliability.
Tolu must approve it or record a model-driven take before publication.

## Pins and limits

Hermes: `NousResearch/hermes-agent@84a0301415edd6d1385207ec96e4d7f2b6c1fcd9`.
Crapper: `unclebob/crapper@6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d`, version 0.1.0.
Python: 3.14.7. Coverage: 7.17.2. Parser pack: 1.23.1.
The catalog at this Hermes revision has no `peekumi-risk-map` collision.
The clean analyzer installer verifies the pinned source and parser archive checksums.
The macOS x86_64 Python parser SHA-256 is `72ac8b7b168524c011204984ab4a276c9403e88188275b09fb1d755e92849885`.
Runtime analysis refuses parser downloads.
Only macOS x86_64 has a clean-install and native Desktop check here.
Other platform pins do not establish a successful install.

Active baselines retain the complete private object store.
The 1 GiB cleanup threshold is a soft limit while any baseline is active.
Evidence and score caches remain in private state; this slice has no evidence garbage collector.
Coverage execution is trusted configured code in a private copy, not a hostile-code sandbox.
The measurement client attests command exits and fresh-folder provenance.
No cryptographic proof of arbitrary execution is claimed.
The nudge cap and shell-only limitation come from Hermes; the final observer reports the result.

## Owner publication steps

Review the local package, native screenshots and MP4 first.
Select the existing Peekumi subdirectory or a new plugin repository.
The prepared catalog draft uses the existing repository and `subdir`.
Publish the exact pinned commit and the required Peekumi service build.
The existing public Peekumi release does not yet contain these new endpoints.
Then open the one-file catalog PR, post the approved video with @NousResearch and send both links in the Typeform.
Only Tolu performs these steps under the v5 plan.
