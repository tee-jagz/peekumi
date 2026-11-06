# Hermes release review

All files here are local review material.
No publication step has run.
The v5 plan reserves those steps for Tolu.

Local source installation passes. Public catalog installation is not ready.
The source route uses `PEEKUMI_SOURCE` and needs no test-only command wrapper.
Setup prints the foreground service command with the analyzer environment.
The user still installs the plugin and saves the printed Hermes settings and profile secret.
Publication of the required Peekumi build and pinned plugin source remains necessary.

## Local artifacts

The current release folder is `test-results/hermes/release-google/`.
It contains the plugin ZIP, full Peekumi source archive, checksums and catalog draft.
The draft pins the complete local commit SHA.
That commit must become public before the catalog entry can work.
The ZIP contains only committed plugin files.
It has no snapshot state, coverage reports or tokens.

The current review video is `test-results/hermes/native-demo-focused.mp4`.
It stays below the 90-second limit.
Numbered stages and Google Gemini TTS explain the workflow.
The voice is Charon. Only the narration text goes to Google.
Google TTS produces review audio. It is not a plugin runtime dependency.
The graph has the main pane width. The diff supports the graph.
The edit uses high-resolution native captures with timed close-ups and highlights.
Each spoken clause points to a node, edge, metric or supporting diff.
A small full-window view identifies each close-up's location.
The gate's actual feedback appears as a labelled excerpt.
The original Google audio track stays unchanged. Its packet hash is checked.
It explains the required Peekumi service before the demo starts.
A visible caption identifies the scripted local provider throughout.
The provider drives the actual Hermes conversation and tools.
The edits, stop-gate nudge, tests, coverage and CRAP scores are real.
The recording does not establish the behavior of an external model.
The original 43-second cut remains in `test-results/hermes/native-demo-v1.mp4`.
The earlier macOS-narrated cut remains in `test-results/hermes/native-demo-v2.mp4`.
The earlier Google-narrated full-window cut remains in `test-results/hermes/native-demo-google.mp4`.
Approve this disclosed take, or record a model-driven take with your own provider.

The plugin README contains native screenshots of our own fixture.
The full acceptance record is in [HERMES-HACKATHON.md](HERMES-HACKATHON.md).

## Source and service

The draft uses `https://github.com/tee-jagz/peekumi` and `subdir: integrations/hermes`.
This uses the catalog's monorepo support.
You can instead select a separate public repository.
That choice needs a new catalog URL and full SHA.

The Peekumi service changes must also be public and available to judges.
The existing public release does not supply the five new integration endpoints.
The source build and clean installation pass on macOS x86_64.
Do not claim tested Windows, Linux or ARM64 support from the parser pins alone.
The catalog draft limits the tested platform to macOS.

## Publication checklist for Tolu

1. Review the acceptance record, source diff, screenshots and video.
2. Select the plugin source location.
3. Publish the exact source commit and required Peekumi build.
4. Check that the catalog's full SHA can be cloned without private access.
5. Run `hermes plugins validate <plugin-path> --install-deps` at that SHA.
6. Open the one-file PR for `plugin-catalog/peekumi-risk-map.yaml` in `NousResearch/hermes-agent`.
7. Use the prepared PR description. Include the screenshots and execution disclosure.
8. Post the approved video on X with @NousResearch.
9. Send the catalog PR link and X post link to `http://form.typeform.com/to/FwJLvOln`.
10. Complete the form before 2026-11-11 at 17:00 EST (22:00 London).

The isolated source-installed Hermes runtime reports a managed-artifact sync warning.
Plugin validation still passes, including the security scan.
The source-built native Desktop scenario also passes.
Read that warning when you prepare a packaged Hermes install.
