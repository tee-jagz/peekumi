# Instructions, runs and verification

When you examine a repository, you can collect feedback. You preview this feedback as one task, and then you send it to an agent in a separate worktree. The agent reports return to the instructions, and the owner reviews them. The interface calls these items instructions. The API, the MCP tools and the commit trailers keep the name `comment`. The map, the source viewer and the dependency evidence stay the surface where you examine the repository.

## Using the loop

1. Select a folder, file, declaration or dependency. Then select **Instruction**. If you select nothing, the instruction is for the current folder or repository. **Discussion** shows the saved drafts for that selection, and **Tasks** also shows them. A draft keeps its immutable Git SHA and anchor. Navigation does not move a draft to a different selection.
2. You can edit or delete drafts with no restriction. **Prepare run** selects the drafts, Codex or Claude Code, and an optional brief. **Preview task** shows the exact task, the start SHA, the new branch and the committed dependency rules.
3. **Dispatch run** uses that saved preview, and a preview starts only one run. If the watched branch or a selected draft changed, make a new preview. If you dispatch the same preview again, Peekumi returns the original run. Each repository can have only one active run.
4. Monitor the progress in **Tasks**. Examine the agent output, the original task and the result commits. **Stop run** stops the agent process group. The maximum time for a run is one hour. Logs keep the first MiB, and Peekumi drains the output that follows.
5. **Explore changes** opens the agent branch on the map and compares it with the start commit of the run. Thus, the map colours each change that the agent made. **Back to task** restores the previous branch and base. Check results that the agent reports are evidence from the agent. These results do not come from an independent test execution by Peekumi.
6. **Approve** records your review of each addressed instruction against that exact commit, with an optional note (**Add note**). **Approve** does not merge. The task then shows the branch and the exact `git merge --ff-only peekumi/run-<id>` command, with a copy button. You run this command yourself. When all result commits are on the watched branch, the task shows **Applied to main**.

   Write each change in the box at the bottom of the task, then tap ✓ to add it to the list of the task. The button below the list (for example **Send 2 changes to Codex**) starts the next round with the same agent. **Request changes** puts the cursor in the box. The next round has a new `peekumi/run-<id>` branch from the last commit of the previous round. It carries each instruction that is not yet approved (addressed, flagged or unreported). The earlier report is in the history of each instruction and in the task. Peekumi marks the previous round as revised, and you can open it from the latest round. If you merge the latest round, you apply all the rounds.

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

A resolution must refer to a new commit. This commit must be a descendant of the run base, and it must be reachable from the run branch. The commit must have these trailers: `Peekumi-Run: <id>`, `Peekumi-Comment: <comment id>` and `Peekumi-Agent: codex` or `claude`. Peekumi rejects these items: commits without attribution, unrelated commits, comments from other runs and reports after completion. Verification does a second check that the reported commit is still on the run branch. When a run closes, Peekumi revokes its credentials. The owner API does not include these credentials, and Peekumi redacts them from captured output.

## Runtime and isolation

Peekumi gets the watched ref from the configured `--head`. When the server starts, the default `HEAD` resolves to the current symbolic branch. Each new preview resolves its latest commit, independently of the historical revision that you look at. If HEAD is detached and you want runs to follow a branch that moves, explicitly configure a branch.

Workflow data is in `<state-dir>/workflow.sqlite`, separate from the disposable syntax cache. Keep that state directory through all upgrades. Task files, bounded output logs and worktrees are under `<state-dir>/runs/<id>/`. Workflow state and its directory are private to the local user. Do not commit this state or the agent worktrees.

The name of each run branch is `peekumi/run-<id>`. When Peekumi creates these branches, it starts Git with hooks disabled. Peekumi never changes the checkout that you examine, pushes, merges, deletes branches or automatically removes run worktrees. Peekumi tells agents to stay in the worktree that it gives them. The worktree is Git isolation, not an operating-system security boundary. Installed agents run as the user of the service, and they keep their own sandbox/permission policy.

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
- `PATCH /api/comments/<id>`: `{action, version, text? , note?}`. The actions are `edit`, `delete`, `reopen`, `verify`.
- `POST /api/runs/preview`: `{agent, commentIds, brief}`.
- `POST /api/runs`: `{previewId}`.
- `GET /api/runs/<id>`: progress, task, output and results.
- `POST /api/runs/<id>/cancel`: requests termination of the process group.
- `GET` / `PUT /api/ask/history?branch=<ref>`: the saved Ask conversation of one branch of the repository, `{messages}` (owner only; a maximum of 100 user or assistant messages). Without `branch`, the route uses the watched branch.
- `POST /api/runs/<id>/revise`: `{feedback?}` (necessary if no instructions were collected for the task). It starts the next round of a finished run that is not yet revised, and returns that round (`round`, `revises`, `feedback`). Peekumi rejects the request while a run is active or when nothing remains to change.

