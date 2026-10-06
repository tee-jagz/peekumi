# Instructions, runs and verification

When you examine a repository, you can collect feedback. You preview this feedback as one task, and then you send it to an agent in a separate worktree. The agent reports return to the instructions, and the owner reviews them. The interface calls these items instructions. The API, the MCP tools and the commit trailers keep the name `comment`. The map, the source viewer and the dependency evidence stay the surface where you examine the repository.

## Using the loop

1. Select a folder, file, declaration or dependency. Then select **Instruction**. If you select nothing, the instruction is for the current folder or repository. The map stays. Under Details, "1 instruction here" opens the instructions on that selection, and **Tasks** also shows them. A draft keeps its immutable Git SHA and anchor. Navigation does not move a draft to a different selection.
2. You can edit or delete drafts with no restriction. **Prepare run** selects the drafts and an optional brief. The task uses the agent, model and effort that you chose for tasks in **Agents** (**Change** opens that list). **Preview task** freezes them in the task, and every round of the task uses them. **Preview task** shows the exact task, the start SHA, the new branch and the committed dependency rules.
3. **Dispatch run** uses that saved preview, and a preview starts only one run. If the watched branch or a selected draft changed, make a new preview. If you dispatch the same preview again, Peekumi returns the original run. Each repository can have only one active run.
4. Monitor the progress in **Tasks**. Examine the agent output, the original task and the result commits. **Stop run** stops the agent process group. The maximum time for a run is one hour. Logs keep the first MiB, and Peekumi drains the output that follows.
5. **Explore changes** opens the agent branch on the map and compares it with the start commit of the run. Thus, the map colours each change that the agent made. **Back to task** restores the previous branch and base. Check results that the agent reports are evidence from the agent. These results do not come from an independent test execution by Peekumi.
6. **Approve** records your review of each addressed instruction against that exact commit, with an optional note (**Add note**). **Approve** does not merge, and it covers only the finished instructions. An instruction that the agent flagged, or did not finish ("Not done"), stays open: the task stays under **Needs you** and says so. The task then shows **Approved · ready to merge**. Until you merge, **Reopen review** takes the approval back, and you can still request changes. When all result commits are on the watched branch, the task shows **Merged into main** (or **Applied to main** if you merged it in a different way). An applied task is a closed record: it has no review actions, and **Follow up** starts a new instruction at the same place, for a new task.
7. **Merge into main** shows the commits and the changed files, and asks you to confirm. Peekumi then does a fast-forward of the watched branch to the last commit of the task. It never makes a merge commit on the watched branch, and it never pushes. If the watched branch is checked out in the folder that you examine, Git updates its files. If it is not checked out, only the branch moves. **Undo merge** moves the branch back while the branch and the merged files have no new changes. A merge closes the task: its flagged and unfinished instructions become drafts again, at their places, so you can send them in a new task or delete them. An **Update with main** round also keeps them open, on the latest round.

   Peekumi does not merge in these conditions:

   - **Your files are in the way.** You have uncommitted changes in files that the merge changes. Git refuses to overwrite them, and Peekumi names them first. **Commit my changes, then merge** opens a sheet with only those files. An agent writes the commit message, and you can edit it. When you tap **Commit**, Peekumi commits exactly those files on the watched branch. Your other uncommitted changes stay uncommitted. If the files change before you tap **Commit**, Peekumi refuses and asks you to check again.
   - **The watched branch has new commits.** **Update with main** merges the watched branch into the task branch. If there is no conflict, Peekumi makes the merge commit on the task branch and keeps your approval. If there is a conflict, a new round starts. In that round, the agent merges the watched branch, resolves the conflict and commits. Your approved instructions go back to review, because the code changed. **Explore changes** then shows the task on top of the new watched branch.
   - **The watched branch is checked out in a different folder.** Merge there, or check out a different branch in that folder.

   Write each change in the box at the bottom of the task, then tap ✓ to add it to the list of the task. The button below the list (for example **Send 2 changes to Codex**) starts the next round with the same agent. **Request changes** puts the cursor in the box. The next round has a new `peekumi/run-<id>` branch from the last commit of the previous round. Flagged and unreported instructions and the collected changes are the work of the next round. Instructions that the agent addressed in an earlier round go with the round as complete work: they keep their report and their commit, the task tells the agent not to report on them, and you approve them with the rest. The earlier report is in the history of each instruction and in the task. Peekumi marks the previous round as revised, and you can open it from the latest round. If you merge the latest round, you apply all the rounds.

   The API `reopen` action returns an instruction to Draft. This action stays for compatibility, but the interface does not show it now.

