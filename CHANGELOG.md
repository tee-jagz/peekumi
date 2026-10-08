# Changelog

This file records the changes in each release of Peekumi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Notifications

- Turn on notifications with the bell on the Tasks page. The phone then tells you when a task is ready for review or needs you. It also tells you when a session agent asks to run a command or waits for your message. This also works when the app is closed. Tap a notification to open the task or session.
- Peekumi sends notifications with Web Push. It encrypts each one for its device. It accepts only the push services of Apple, Google, Mozilla and Microsoft (`GET /api/push/key`, `POST` and `DELETE /api/push/subscribe`).

### Dependency rules

- Two new rule forms: `only` (a group may use only the listed groups, so a new folder is outside until you decide) and `layers` (a layer must not use a layer above it).
- The rule panel shows each rule's coverage (checked, broke, unresolved), warns about groups that match no file and rules that check nothing, and lists the breaks that a comparison adds.
- A task shows the rule breaks that it adds before Approve and in the merge sheet. Task agents get a `check_rules` tool to check their committed work before they report.
- **Forbid this dependency** on a relationship starts an instruction that asks for a rule against it.
- **Propose fixes**: Peekumi groups the rule breaks at a commit by rule and declaration. The Ask agent reads the code with these groups as context, and it proposes the fixes. Select, edit and clear fixes, then send them together to an agent as one task, or save them as drafts. Peekumi's groups are the fallback (`GET /api/fixes`, `POST /api/fixes/propose`).
- Agent commits have no `Co-Authored-By` line: Peekumi starts Claude Code with the setting that turns it off, and the task text asks every agent not to add one. The `Peekumi-Agent` trailer names the agent.
- Relations: the rule summary is a plain line, Propose fixes is the primary button, and a selection lists the rule breaks that start inside it.
- A card counts its rule breaks with a red broken-link icon, in place of the filled "!" badge. A selection that breaks a rule says which rule in one red line in the sheet, and the line opens only the breaks.
- Peekumi's own `.peekumi.json` states three principles: the analysis code does not use the agent workflow, shared frontend modules do not use feature modules, and product code does not use test code.

### Fixed

- The one-line installer downloads a public release without a token. Before, it got the file's description in place of the file, and the checksum check failed.

### Contributing

- `CONTRIBUTING.md`, and `docs/EXTENDING.md` with the steps to add a language adapter or an agent provider. Issue forms for both, and a pull request template.
- Contract tests for language adapters and agent providers. The app takes provider names and the "Commands" switch from the server's agent list, so a new provider needs no change in the app.
- Release notes come from this changelog. `npm run release -- X.Y.Z` prepares a release, and [RELEASING.md](RELEASING.md) gives the steps.
- One layout for all code (Prettier and rustfmt), `clippy` with warnings as errors, and a check of the writing rules in the documents. CI runs them with a secret scan and a vulnerability audit on each pull request, and a pull request merges only when CI passes.
- A code of conduct, a support page, GitHub Discussions, review by the maintainer for each pull request (CODEOWNERS), weekly dependency updates, and triage labels.
- `docs/EXTENDING.md` also covers tunnel providers, and `test/README.md` tells how to write a browser test.

## [0.2.0] - 2026-10-06

This is the first public release. Peekumi was called Repo Strata during its development, and the former `strata` command and `STRATA_*` settings still work.

Peekumi is licensed under the Apache License 2.0. The release archives include `LICENSE` and `NOTICE`.

### Map and inspection

- A mobile map of the real folders, files and declarations of a repository, with pan, pinch and zoom, and drill-down from the folder structure to one function.
- Coloured Git comparisons between two commits, a Time mode with commit cards, and read-only branch switching. The branch list shows the most recent branches first and has a filter.
- Time and Diff load older commits 80 at a time (**Earlier**), back to the root commit.
- Open and recently merged pull requests through the GitHub CLI, as merge-base comparisons. The sheet shows the state, title, description, checks and reviews of the pull request.
- Static relationships (imports, calls, implementations and inheritance) with committed dependency rules. Unresolved and ambiguous targets stay explicit.
- Dependency lines that do not cross cards and that run straight into their arrowheads. A folder with many lines shows its unchanged lines faintly until you select a card.
- The map opens with its cards above the floating controls, Fit and Follow use only the visible part, and a pan stops while cards are still in view. Long names wrap at their parts.
- Declaration details: inputs, outputs, fields, documentation and the changed parts of a declaration.
- Language adapters for Rust, Python, JavaScript, TypeScript and Svelte scripts. Peekumi labels all other tracked files.

### Ask

- Questions about the selection, answered by the Claude Code client on your computer, with the code, its callers and its dependencies.
- Read-only lookups and code search at the compared revisions, with names in the answer linked to the map.
- Answers in ASD-STE100 Simplified Technical English that stream while Claude writes them.
- One saved conversation for each branch.

### Instructions and agent tasks