The viewer polls active runs every three seconds. Peekumi does not have SSE. The usual comparison/source APIs can get completed work by commit SHA. They do not change the checkout that you examine.

## Validation and remaining boundaries

The deterministic integration agent makes real Git commits and reports through the production MCP transport. The tests cover exact preview delivery, stale drafts and refs, duplicate dispatch, concurrency, invalid attribution and unrelated comments. They also cover flags, unanswered comments, verification, reopen, follow-up rounds, persistence, cancellation and missing executables. The browser tests complete the loop on phone and desktop. These tests do not show a paid Codex or Claude session. For a first real run, local agent authentication and permissions are still necessary.

These items are outside this slice: automatic brief generation, automatic dependency-rule creation from comments, commit-timeline attribution badges, historical comment-state projection, SSE and automatic merges. Each task includes the dependency rules. Owners can use a draft to explicitly ask the agent to propose changes to `.peekumi.json`.

## Ask versus Instruction

**Ask** and **Instruction** stay visible at the bottom edge. They are outside the review content that scrolls, which includes source, diffs, dependencies and run results. The question or draft input stays directly below the mode switch, and its anchor and revision are visible. The two modes use the selected item or the current folder/repository scope. If you reopen an unfinished instruction, it keeps its original anchor and text.

To get direct Details, Source, Changes, Relations and Discussion views, drag the sheet up. Commit mini cards show above the graph only in Time mode. Diff uses base/head selectors. **Discussion** shows the conversation that matches the box: Ask questions and answers, or the instructions on the selection. **Tasks** contains each draft, preparation and progress.

Ask is a contextual conversation that uses the installed, signed-in Claude Code client. All built-in tools, skills and other MCP servers are disabled for Ask. Ask makes no provider call until the owner sends a question. Source and comparison context, static relationships, committed rules and scoped instructions have limits. Ask tells you about all omissions.

Ask runs Claude Code at low effort on a fast model. The default model is Sonnet. For slower and deeper answers, set `--ask-model` or `PEEKUMI_ASK_MODEL` to `opus`. The interface streams each answer while Claude writes it.

While an answer runs, Claude can call five read-only lookups that Peekumi itself serves: `find_declarations`, `search_code`, `read_declaration`, `read_file` and `relationships`. `search_code` finds exact text and gives the name of the declaration that contains each match. Thus, it finds references that the static analysis does not find, for example calls in macros. Each lookup reads committed code at the two compared revisions through the repository worker. No lookup runs code, writes state or gets access to a different repository.

When the answer starts, Peekumi opens a lookup grant with a random key. When the answer ends, with success or failure, Peekumi closes the grant. The key operates only on `/mcp/ask`, and `/mcp/ask` does not accept the owner token. An answer can make a maximum of 12 lookups, and each result has a size limit. The answer gives a list of the lookups that it made. Provider calls time out after 120 seconds.

Each branch of a repository has its own Ask conversation in the private state folder on the host (`ask-history/`, the latest 60 messages for each branch). A conversation that Peekumi saved before this change belongs to the watched branch. When the view changes to a different branch, Ask shows the conversation of that branch. An answer that is not complete when the view changes goes into the conversation where you asked the question. Thus, the conversation is available again after a page reload, an app update or a change to a different owner device. Read-only devices cannot read it. One conversation runs for the session, and it stays in view when the map moves. Each question is about the selection at the time that you sent it. When the subject changes, Peekumi marks the question with that subject.

Claude gets each question with the earlier questions, and each earlier question has a label with its subject. Answers stream in while Claude writes them. A lookup shows while it occurs. An answer can propose an instruction, but only **Save as draft instruction** saves it. The saved instruction is anchored to the selection and viewed revision of the original question.

When you explore a task that can still accept changes, the suggestion and the Instruction box show **Add to requested changes** instead. Each of these saves an instruction that is anchored to the agent commit and marked for that task (`forRun`). Then you can continue to explore. These instructions never join an ordinary task preview. The button below the list of the task sends them as the next round, together with the open instructions of the task. A separate note is not necessary.

Ask cannot verify instructions or start runs. Pinned answers and automatic brief generation are still deferred.