## State and reporting

An instruction moves through these states: Draft → With agent → Addressed / Flagged / Unreported. Only the owner can change Addressed to Verified. A process that stops never verifies an instruction. An instruction that has no answer becomes Unreported, also when the agent exits with success. Verification and the reopen action wait until the run ends.

Draft edits use version checks. These checks prevent a silent overwrite of the edits from a different open phone or browser. Each transition adds an audit event and keeps the previous text and report. The UI explicitly shows **current review status**, also when you look at an older commit. Anchors stay on their original revision. Revision-relative instruction state and rename continuity are not available yet.

The installed Peekumi binary is also a stdio MCP server. Each agent gets a credential that is limited to its active run, and it gets these tools:

| Tool | Arguments | Result |
|---|---|---|
| `get_run` | none | Frozen task, comment anchors and dependency rules |
| `resolve_comment` | `comment_id`, `commit_sha`, `note`, `checks` | Addressed, with commit and agent-reported check evidence |
| `flag_comment` | `comment_id`, `reason` | Flagged, with an explanation |

A resolution must refer to a new commit. This commit must be a descendant of the run base, and it must be reachable from the run branch. The commit must have these trailers: `Peekumi-Run: <id>`, `Peekumi-Comment: <comment id>` and `Peekumi-Agent: codex` or `claude`. Git reads trailers only from the last paragraph of the commit message. Thus, the trailers must be one block at the end, with no blank line in it. When a trailer is missing, the error names it and shows the trailers that git found. Peekumi rejects these items: commits without attribution, unrelated commits, comments from other runs and reports after completion. Verification does a second check that the reported commit is still on the run branch. When a run closes, Peekumi revokes its credentials. The owner API does not include these credentials, and Peekumi redacts them from captured output.

## Runtime and isolation

Peekumi gets the watched ref from the configured `--head`. When the server starts, the default `HEAD` resolves to the current symbolic branch. Each new preview resolves its latest commit, independently of the historical revision that you look at. If HEAD is detached and you want runs to follow a branch that moves, explicitly configure a branch.

Workflow data is in `<state-dir>/workflow.sqlite`, separate from the disposable syntax cache. Keep that state directory through all upgrades. Task files, bounded output logs and worktrees are under `<state-dir>/runs/<id>/`. Workflow state and its directory are private to the local user. Do not commit this state or the agent worktrees.

The name of each run branch is `peekumi/run-<id>`. When Peekumi creates these branches, it starts Git with hooks disabled. Peekumi changes the checkout that you examine only when you tap **Merge**, **Undo merge** or **Commit**, as step 7 tells. It also runs Git with hooks disabled for these actions. It never switches your checkout to a different branch, pushes, deletes branches or automatically removes run worktrees. Peekumi tells agents to stay in the worktree that it gives them. The worktree is Git isolation, not an operating-system security boundary. Installed agents run as the user of the service, and they keep their own sandbox/permission policy.

Peekumi starts Codex as `codex exec --sandbox workspace-write --approve-for-me`. It starts Claude Code with `claude -p --permission-mode acceptEdits`. Codex sends approval requests through its automatic reviewer. Peekumi explicitly gives Claude these tools: file, search, shell and the three Peekumi reporting tools. Peekumi excludes other MCP configurations. No adapter uses a blanket permission-bypass flag.