- Instructions anchored to folders, files, declarations or dependencies, and an exact task preview.
- Tasks that Codex or Claude Code do in a separate worktree, with run-scoped reports and owner approval.
- Explore changes on the map, request changes as a next round that continues from the last commit of the agent, and collect changes while you explore.
- A Tasks button that shows a running task from every view.
- The back button steps back inside Peekumi (a menu, a view, the selection, a map level) before it leaves the app.
- A context menu: hold a map card or a name in a conversation (or right-click it) for Open, Ask about this, Add instruction, Point the agent here or Start a session here, Relations, Changes and Copy.
- Sessions: work live with an agent (Claude Code, Codex or OpenRouter) in its own worktree. Each message is a turn of one conversation. You see each step and its output, names in the conversation link to the map, you point at code on the map, and Claude Code asks you before commands outside its list, unless you allow all commands. Outside the session, a small Peek on the sheet shows that the agent works, one line says what it does now, and the map shows the agent's focus: its current place with Peek, a fading trail, dots on changed files, and Follow, which moves the map with the agent, centers its place, and pauses when you move it. Agent focus also works for tasks and for Ask answers. End a session to send its branch to the normal review and merge.
- The code graph in tasks: each task starts from a map of every folder, file and declaration name at the start commit. The agent opens a part with `highlight` (description, code, callers and calls) and follows the call paths with `route`, instead of only searching text.
- The code graph now resolves Rust calls on `self`, `Self`, typed parameters and struct fields, calls inside macros, Python calls on `self` and `cls`, Python imports inside a function, names that a package `__init__.py` imports again, and JavaScript calls on `this`.
- `route` lists every entry point that reaches a declaration, with its decorators (an HTTP route, for example), and it does not follow test callers unless asked.
- Claude Code gets the graph tools in its first prompt (`alwaysLoad`), for tasks and for Ask. Before, it often searched text and did not use the graph.
- The repository map has a limit of 12,000 characters. It folds whole folders, and it keeps the folders of the instructions open.
- When a report has no attribution trailers, the error names the missing trailers and shows what git found.
- OpenRouter: any OpenRouter model that can use tools answers questions (with Peekumi's read-only lookups) or does tasks (Peekumi's own task agent edits and commits in the worktree, with no shell). The key stays on the server.
- Agents: for Ask and for tasks, choose a provider (Claude Code, Codex or OpenRouter for tasks, Claude Code or OpenRouter for Ask), one of the models that the provider reports, and an effort that the model supports, or type any model name. The choice stays on the device, and each task keeps the choice that it started with.
- Merge an approved task into main from Peekumi, as a fast-forward after a confirmation, with Undo. Peekumi never pushes. When your uncommitted files are in the way, an agent writes the commit message for them and you check it. When main moved on, Update with main merges it, and an agent resolves a conflict as a new round.

### Setup and access

- Prebuilt archives for macOS and Linux (x64 and ARM64) and a one-line installer that verifies checksums.
- A background service, several repositories on one server, and `peekumi repo add` and `remove` without a restart.
- Private phone access through Tailscale Serve, and an explicit, temporary public option through a Cloudflare Quick Tunnel.
- Owner and read-only device pairing with revocation, and an installable PWA.

### Navigation

- One view stack (`frontend/nav.js`) decides what the sheet shows. A page opens over the view that you looked at, and the back arrow, the phone's back button and Escape all return to it.
- Conversations (Ask and open sessions) and Tasks (work only) are separate places in the header.
- The dock follows the view: its modes on the map, and a conversation's own box in a conversation.
- A small Peek and one word at the right of the sheet's title row lead to an agent at work or an open session, with no extra row.

### Safety and reliability

- Session commands: Peekumi alone checks each command. A session rule never covers a command with several parts (including a single `&`), a quoted, escaped or full-path program, or an option that starts another program (for example `go test -exec`). Shells, interpreters, `sudo` and other wrappers, network and container tools, package runners, `git push` and `git config` get no session rule.
- The credential files of common tools (`.npmrc`, `.netrc`, `.envrc`, AWS `credentials`, SSH keys, keystores, service-account files, cloud credentials, Docker and kube config, Terraform state and `.tfvars`) are restricted like `.env`: Source and Ask never show them.
- A file without readable source says why in Source and Details.
- Follow moves the map but keeps the owner's selection. A reload keeps the place on the map, Time mode and the commit. Back keeps the branch, and leaving an explored task brings back your place.
- A phone on its side has the desktop layout: the map at the left and the sheet at the right.
- Offline and an update show as quiet notes in the header's comparison row.
- A session message that arrives while a task runs waits for it. Stop does not start the next turn.
- Approve and Merge do not hide a flagged instruction: it keeps the task under Needs you, a merge makes it a draft again, and Undo merge brings it back. Merge sees your edited tracked files before it starts.
- A session shows a message that waits for the next turn. OpenRouter steps show when a tool failed.
- A read-only device shows no owner actions. Agent errors are short sentences without host paths.

### Brand and documentation

- Peek, an animated mascot with states for work, lookups, review and errors.
- A user guide with labelled screenshots. All documentation is in ASD-STE100 Simplified Technical English.
