# Peekumi Risk Map

See the code that Hermes changes on a dependency map with measured Python CRAP scores.
The gate checks changes against the rules at the pre-edit baseline.
Every result names its source revision and coverage run.
Unknown coverage stays grey.

**Peekumi is a required dependency.**
Run the Peekumi service on the same computer, or configure an HTTPS service URL.
The plugin connects Hermes to that service. It does not include the analysis engine.
The Peekumi browser app does not need to stay open.
Python risk measurement also needs the pinned crapper and coverage tools described below.

The package adds two tools, four hooks, one skill and a right-side Desktop pane.
Peekumi supplies the analysis. The plugin supplies the Hermes connection and gate.
It does not patch Hermes or embed the Peekumi page.

## Prepare a local demo

Install Hermes 0.21.6 or later and Peekumi with the integration API first.
Use Python 3.14 for the pinned analysis-tool installer.
Run these commands from this plugin folder:

```sh
python3.14 setup_crapper.py --prefix "$HOME/.local/share/peekumi-crapper"
bash demo/setup.sh "$HOME/peekumi-risk-demo"
hermes desktop
```

The setup command prints the profile secret and plugin settings.
Save them in the active Hermes profile before you start the demo session.
Set the printed CRAP environment values on the process that starts Peekumi.
The coverage commands use the new analysis environment.
The setup script refuses to overwrite an existing demo folder or token name.
It creates a local fixture repository. It does not create a remote repository or push.

For a local source install, copy this folder to `$HERMES_HOME/plugins/peekumi-risk-map`.
Use `~/.hermes` when `HERMES_HOME` is not set.
Then run `hermes plugins enable peekumi-risk-map`.
Keep the `desktop/`, `dashboard/` and `skills/` folders with the Python files.
The Desktop app loads the pane from this one package.
Select the demo folder as the Desktop project directory before you start a new session.
Open the right sidebar to show Risk Map.

The Peekumi service must include this branch's integration endpoints.
The current public Peekumi release does not include them yet.
For a source build, use `npm ci` and `npm run build:rust` at the Peekumi repository root.
Use `node scripts/manage.mjs` in place of `peekumi` until you install that build.
The service environment needs all three values from `peekumi-crapper.json`.

## Use the tools

Call `peekumi_impact(path_or_symbol)` before an edit.
It shows changed files and declarations, dependents, frozen rules and limits.
Call `peekumi_measure()` after an edit or a test change.
It runs the configured coverage and export commands in a new private snapshot copy.
Do not run a coverage command by hand for this integration.

When a finding must stay, call `peekumi_impact` with its `finding_id` and a specific `reason`.
The API records an exception. It keeps the finding and its reason visible.
An explanation cannot clear a finding.
New valid evidence must show that the problem is fixed.

The gate can nudge Hermes after code edits.
At the configured nudge cap, the final observer refreshes the evidence.
If findings remain, the pane shows `exhausted` and says that the agent stopped.
Shell-only edits can skip `pre_verify`. The final observer still refreshes them.
A service outage fails open with a visible `unavailable` state.

## Read the pane

The map uses real folders, files and declarations.
Changed nodes have an outline. Red dashed edges mark rule breaks.
Select a declaration for complexity, coverage and CRAP before and after.
Each measured score has its source SHA, run ID and report hash.
Select the rule marker for the rule and exact import line.
TypeScript and Rust remain on the graph with a CRAP-not-available label.
Unresolved dependencies remain labelled.
Large maps state their aggregation limits.

| Outcome | Meaning |
| --- | --- |
| `passed` | All required checks ran with no open findings |
| `findings` | A rule change, new rule break or high measured CRAP remains |
| `exception` | Findings remain with recorded reasons |
| `incomplete` | A required check or coverage measurement is unknown |
| `unavailable` | Peekumi or the configured analyzer could not supply evidence |
| `exhausted` | The agent stopped after the nudge cap with findings open |

## Settings

