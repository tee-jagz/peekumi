# Hermes integration checks

These probes use installed upstream packages.
They do not run with `npm test`.
Run them from the Peekumi repository root.
Use the source revisions in [the progress record](../../docs/HERMES-HACKATHON.md).

Set `HERMES_SOURCE` to the pinned Hermes source folder.
Set `CRAPPER_PYTHON` to the isolated crapper Python executable.

```sh
"$HERMES_SOURCE/.venv/bin/python" test/hermes/hooks_probe.py
"$CRAPPER_PYTHON" test/hermes/crapper_probe.py
```

The hook probe loads `stub/` with the real Hermes plugin loader.
It checks the prologue, gate cap, shell edit path and finalizer.
It uses a temporary Hermes home and makes no model call.

The crapper probe creates its own small Python fixture.
It runs tests with coverage in a new private copy.
It exports relative LCOV to `target/coverage/lcov.info`.
It enables branch coverage to measure the uncalled function at 0%.
It then runs crapper with `--use-existing-coverage --root`.
It checks the EDN score against complexity 6, coverage 0% and CRAP 42.
It also checks that missing coverage becomes zero upstream.
P4 must replace that result with unknown when the report has no evidence.
All temporary folders are removed when the probe ends.

Install crapper and its dependencies in a separate environment with `requirements-crapper.txt`.
Install its Python parser before the probe.
The installed parser checksum is in the progress record.
Do not let the analysis service download a parser at runtime.

Run `python3 test/hermes/gate_test.py` for the gate against a local stub server.
Run `python3 test/hermes/measure_test.py` for archive traversal, link and size checks.
The gate tests cover retries, session separation, the nudge cap, shell edits and outages.
They also keep pending evidence from showing a previous pass as current.

## Full local verification

Set `PEEKUMI_TEST_CRAPPER_CONFIG` to the clean install's `peekumi-crapper.json`.
Set `PEEKUMI_TEST_HERMES_PYTHON` to the pinned Hermes environment's Python.
Run the API suite with a Python environment that has `jsonschema` and the pinned crapper dependencies:

```sh
"$CRAPPER_PYTHON" test/hermes/integration_e2e_test.py
"$CRAPPER_PYTHON" test/hermes/clean_install.py
"$CRAPPER_PYTHON" test/hermes/pane_fixture.py
node test/hermes/pane.mjs
PEEKUMI_NATIVE_SCENARIO=1 node test/hermes/native-pane.mjs
node test/hermes/encode-demo.mjs
```

The native test needs a source-built Hermes Desktop at `HERMES_SOURCE`.
Set `PEEKUMI_TEST_CRAPPER_PYTHON` to the fixture Python environment for that test.
The browser adapter needs React, React DOM and esbuild in `PEEKUMI_PANE_DEPS`.
It defaults to `~/.local/share/peekumi-hackathon/pane-preview`.
The encoder needs FFmpeg and Playwright Chromium.

The API suite checks real exports, coverage, crapper, schemas and Hermes tool dispatch.
It also compares scores with an independent crapper CLI run on the same source and report.
The clean install test uses a new registry and profile. It redacts its temporary token.
It does not install into the owner's active profile.

The native scenario uses a scripted local provider and the real Hermes conversation loop.
It performs two measurements and observes the actual stop-gate nudge before the repair.
It also selects the rule and unsupported language.
No paid model or real account is used.
The MP4 keeps the native frame timing and adds reading pauses at the inspected evidence.
Its visible caption identifies the scripted provider.
Artifacts stay in the ignored `test-results/hermes/` folder.
Selected screenshots of our own fixture also go in the plugin README.
