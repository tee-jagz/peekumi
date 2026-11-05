# Hermes day 1 probes

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
