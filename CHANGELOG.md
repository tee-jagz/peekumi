# Changelog

This file records the changes in each release of Peekumi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow [Semantic Versioning](https://semver.org/).

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
