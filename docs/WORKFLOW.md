# Instructions, runs and verification

Collect feedback while inspecting a repository, preview it as one task, then send it to an agent in a separate worktree. Agent reports return to the instructions for owner review. The interface calls them instructions; the API, MCP tools and commit trailers keep the name `comment`. The map, source viewer and dependency evidence remain the inspection surface.

## Using the loop

1. Select a folder, file, declaration or dependency and choose **Instruction**. With nothing selected, the instruction applies to the current folder or repository. Saved drafts are listed under **Discussion** for that selection and under **Tasks**. A draft stores its immutable Git SHA and anchor; navigation does not move a draft to another selection.
2. Edit or delete drafts freely. **Prepare run** selects the drafts, Codex or Claude Code, and an optional brief. **Preview task** shows the exact task, start SHA, new branch and committed dependency rules.
3. **Dispatch run** consumes that saved preview. If the watched branch or any selected draft changed, make a new preview. Repeated dispatch of the same preview returns the original run. One active run is allowed per repository.
4. Follow progress through **Tasks**. Inspect the agent output, original task and result commits. **Stop run** terminates the agent process group. A run is limited to one hour; logs retain the first MiB while further output is drained.
5. **Explore changes** opens the agent branch on the map compared with the run's start commit, so every change it made is coloured; **Back to task** restores the previous branch and base. Agent-reported check results are evidence supplied by the agent, not an independent test execution by Peekumi.
6. **Approve** records your review of every addressed instruction against that exact commit, with an optional note (**Add note**). It does not merge: the task then shows the branch and the exact `git merge --ff-only peekumi/run-<id>` command to run yourself, with a copy button. Once every result commit is on the watched branch, the task reads **Applied to main**. **Request changes** takes your feedback and starts the next round with the same agent: a new `peekumi/run-<id>` branch from the previous round's last commit, carrying every instruction not yet approved (addressed, flagged or unreported) with the earlier report in its history and in the task. The previous round is marked revised and opens from the latest; merging the latest round applies them all. The API's `reopen` action, which returns an instruction to Draft, remains for compatibility but the interface no longer offers it.

## State and reporting

Instructions move through Draft → With agent → Addressed / Flagged / Unreported. Only the owner can turn Addressed into Verified. Finishing a process never verifies an instruction. Unanswered instructions become Unreported even when the agent exits successfully. Verification and reopening wait for the run to end.

Draft edits use version checks to prevent silently overwriting another open phone or browser. Every transition appends an audit event with the previous text and report retained. The UI explicitly shows **current review status**, including when browsing an older commit. Anchors remain on their original revision; revision-relative instruction state and rename continuity are not implemented yet.

The installed Peekumi binary doubles as a stdio MCP server. Each agent receives a credential scoped to its active run and these tools:

| Tool | Arguments | Result |
|---|---|---|
| `get_run` | none | Frozen task, comment anchors and dependency rules |
| `resolve_comment` | `comment_id`, `commit_sha`, `note`, `checks` | Addressed, with commit and agent-reported check evidence |
| `flag_comment` | `comment_id`, `reason` | Flagged, with an explanation |

A resolution must reference a new commit descended from the run base and reachable from its branch. The commit must carry `Peekumi-Run: <id>`, `Peekumi-Comment: <comment id>` and `Peekumi-Agent: codex` or `claude` trailers. Missing attribution, unrelated commits, comments from other runs, and reports after completion are rejected. Verification rechecks that the reported commit remains on the run branch. Credentials are revoked when a run closes and are omitted from the owner API and redacted from captured output.

## Runtime and isolation

The watched ref is captured from the configured `--head`; default `HEAD` resolves to the current symbolic branch when the server starts. Every new preview resolves its latest commit, independently of the historical revision being viewed. If HEAD is detached, configure a branch explicitly when you want runs to follow a moving branch.

Workflow data lives in `<state-dir>/workflow.sqlite`, separate from the disposable syntax cache. Keep that state directory across upgrades. Task files, bounded output logs and worktrees are under `<state-dir>/runs/<id>/`. Workflow state and its directory are private to the local user. Do not commit this state or agent worktrees.

Run branches are named `peekumi/run-<id>`. Peekumi invokes Git with hooks disabled when it creates them. It never changes the inspected checkout, pushes, merges, deletes branches or automatically removes run worktrees. Agents are instructed to stay in their supplied worktree. The worktree is Git isolation, not an operating-system security boundary: installed agents run as the service's user and retain their own sandbox/permission policy.

