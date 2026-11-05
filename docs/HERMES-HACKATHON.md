# Hermes Risk Map progress

Use the v5 plan dated 2026-11-05 as the scope for this work.
The submission deadline is 2026-11-11 at 17:00 EST (22:00 London).
The owner must approve all publication steps.
Do not push, create a repository, open a pull request or post a submission without that approval.

## Local work

The branch is `hermes/day-1`.
Its worktree is `~/projects/peekumi-hermes-day1`.
It starts at `e70e8c45bc36ae6156067dc831bd4141019116d0` in `~/projects/peekumi`.
The original checkout has unrelated changes.
This work leaves those changes in place.

Keep the hook stub in `test/hermes/` until the owner selects the plugin location.
The planned default CRAP threshold is 30.
Show the owner a real pane screenshot in day 4.

## Day 1

| Work | State | Evidence |
| --- | --- | --- |
| Install Hermes | Done locally | Python 3.14.7; locked source environment; revision below |
| Check the three hooks | Pass | `test/hermes/hooks_probe.py`: two tests with the loaded stub |
| Run crapper in a private copy | Pass | Measured complexity 6, branch coverage 0%, CRAP 42; checkout unchanged |
| Write the boundary test list | Done | Matrix below |
| Start P1 | Done for day 1 | Baseline storage and retention; acceptance checks below |

Hermes source: `NousResearch/hermes-agent@84a0301415edd6d1385207ec96e4d7f2b6c1fcd9`.
Crapper source: `unclebob/crapper@6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d` (version 0.1.0).
Both installs are under `~/.local/share/peekumi-hackathon/`.
No account or model credentials are required for the probes.
The pinned Hermes catalog has no `peekumi-risk-map` entry.

The hook probe uses the real plugin loader, registration context and hook dispatch.
It calls the real turn prologue, stop gate and finalizer seams with a small test agent.
It makes no model request.
It does not prove a complete Desktop agent session.

The probe confirms these facts:

- `pre_llm_call` carries the session and turn IDs.
- `pre_verify` carries the session, changed paths and zero-based attempt. It has no turn ID.
- With a cap of three, attempts 0, 1 and 2 reach the hook. Attempt 3 does not.
- Shell-only edits can skip `pre_verify`.
- `post_llm_call` runs through the finalizer after both paths. It carries the turn ID.

The plugin must retain the current turn identity for the gate.
It must refresh the result in the finalizer after the cap and after shell-only edits.

The day 1 checks pass:

- `npm test`: 107 tests pass with local fixture-server access.
- `npm run test:rust`: 58 tests pass, including six new baseline tests.
- `npm run format` and `npm run format:check`: pass.
- `npm run lint`: pass. The documents have 73 existing long-sentence warnings and no errors.
- Hermes hook probe: two tests pass.
- Private-copy crapper probe: one test passes with network access blocked.

No interface code changes in this slice.
Browser checks and the pane screenshot remain in day 4.

## Acceptance criteria

| Plan item | Current evidence | Remaining work |
| --- | --- | --- |
| P1 | Six Rust tests pass for dirty starts, commits, retries, retention, identity and repository contents | Connect the scoped API; attach coverage evidence to the baseline lifetime |
| P2 | Not started | Repository scope, route restrictions, token commands, revocation and regression tests |
| P3 | Not started | API schemas, fixture responses, snapshot export, frozen rule checks and bounded map |
| P4 | Day 1 private-copy probe passes | LCOV validation, evidence identity, EDN mapping and coverage-only refresh |
| H1 | Hook behavior checked against pinned Hermes | Baseline client, gate outcomes, exceptions, outages and cap handling |
| H2 | Not started | Impact tool and private-copy measurement tool |
| H4 | Not started | Desktop pane and day 4 screenshot |
| H5 | Not started | Agent skill for impact, measurement and exceptions |
| Release | Not started | Validation, clean install, README, video and owner-approved submission |

P1 currently keeps the complete private object store while a baseline is active.
The 1 GiB cleanup threshold is therefore a soft limit during active sessions.
This conservative rule protects baseline source and rule objects.
Coverage evidence storage is not implemented yet.
The worker has internal `integration_baseline` and `integration_release` operations.
There are no new HTTP routes yet.

## Required boundary tests

Pending means the production behavior still needs a test.
A probe result does not replace an integration test.

| ID | Boundary | Expected result | State or test |
| --- | --- | --- | --- |
| B01 | Dirty start | Keep the dirty source, rules and pre-existing path list | Rust baseline test passes |
| B02 | Commit during the turn | Keep the original baseline SHA and rule revision | Rust baseline test passes |
| B03 | Retry or service restart | Load the same baseline; renew its last-use time | Rust baseline test passes |
| B04 | Cleanup with an active baseline | Keep the snapshot and rule objects readable | Rust baseline test passes |
| B05 | Session end and 24-hour idle expiry | Release only the matching pins | Rust baseline tests pass |
| B06 | Wrong repository or identity | Refuse the request; keep other sessions isolated | Storage test passes; token test pending |
| B07 | Revoked token | Return 401 | Pending P2 |
| B08 | Every write route | Refuse an integration token; keep owner and reader behavior | Pending P2 |
| B09 | Stale, absent or omitted LCOV | Show unknown with a reason for each affected function | Pending P4 |
| B10 | Test or export command fails | Record failed evidence; keep coverage unknown | Pending P4/H2 |
| B11 | Fresh coverage, same source tree | Recompute risk; clear findings only with valid evidence | Pending P4 |
| B12 | Measurement runs | Use a new private copy; leave the checkout unchanged | Private-copy probe passes; H2 pending |
| B13 | Shell-only edit | Final refresh shows current evidence | Hook probe passes; H1 pending |
| B14 | Nudge cap reached | Final findings become exhausted; other API outcomes stay as returned | Hook cap checked; H1 pending |
| B15 | Missing coverage | Never report passed | Pending P3/H1 |
| B16 | Peekumi or crapper outage | Show unavailable; let the agent finish | Pending P4/H1 |
| B17 | Rule file changes after baseline | Report the rule change; check with the frozen rules | Frozen bytes tested; rule check pending P3 |
| B18 | Repository inspection | Keep object bytes, refs, index, configuration and files unchanged | Rust baseline test passes; endpoint checks pending |
| B19 | Snapshot export | Read private objects; reject restricted paths and unsafe links; enforce limits | Pending P3/H2 |
| B20 | Map limits and unsupported files | Keep explicit labels and unresolved edges; disclose aggregation | Pending P3/H4 |
| B21 | New Python function | Show new; require its own after evidence | Pending P4/H4 |
| B22 | Coverage provenance | Accept only successful commands and a report from the run folder | Pending P3/H2 |
| B23 | Clean installation | Validate the manifest, permissions, security scan and pane bundle | Pending day 5 |

## Next work

The crapper probe passes with branch coverage enabled.
Line coverage alone reports 8.3333% because importing the module covers the function definition.
Use real measured values in the demo.

Crapper calls the parser package download function when it first loads a parser.
Install the Python parser before analysis.
The day 1 probe passes with network access blocked after that install.
The installed parser package is `tree-sitter-language-pack==1.23.1`.
The macOS x86_64 Python parser has SHA-256 `72ac8b7b168524c011204984ab4a276c9403e88188275b09fb1d755e92849885`.
P4 must check this installation and report unavailable if the parser is absent.
Do not allow a parser download during production analysis.

Run the repository checks before each commit.
On day 2, connect P1 and P2 to the scoped API.
Test H1 against a stub service before the fixture run on day 3.