Use `--codex` / `PEEKUMI_CODEX` and `--claude` / `PEEKUMI_CLAUDE` to configure the installed executable paths. The service account must have the agent sign-in and all necessary tool permissions. If a failure occurs, the run shows it and does not claim success. Codex uses its documented [non-interactive interface](https://developers.openai.com/codex/noninteractive) and [stdio MCP configuration](https://developers.openai.com/codex/mcp).

A SQLite transaction holds the active-run slot. An OS lock in the Git common directory prevents a concurrent run of agents from two Peekumi instances on the same repository. A second server cannot open the same workflow state.

If the service exits unexpectedly, a recovered run becomes Interrupted. The run holds its slot until its recorded agent process exits. Then the run closes as failed, and Peekumi keeps its commits and reports. Recovery intentionally does not kill a PID, because it is possible that a different process uses that PID now.

If an interrupted process is still alive, stop it on the host through its original agent process/session. The recovered UI explains why it waits. If a different process uses the PID again, recovery can conservatively wait until that process exits.

Authenticated owner writes must use same-origin JSON. Untrusted repository text, task previews and agent output show as text. The phone session can dispatch runs. Thus, its access link gives more authority than access to view the repository. The scope limits of the agent protocol do not protect local files from a fully trusted process that runs as the same OS user.

## API

- `POST /api/ask`: `{base, head, sha, anchor, question, history, stream?}`. It returns an answer, an optional suggested instruction, the lookups that it made and the context omissions. `references` maps each code span in the answer to its place, `{kind, path, symbol?, line, side}`. This applies only to a span that names exactly one file (optionally `path:line`) or declaration. Peekumi does not include ambiguous and unknown spans. With `stream: true`, the reply is newline-delimited JSON events instead. The events are `text` pieces while Claude writes, `turn` when a new model turn starts, and `lookup` for each lookup. After a `turn` event, the earlier text was work, not the answer. The last event is `done` with the same body, or `error`. A declaration or file question includes static relationships (outgoing calls, imports, implementations and inheritance, and incoming references). It also includes the code of a maximum of four declarations that call the selection. A folder or repository question includes the directory README, its declarations and the diffs of changed files.
- `POST /mcp/ask`: the read-only lookup tools of Ask over Streamable HTTP MCP. It accepts only the random key of an answer that is in progress (refer to the text below).
- `GET /api/workflow`: comments, history, run summaries and watched ref.
- `POST /api/comments`: `{anchor, sha, text, forRun?}`. `forRun` marks the instruction for the next round of that finished task. Peekumi rejects it if the task was revised.
- `PATCH /api/comments/<id>`: `{action, version, text? , note?}`. The actions are `edit`, `delete`, `reopen`, `verify` and `unverify` (which takes an approved instruction back to review while its task is not applied). When a task is applied to main, `unverify`, `revise` and new instructions with `forRun` for that task are refused.
- `PUT /api/agents/openrouter-key`: `{key}`. It tests the key with OpenRouter, then saves it. `DELETE` on the same path removes it. Both return the same body as `GET /api/agents`.
- `GET /api/agents`: the providers, their jobs and status, the models of each job (each with `efforts` and `defaultEffort`), `source`, and the default choice for each job.
- `POST /api/runs/preview`: `{commentIds, brief, using?}`. `using` is `{agent, model, effort}`. An older client can send `agent` alone.
- `POST /api/runs`: `{previewId}`.
- `GET /api/runs/<id>`: progress, task, output and results.
- `POST /api/runs/<id>/cancel`: requests termination of the process group.
- `GET` / `PUT /api/ask/history?branch=<ref>`: the saved Ask conversation of one branch of the repository, `{messages}` (owner only; a maximum of 100 user or assistant messages). Without `branch`, the route uses the watched branch.
- `GET /api/runs/<id>/merge`: what a merge of the task does now. `state` is `ready`, `blocked` (uncommitted files in the way: `blocking`), `behind` (the watched branch has `behind` new commits), `elsewhere` (checked out in a different folder: `folder`), `merged` (with `undoable`), `applied` or `waiting`. It also returns `files`, `commits`, `targetSha` and `head`.
- `POST /api/runs/<id>/merge`: `{target, head}`, the two commits that the owner confirmed. It does a fast-forward of the watched branch. If either commit changed, Peekumi refuses.
- `POST /api/runs/<id>/unmerge`: moves the watched branch back to its commit before the merge.
- `POST /api/runs/<id>/update`: merges the watched branch into the task branch. It returns `{merged}` with the new merge state, or `{round}` when a conflict starts a new round.
- `POST /api/runs/<id>/commit-draft`: the blocking files, the checked-out commit, a hash of the changes and a commit message from the agent.
- `POST /api/runs/<id>/commit-mine`: `{message, head, hash}`. It commits exactly the blocking files.
- `POST /api/runs/session`: `{text, sha, anchor, using?}`. It starts a session with the owner's first message, and returns the session (a run with `kind: "session"`). Peekumi rejects it while an agent runs.
- `POST /api/runs/<id>/message`: `{text, anchors?}`. It adds the owner's message to a session. A waiting session starts its next turn. A running session keeps the message for the next turn (`queued: true`).
- `POST /api/runs/<id>/approval`: `{approval, decision, message?}`. It answers the agent's request to run a command. `decision` is `allow`, `session` (allow, and allow the same command for the rest of the session), `all` (allow every command from now on) or `deny`.
- `POST /api/runs/session` also takes `permissions`: `ask` (the default) or `allow`.
- `POST /api/runs/<id>/permissions`: `{mode}`, `ask` or `allow`. It changes how an open session treats commands.
- `GET /api/runs/<id>/tail`: a session with only the last 16 KB of its log.
- `GET /api/runs/<id>` and `GET /api/runs/<id>/tail` of a session also return `changed`: the files that the session changed since its start commit, committed or not, and its new files.
- `POST /api/references`: `{base, head, text, about?}`. It returns `references`, the place of each code span in `text` that names exactly one file or declaration in the comparison, in the same form as Ask's `references`. A dotted name such as `Workflow.route` names a method by its type.
- `POST /api/runs/<id>/end`: `{review}`. It ends a waiting session. With `review: true`, the session's instruction gets a report with the last commit of the branch, and it goes to the normal review.
- `POST /api/runs/<id>/revise`: `{feedback?}` (necessary if no instructions were collected for the task). It starts the next round of a finished run that is not yet revised, and returns that round (`round`, `revises`, `feedback`). Peekumi rejects the request while a run is active or when nothing remains to change.

The viewer polls every three seconds while an agent works, and every ten seconds otherwise, so a run started from a different device also shows. Peekumi does not have SSE. The usual comparison/source APIs can get completed work by commit SHA. They do not change the checkout that you examine.

## Validation and remaining boundaries

The deterministic integration agent makes real Git commits and reports through the production MCP transport. The tests cover exact preview delivery, stale drafts and refs, duplicate dispatch, concurrency, invalid attribution and unrelated comments. They also cover flags, unanswered comments, verification, reopen, follow-up rounds, persistence, cancellation and missing executables. The browser tests complete the loop on phone and desktop. These tests do not show a paid Codex or Claude session. For a first real run, local agent authentication and permissions are still necessary.

These items are outside this slice: automatic brief generation, automatic dependency-rule creation from comments, commit-timeline attribution badges, historical comment-state projection, SSE, merges without an owner action, and push. Each task includes the dependency rules. Owners can use a draft to explicitly ask the agent to propose changes to `.peekumi.json`.

## Sessions

A **Session** is a live conversation with an agent. Use it when you want to work together with the agent, step by step, and not only send a finished instruction. The agent reads and changes code, runs checks and commits, in its own worktree and on its own branch. You read each step and reply between its turns.

**Start a session.** Select a part of the map, choose **Session** in the dock, and write what you want to work on. The selection becomes the anchor of the session. A session uses the agent, model and effort that you chose for tasks in **Agents**.

**Turns.** Each message that you send starts one agent turn. The turn continues the same agent conversation in the same worktree: Claude Code continues its session ID, Codex continues its thread, and Peekumi's own OpenRouter agent gets its saved messages again. If you send a message while a turn runs, the message waits and starts the next turn. To stop a turn, use **Stop**. The session then waits for your next message, and a message that waited goes with it. Stop does not start a turn. Between turns, the session does not hold the repository, so a task can run. If you send a message while a task runs, the session keeps the message and shows that it waits. The turn starts by itself when the task ends.

**Names are links.** In the conversation, a name in backticks that names one file or declaration is a link, as in Ask. Examples are `backend/main.rs:953`, `has_grant` and `Workflow.route`. Tap it, and the map moves there and puts it in the middle, while the session stays on screen. A session opens at its latest message. Its header stays above the conversation while you scroll: the title, the state (**Working**, **Your turn** or **Needs you**) and the stop button (a small square) while the agent works. Under the conversation, one line gives the agent, turns, commits and cost, and links show the changes on the map, change how the session treats commands, and end the session.

**Point at code.** While the session is on screen, its dock is the reply box. Select a part of the map, and the session stays on screen: the next message includes that part, for example `(About: lookup.rs · route)`. On the map, the dock's Session mode also replies to the open session.

**Commands.** A session agent can run Git on its branch and the usual test commands with no question: `npm test`, `npm run test…`, `cargo test`, `cargo check`, `pytest`, `go test` and `node --test`. For Claude Code, every other command waits for you. Peekumi alone decides which commands run without a question: no command rule goes to Claude Code. The request shows the command and the reason. Write an optional note for the agent, then choose **Allow once**, **Allow … in this session**, **Allow all commands** or **Deny**. After 15 minutes with no answer, the agent continues without the command.

**Allow … in this session** allows the same program and subcommand again, for example `npm install` or `cargo build`. Some commands get no session rule, because one rule would allow too much. Allow them once, or allow all commands:

- A command with several parts or a redirect: `;`, `&`, `&&`, `|`, `||`, `$(…)`, backticks, `>` or `<`.
- A program written with quotes, a backslash or a path, for example `'bash'`, `\sudo` or `/usr/bin/git`. Such a name can hide what runs.
- A command that starts with `NAME=value`.
- A shell, an interpreter or a wrapper that runs other commands: for example `bash`, `sh`, `sudo`, `env`, `xargs`, `find`, `node`, `perl`, `ruby` or `ssh`.
- A package runner, a container or a network tool: for example `npx`, `npm exec`, `uv run`, `docker`, `curl` or `rsync`.
- A program that takes a subcommand, with an option first: for example `git -C x push` or `python3 -c …`.
- `git push` (Peekumi never pushes) and `git config` (it could make a listed `git commit` run hooks).

Some options make an allowed program start another program, load code, or read or write outside the worktree: for example `go test -exec`, `npm test --script-shell`, `node --test --import`, `cargo test --config`, `pytest -p`, `git log --output` and `git diff --no-index`. A command with one of them always waits for you, also when the program is on the session's list or has a rule. The listed test commands still run the project's own tests, which the agent can change: "ask first" stops other commands, but it is not a sandbox.

**Allow all commands.** In this mode, no command waits for you. Set it before you start with the shield next to **Start session** (amber means all commands are allowed; the device keeps your choice), or change it at any time with **Commands: ask first** under the conversation. The shield and the link show only when sessions use Claude Code: Codex runs with its own preset, and OpenRouter runs no commands. **Allow all commands** on a request also sets it. The next turn starts the agent in the new mode, and a request that waits is allowed at once.

**While you look elsewhere.** When a session is open and its view is not on screen, a small Peek and one word show at the right of the sheet's title row, on every sheet height: **Working**, **Needs you** or **Your turn**. They take no row of their own and never cover the selection's description. Tap them to open the session. Their accessible name says what the agent does now, for example "Working: Ran `cargo test`". A task at work shows in the same place. Conversations lists every open session.

**Agent focus.** The map shows where the agent looks. This works for a session, for a task while its agent works, and for an Ask answer while it reads the code (its lookups). One shows at a time: an agent at work first, else the latest. After an Ask answer, its trail stays until the next question. Peekumi finds the place from every step: a file that the agent reads or changes, a folder that it searches, a file path in a command (for example `sed -n 1,40p backend/lookup.rs`), and a file and declaration in a map lookup (for example `read_declaration route`).

- **Now:** while the agent works, the card of its current place glows, and a small Peek works on it. Inside a file, the declaration card glows. When the place is not on screen, the folder card that holds it glows.
- **Trail:** the four places before the current one keep an outline that fades with age.
- **Changed:** a file that the session changed, or a folder that holds one, has an amber dot. The dots stay for the whole session. The server finds these files with Git, so they include changes from commands and uncommitted changes.
- **Follow:** the eye button at the top right of the map moves the map to the agent's current place, and puts its card in the middle of the map. It moves to another level of the map at most once every three seconds. When you move the map or select a card yourself, Follow pauses, and the eye shows a line through it. Tap the eye to follow again. Tap it while it follows to turn it off. The device keeps that choice.
- **Your turn:** when the agent waits, the "now" mark goes, and the trail and the dots stay.
- **Legend:** while an agent's marks show (a session, a task at work, or Ask), the map's legend starts with **Agent**, which explains the three marks. The eye button hides while the legend is open.

A place that Follow showed is not a pointer. Follow moves the map, but it never changes your selection: the dock keeps the part that you chose for Ask, an instruction or the next reply, until you select, move the map or change the comparison yourself.

**End a session.** **End session** shows the commits on the branch. **Send to review** reports the session's instruction with the last commit, and the work then goes through the normal review: **Approve**, then **Merge** with **Undo**. The conversation stays with the work, under **Session conversation**. **End without review** keeps the branch, and the instruction stays unreported. The session then says that you ended it, and that nothing was merged.

Peekumi never pushes a session branch and never changes your checkout. A turn has a time limit of one hour.

## The context menu

Hold a card on the map, or a name in a conversation, for half a second on a phone. On a desktop, right-click it, or press the context-menu key or Shift+F10 on a focused card. A small menu opens next to it, and the rest of the map dims. The menu shows only the actions that fit:

- **Open** (a folder or file) or **Source** (a declaration).
- **Ask about this** and **Add instruction**: the dock switches to that mode, about this part.
- **Point the agent here** while a session is open: your next reply carries this part. Without a session: **Start a session here**.
- **Relations** with their number, and **Changes** when the part changed.
- **Copy path** or **Copy name**.
- For a name in a conversation: **Show on the map**, and **Reply about this** in a session.

On a desktop, keys run the actions: Enter opens, A asks, I adds an instruction, S points the agent or starts a session, R replies about a name and C copies. Arrow keys move in the menu, and Escape closes it. A finger that moves before the half second pans the map and opens no menu. The menu has no action that deletes or changes anything.

## The back button

The phone's back button, the browser's back, Escape and the back arrow of a page all do the same thing: they go back to the view before. Peekumi keeps one stack of views (`frontend/nav.js`). The map's own views (Details, Source, Changes and Relations) are its base. A page opens on top of the view that you looked at: Conversations, Ask, a session, Tasks, History, the task form, a task, or the instructions on a selection. Exploring a task's branch on the map is a view too, and going back from it returns the map to the branch and base that it left.

Each press undoes one layer, the most recent first: an open menu, popover or dialog; the view on top; another aspect of the map (back to Details); the selection; and then one level up on the map. When nothing is left, back leaves Peekumi as usual. A list or a task gives way to the map when you select a card (Back returns to it); a conversation stays on screen, and the card becomes the subject of its next message.

## Ask versus Instruction

**Ask** and **Instruction** stay visible at the bottom edge. They are outside the review content that scrolls, which includes source, diffs, dependencies and run results. The question or draft input stays directly below the mode switch, and its anchor and revision are visible. The two modes use the selected item or the current folder/repository scope. If you reopen an unfinished instruction, it keeps its original anchor and text.

To get direct Details, Source, Changes and Relations views, drag the sheet up. Commit mini cards show above the graph only in Time mode. Diff uses base/head selectors. A question opens the Ask page, where the dock is the question box; **Conversations** opens it again later. **Tasks** contains each draft, preparation and progress.

Ask is a contextual conversation that uses the installed, signed-in Claude Code client. All built-in tools, skills and other MCP servers are disabled for Ask. Ask makes no provider call until the owner sends a question. Source and comparison context, static relationships, committed rules and scoped instructions have limits. Ask tells you about all omissions.

Ask runs Claude Code. Choose its model and effort in **Agents**. Without a choice on the device, Ask uses the server defaults: Sonnet at low effort. To change these defaults, set `--ask-model` or `PEEKUMI_ASK_MODEL` and `--ask-effort` or `PEEKUMI_ASK_EFFORT`. The interface streams each answer while Claude writes it.

## Agents

**Agents** has one row for each job: **Ask** answers questions, and **Tasks** change code. Open it from the chip next to the composer, which shows what the current mode uses, or from the **Agents** icon in the Tasks header. For each job, select a provider, then one of its models, then an effort:

- **Provider:** for Ask, Claude Code or OpenRouter. For tasks, Claude Code, Codex or OpenRouter. A provider that is not ready is grey and shows the reason, for example "Not signed in. Run codex login on your computer".
- **Model:** **Default** (the model that the provider uses on its own), the models that the provider reports, or **Other model**, which accepts any model name.
- **Effort:** **Auto** and the levels of the selected model. Auto lets the provider decide.

Peekumi does not keep its own list of models. Each provider gives them: Codex lists its models, with the effort levels and the default effort of each, in `codex debug models`. Claude Code names its model aliases and effort levels in `claude --help`. OpenRouter lists its models in its public API; Peekumi shows only the models that can use tools, with their context size and price, and reasoning models get Low, Medium and High. The server keeps these lists for ten minutes. If a provider gives no list, the server uses a short built-in list and marks it `source: "built-in"`.

The app keeps the choice on the device, for each repository. It sends the choice with each Ask question, task preview and commit message request as `using: {agent, model, effort}`. The server checks the choice: the provider must exist and be able to do the job, the model name can contain only letters, digits and `._:/@-[]`, and the effort must be one lowercase word. The provider checks the model and the effort when it starts.

### Why Ask has fewer providers than tasks

Ask must only read the repository at the compared revisions. It must not run code or read files that are not committed. Thus Ask uses only a provider whose tools Peekumi controls:

- **Claude Code** runs with every built-in tool off. Its only tools are Peekumi's read-only lookups.
- **OpenRouter** is an API. The model has no tools of its own, and Peekumi runs each lookup that the model asks for.
- **Codex** always has a shell. Even in its read-only sandbox, it can run commands and read uncommitted files. Thus Codex does tasks, but it does not answer questions.

Through OpenRouter, Ask can use models from many providers, for example OpenAI, Google and Anthropic.

### The code graph in tasks

A task reads code through Peekumi's code graph of its start commit. This is the same graph that Ask uses.

**The map in the task text.** Each task text has the section "Repository map". The map shows every folder, file and declaration name at the start commit. It shows only names. It does not show descriptions or code. The agent reads the map first. Then it opens only the parts that it needs.

The map has a size limit of 12,000 characters (about 3,000 tokens). A larger map costs more than it saves. When a repository does not fit, Peekumi folds parts of the tree into one line each. A part is a whole folder with its subfolders, for example "`frontend/` (folded: 389 files, 4406 declarations; …)", or only the files of one folder. Peekumi does not fold the folders of the files that the instructions are about. A folded folder opens with `highlight`, and a large folder in `highlight` folds in the same way.

**The tools.** Each task gets the graph as tools:

- `highlight` opens one part of the map. For a folder, it gives the tree and the folder description. For a file, it gives each declaration with its signature, its description and what uses it. For a declaration, it gives the signature, the description, the code, the calls that the graph resolved, and each caller with the calling line.
- `route` shows how code connects in one call. It finds what reaches a declaration, back to the entry points. It lists each entry point with its decorators or attributes, for example `@router.post("/{run_id}/continue")`. Thus, one call shows which HTTP routes or scheduled jobs reach a function. It also finds the paths from one declaration to another. It gives at most 20 paths. With `lines`, it gives the calling line of each step, after the conditions that hold it, for example `if path == "/api/ask" {`. It does not follow callers in test files, unless the agent sets `tests`. It tells how many test callers it did not follow.
- `highlight` and `route` accept a short name, for example `choice` for `Workflow.choice`, when only one declaration in the file has that name. Otherwise they give an error with the names to choose from.
- `find_declarations` finds a function, method, class or type by name.
- `read_declaration`, `relationships`, `search_code` and `read_file` read the same commit.

The task text tells the agent to use the map and these tools before it searches text. When the task starts, Peekumi opens a lookup grant for that task only, with its own key and a limit of 300 calls. The grant closes when the task ends. Claude Code and Codex reach the graph as the MCP server `peekumi_graph` on the Peekumi listener. For Claude Code, Peekumi sets `alwaysLoad` on its MCP servers, for tasks and for Ask. Thus, the tools are in the first prompt. Without it, Claude Code shows only the tool names until the agent loads them, and the agent often searches text first. Codex reads the key from the `PEEKUMI_GRAPH_TOKEN` environment variable. The OpenRouter task agent calls the same endpoint with `highlight`, `route` and `find_declarations`. The graph shows the start commit, not the changes of the agent. `PEEKUMI_TASK_GRAPH` on the server selects the form: not set or `1` gives the map and the tools, `tools` gives only the tools, and `0` gives no graph.

**What the graph resolves.** The graph records static calls, not runtime calls. In Rust, it resolves calls on `self`, `Self::name`, `Type::name`, parameters with a written type, struct fields with a written type, and calls inside macros such as `json!` and `format!`. A call on a `dyn Trait` value goes to each implementation of that trait. In Python, it resolves calls on `self` and `cls`, and calls through an import inside the function. When a package `__init__.py` imports a name again, the graph follows that import to the declaration. In JavaScript and TypeScript, it resolves calls on `this` in a class. Other calls stay unresolved. Calls into libraries also stay unresolved.

### Tasks with OpenRouter

OpenRouter is a provider on its own, and it does not need a different program. For an OpenRouter task, Peekumi runs its own task agent (`backend/task_agent.rs`). The agent sends the task to the model with a fixed set of tools, and it runs each tool in the worktree of the task:

- `list_files`, `read_file` and `search` read the worktree.
- `write_file`, `edit_file` and `delete_file` change files.
- `commit` commits all changes, with the `Peekumi-Run`, `Peekumi-Comment` and `Peekumi-Agent: openrouter` trailers.
- `resolve_comment` and `flag_comment` report each instruction, with the same checks as the MCP reporting tools.
- `finish` ends the task.

No tool runs commands, because Peekumi has no sandbox for commands. Thus the agent cannot run builds or tests, and it says so in its reports. A path must be in the worktree: Peekumi refuses an absolute path, `..`, the `.git` folder and a write through a symbolic link. The task view shows the progress of the agent, and **Stop task** and the one-hour limit work as for the other agents.

### The OpenRouter key

Choose OpenRouter in the Ask list, paste your API key and tap **Test and save**. The server tests the key with OpenRouter. Then it keeps the key in the file `openrouter-key` in its state folder, which only your user account can read. The app shows only the last 4 characters of the key, with **Replace** and **Remove**. You can also set `PEEKUMI_OPENROUTER_KEY` on the host. Peekumi sends requests through `curl`, and the key goes to `curl` on its standard input, never as an argument. `PEEKUMI_OPENROUTER_URL` changes the API address (the tests use this).

When Ask uses OpenRouter, it sends the question, the context and the result of each lookup to OpenRouter. OpenRouter sends them to the provider of the model.

The server module `backend/agents.rs` defines each provider behind one interface (`Agent`): its jobs, how it finds its models, its status check and the command that starts it for a task. Claude Code and Codex are the two agents now. To add an agent, implement this interface and add the agent to the registry. The app gets its lists from `GET /api/agents`.

While an answer runs, Claude can call seven read-only lookups that Peekumi itself serves: `find_declarations`, `search_code`, `read_declaration`, `read_file`, `relationships`, `highlight` and `route`. `search_code` finds exact text and gives the name of the declaration that contains each match. Thus, it finds references that the static analysis does not find, for example calls on values with no written type. Each lookup reads committed code at the two compared revisions through the repository worker. No lookup runs code, writes state or gets access to a different repository.

When the answer starts, Peekumi opens a lookup grant with a random key. When the answer ends, with success or failure, Peekumi closes the grant. The key operates only on `/mcp/ask`, and `/mcp/ask` does not accept the owner token. Before Ask answers, it must use the lookups to check each fact that its answer depends on. If a draft answer says that it did not check a fact in the repository, or asks you to confirm one, Peekumi sends the draft back one time. Ask then checks those facts and writes the final answer, which replaces the draft on the screen. Only runtime behaviour and test results can stay unchecked. An answer can make a maximum of 30 lookups, and each result has a size limit. The answer gives a list of the lookups that it made. Each provider call times out after 240 seconds.

Each branch of a repository has its own Ask conversation in the private state folder on the host (`ask-history/`, the latest 60 messages for each branch). A conversation that Peekumi saved before this change belongs to the watched branch. When the view changes to a different branch, Ask shows the conversation of that branch. An answer that is not complete when the view changes goes into the conversation where you asked the question. Thus, the conversation is available again after a page reload, an app update or a change to a different owner device. Read-only devices cannot read it. One conversation runs for the session, and it stays in view when the map moves. Each question is about the selection at the time that you sent it. When the subject changes, Peekumi marks the question with that subject.

Claude gets each question with the earlier questions, and each earlier question has a label with its subject. Answers stream in while Claude writes them. A lookup shows while it occurs. An answer can propose an instruction, but only **Save as draft instruction** saves it. The saved instruction is anchored to the selection and viewed revision of the original question.

When you explore a task that can still accept changes, the suggestion and the Instruction box show **Add to requested changes** instead. Each of these saves an instruction that is anchored to the agent commit and marked for that task (`forRun`). Then you can continue to explore. These instructions never join an ordinary task preview. The button below the list of the task sends them as the next round, together with the open instructions of the task. A separate note is not necessary.

Ask cannot verify instructions or start runs. Pinned answers and automatic brief generation are still deferred.
