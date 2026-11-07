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

The current review video is `test-results/hermes/release-google/peekumi-remotion.mp4`.
It stays below the 90-second limit.
The story starts with the user's repository overview and focused review.
It shows file-to-function inspection, specific findings and a verified agent repair.
The voice is Charon. Only the narration text goes to Google.
Google TTS produces review audio. It is not a plugin runtime dependency.
The graph has the main pane width. The diff supports the graph.
The edit uses continuous native video of the real Hermes turn at its original speed.
Remotion renders camera and cursor motion at 60 frames per second.
HyperFrames renders the short identity overlay. FFmpeg encodes the delivery file.
The yt-dlp importer verifies a loopback transfer of our own footage.
The existing Google audio stays unchanged. Whisper is not used.
It shows actual edits, tool updates, cursor actions and evidence selections.
Smooth camera moves follow the graph, rule evidence and supporting diff.
The caption states that time, camera and cursor annotations are edited.
The narration uses Google Charon and describes user benefits.
The edited video copies that narration unchanged. Its packet hash is checked.
Setup documents the required Peekumi service.
The video has no language-support segment. It makes no future-support claim.
A visible caption identifies the scripted local provider throughout.
The provider drives the actual Hermes conversation and tools.
The edits, stop-gate nudge, tests, coverage and CRAP scores are real.
The recording does not establish the behavior of an external model.
The original 43-second cut remains in `test-results/hermes/native-demo-v1.mp4`.
The earlier macOS-narrated cut remains in `test-results/hermes/native-demo-v2.mp4`.
The earlier Google-narrated full-window cut remains in `test-results/hermes/native-demo-google.mp4`.
The static close-up cut remains in `test-results/hermes/native-demo-focused.mp4`.
The earlier technical motion cut remains in `test-results/hermes/native-demo-motion.mp4`.
The first benefit cut remains in `test-results/hermes/native-demo-benefits.mp4`.
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