| Setting | Default |
| --- | --- |
| `PEEKUMI_URL` or `peekumi_url` | `http://127.0.0.1:4317` |
| `PEEKUMI_TOKEN` | Required profile secret |
| `repository_id` | Required registered repository ID |
| `repository_path` | Required absolute checkout path |
| `crap_threshold` | `30` |
| `gate_mode` | `nudge`; use `off` to observe without nudges |
| `coverage_command` | `["coverage", "run", "-m", "pytest"]` |
| `report_command` | `["coverage", "lcov", "-o", "lcov.info"]` |

Commands are argument arrays. The plugin does not invoke a shell.
The report command must create a fresh `lcov.info` in the private copy.
Both commands must succeed before coverage can be accepted.
The source SHA stays fixed while tests run, even if the checkout changes.
Failed evidence stays unknown.
A coverage-only rerun can clear risk without changing the source tree.

## Access and execution

The plugin reads profile secrets with `agent.secret_scope.get_secret`.
It never reads credential files and never sends the token to the renderer.
Its runtime network calls go only to the configured Peekumi service.
Remote service URLs require HTTPS. Redirects are refused.
The service token permits five integration routes for one repository.
It cannot access general Source, Ask, workflow or repository-management routes.

`peekumi_measure` executes the configured test and report commands in a new private folder.
These commands execute repository tests. This is not a sandbox for hostile code.
The normal test caches and bytecode cannot write in the user's checkout.
The exported snapshot excludes restricted files, links, submodules and old measurement data.
The report belongs to a one-use source export receipt.
The measurement client attests fresh-folder provenance and command exit codes.
This is not cryptographic proof of arbitrary test execution.
Accepted reports and metrics remain in Peekumi private state.
The client deletes its copy after the server records evidence.
It retains the copy when submission fails.

Peekumi runs pinned crapper 0.1.0 against a separate private source copy with existing coverage.
It never runs tests itself.
The explicit `setup_crapper.py` command downloads pinned source and a parser archive from GitHub.
It verifies their committed SHA-256 checksums before use.
It installs pinned Python dependencies from PyPI.
Runtime analysis refuses parser downloads.
The installer includes pins for macOS, Linux and Windows on x86_64 and ARM64.
The current clean-install check uses macOS x86_64.

Active baselines hold the private object store against cleanup.
The 1 GiB cleanup threshold is a soft limit while a baseline is active.
Pins end with the session or after 24 hours without use.

## Validate

```sh
hermes plugins validate /path/to/peekumi-risk-map --install-deps
```

The manifest declares the two tools, four hooks and no privileged capabilities.
The pane imports only `react` and `@hermes/plugin-sdk`.
All drawing code is bundled in `desktop/plugin.js`.
The fixture tests use real coverage and CRAP measurements.

The clean check starts from a new analyzer prefix, private Peekumi registry and Hermes profile.
It runs the documented demo setup, enables the plugin and validates the copied package.
Validation passes, including the security scan and Desktop surface check.
The source-installed Hermes runtime can report an unrelated managed-artifact sync warning.
It does not fail plugin validation. The built native Desktop test also passes.

## Native Desktop evidence

These screenshots use our small shop fixture in native Hermes Desktop.
The local provider is scripted. No external model account is used.
Hermes runs the real edit tools, private coverage tool and stop gate.
The first measurement is complexity 6, coverage 0% and CRAP 42.
The repair removes the forbidden import and adds tests.
The second measurement is complexity 6, coverage 100% and CRAP 6.

![Native pane with measured CRAP 42 and two findings](docs/findings.png)

![Selected frozen rule and exact import line](docs/rule.png)

![Native pane after repair with passed evidence and CRAP 6](docs/passed.png)

![Unsupported TypeScript stays labelled](docs/unsupported.png)

The local review MP4 is under 90 seconds and has a scripted-provider label throughout.
It needs the owner's approval before publication.
The test commands and acceptance record are in Peekumi's `test/hermes/README.md` and `docs/HERMES-HACKATHON.md`.

Crapper source: [unclebob/crapper](https://github.com/unclebob/crapper/tree/6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d), 0BSD.
This plugin uses the [Peekumi Apache-2.0 license](LICENSE).