Codex launches as `codex exec --sandbox workspace-write --approve-for-me`; Claude Code uses `claude -p --permission-mode acceptEdits`. Codex routes approval requests through its automatic reviewer. Claude is explicitly granted file, search, shell and the three Peekumi reporting tools, with other MCP configurations excluded. Neither adapter uses a blanket permission-bypass flag. Configure installed executable paths with `--codex` / `PEEKUMI_CODEX` and `--claude` / `PEEKUMI_CLAUDE`; agent sign-in and any required tool permissions must be available to the service account. Failures appear in the run instead of claiming success. Codex uses its documented [non-interactive interface](https://developers.openai.com/codex/noninteractive) and [stdio MCP configuration](https://developers.openai.com/codex/mcp).

A SQLite transaction holds the active-run slot. An OS lock in Git's common directory prevents agents from two Peekumi instances from running concurrently against the same repository. A second server cannot open the same workflow state. After an unexpected service exit, a recovered run becomes Interrupted and holds its slot until its recorded agent process exits, then closes as failed with retained commits and reports. Recovery deliberately does not kill a potentially reused PID. If an interrupted process is still alive, stop it through its original agent process/session on the host; the recovered UI explains the wait. PID reuse can conservatively block recovery until that process exits.

Authenticated owner writes require same-origin JSON. Untrusted repository text, task previews and agent output render as text. The phone session can dispatch runs, so its access link has authority beyond repository viewing. Agent protocol scoping does not protect local files from a fully trusted process running as the same OS user.

## API

- `POST /api/ask`: `{base, head, sha, anchor, question, history, stream?}`; returns an answer, optional suggested instruction, the lookups it made and context omissions. `references` maps each code span in the answer that names exactly one file (optionally `path:line`) or declaration to its place, `{kind, path, symbol?, line, side}`; ambiguous and unknown spans are left out. With `stream: true` the reply is newline-delimited JSON events instead: `text` pieces as Claude writes, `turn` when a new model turn begins (earlier text was working, not the answer), `lookup` for each lookup, then `done` with the same body, or `error`. Declaration and file questions include static relationships (outgoing calls, imports, implementations and inheritance, and incoming references) and the code of up to four declarations that call the selection. Folder and repository questions include the directory README, its declarations and changed-file diffs.
- `POST /mcp/ask`: Ask's read-only lookup tools over Streamable HTTP MCP. Accepts only the random key of an answer in progress; see below.
- `GET /api/workflow`: comments, history, run summaries and watched ref.
- `POST /api/comments`: `{anchor, sha, text, forRun?}`; `forRun` marks the instruction for that finished task's next round (rejected once the task was revised).
- `PATCH /api/comments/<id>`: `{action, version, text? , note?}`; actions `edit`, `delete`, `reopen`, `verify`.
- `POST /api/runs/preview`: `{agent, commentIds, brief}`.
- `POST /api/runs`: `{previewId}`.
- `GET /api/runs/<id>`: progress, task, output and results.
- `POST /api/runs/<id>/cancel`: request process-group termination.
- `GET` / `PUT /api/ask/history`: the repository's saved Ask conversation, `{messages}` (owner only; at most 100 user or assistant messages).
- `POST /api/runs/<id>/revise`: `{feedback?}` (required unless instructions were collected for the task); starts the next round of a finished, not yet revised run and returns it (`round`, `revises`, `feedback`). Rejected while a run is active or when nothing is left to change.

The viewer polls active runs every three seconds; SSE is not implemented. Completed work remains available by commit SHA to the ordinary comparison/source APIs without switching the inspected checkout.

## Validation and remaining boundaries

The deterministic integration agent performs real Git commits and reports through the production MCP transport. Tests cover exact preview delivery, stale drafts and refs, duplicate dispatch, concurrency, invalid attribution, unrelated comments, flagging, unanswered comments, verification, reopening, follow-up rounds, persistence, cancellation and missing executables. Browser coverage completes the loop on phone and desktop. These tests do not demonstrate a paid Codex or Claude session; a first real run still depends on local agent authentication and permissions.

Automatic brief generation, automatic dependency-rule creation from comments, commit-timeline attribution badges, historical comment-state projection, SSE and automatic merges remain outside this slice. Dependency rules are included in every task; owners can explicitly ask the agent to propose changes to `.peekumi.json` through a draft.

## Ask versus Instruction

**Ask** and **Instruction** stay visible at the bottom edge, outside the scrolling review content, including source, diffs, dependencies and run results. The question or draft input stays directly below the mode switch with its anchor and revision visible. They use the selected item or current folder/repository scope; reopening an unfinished instruction preserves its original anchor and text. Drag the sheet up for direct Details, Source, Changes, Relations and Discussion views. Commit mini cards appear above the graph only in Time mode; Diff uses base/head selectors. **Discussion** shows the conversation that matches the box: Ask questions and answers, or the instructions on the selection. **Tasks** holds every draft, preparation and progress. Ask is a contextual conversation using the installed, signed-in Claude Code client, with every built-in tool, skill and other MCP server disabled. No provider call occurs until the owner submits a question. Source and comparison context, static relationships, committed rules and scoped instructions are bounded and any omissions are disclosed.

Ask runs Claude Code at low effort on a fast model, Sonnet by default; set `--ask-model` or `PEEKUMI_ASK_MODEL` to `opus` for slower, deeper answers. The interface streams each answer as it is written.

While an answer runs, Claude may call five read-only lookups served by Peekumi itself: `find_declarations`, `search_code`, `read_declaration`, `read_file` and `relationships`. `search_code` finds exact text and names the declaration each match sits in, which catches references the static analysis misses, such as calls inside macros. Each reads committed code at the two compared revisions through the repository worker. None runs code, writes state or reaches another repository. Peekumi opens a lookup grant with a random key when the answer starts and closes it when the answer ends, success or failure. The key works only on `/mcp/ask`, and the owner token is not accepted there. An answer may make at most 12 lookups, and each result is size-limited. The answer lists the lookups it made. Provider calls time out after 120 seconds.

Each repository keeps one Ask conversation in its private state folder on the host (`ask-history.json`, the latest 60 messages), so reloading, updating the app or switching owner device picks it up again; read-only devices cannot read it. One conversation runs for the session and stays in view as the map moves; each question is about whatever was selected when it was sent, is marked with that subject when it changes, and reaches Claude with earlier questions labelled by their subjects. Answers stream in as they are written; a lookup shows while it happens. An answer can propose an instruction, but only **Save as draft instruction** saves it, anchored to the original question's selection and viewed revision. While exploring a task that can still take changes, the suggestion and the Instruction box offer **Add to requested changes** instead: each saves an instruction anchored to the agent's commit and marked for that task (`forRun`), and exploring carries on. Such instructions never join an ordinary task preview; **Request changes** sends them with the task's open instructions as the next round, and the overall note becomes optional. Ask cannot verify instructions or start runs. Pinned answers and automatic brief generation remain deferred.
