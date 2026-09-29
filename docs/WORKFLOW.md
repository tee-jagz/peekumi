# Comments, runs and verification

Collect feedback while inspecting a repository, preview it as one task, then send it to an agent in a separate worktree. Agent reports return to the comments for owner review. The map, source viewer and dependency evidence remain the inspection surface.

## Using the loop

1. Select a folder, file, declaration or dependency and choose **Comment**. The Comments tab also supports a comment on the current scope. A draft stores its immutable Git SHA and anchor; navigation does not move a draft to another selection.
2. Edit or delete drafts freely. **Prepare run** selects the drafts, Codex or Claude Code, and an optional brief. **Preview task** shows the exact task, start SHA, new branch and committed dependency rules.
3. **Dispatch run** consumes that saved preview. If the watched branch or any selected draft changed, make a new preview. Repeated dispatch of the same preview returns the original run. One active run is allowed per repository.
4. Follow progress through **Comments → View runs**. Inspect the agent output, original task and result commits. **Stop run** terminates the agent process group. A run is limited to one hour; logs retain the first MiB while further output is drained.
5. **Review fix** opens the run's base-to-result comparison. Agent-reported check results are evidence supplied by the agent, not an independent test execution by Strata.
6. **Verify** records your review note against that exact commit. **Reopen** returns addressed, flagged or unreported feedback to Draft with its earlier history preserved.

## State and reporting

Comments move through Draft → With agent → Addressed / Flagged / Unreported. Only the owner can turn Addressed into Verified. Finishing a process never verifies a comment. Unanswered comments become Unreported even when the agent exits successfully. Verification and reopening wait for the run to end.

Draft edits use version checks to prevent silently overwriting another open phone or browser. Every transition appends an audit event with the previous text and report retained. The UI explicitly shows **current review status**, including when browsing an older commit. Anchors remain on their original revision; revision-relative comment state and rename continuity are not implemented yet.

The installed Strata binary doubles as a stdio MCP server. Each agent receives a credential scoped to its active run and these tools:

| Tool | Arguments | Result |
|---|---|---|
| `get_run` | none | Frozen task, comment anchors and dependency rules |
| `resolve_comment` | `comment_id`, `commit_sha`, `note`, `checks` | Addressed, with commit and agent-reported check evidence |
| `flag_comment` | `comment_id`, `reason` | Flagged, with an explanation |

A resolution must reference a new commit descended from the run base and reachable from its branch. The commit must carry `Strata-Run: <id>`, `Strata-Comment: <comment id>` and `Strata-Agent: codex` or `claude` trailers. Missing attribution, unrelated commits, comments from other runs, and reports after completion are rejected. Verification rechecks that the reported commit remains on the run branch. Credentials are revoked when a run closes and are omitted from the owner API and redacted from captured output.

## Runtime and isolation

The watched ref is captured from the configured `--head`; default `HEAD` resolves to the current symbolic branch when the server starts. Every new preview resolves its latest commit, independently of the historical revision being viewed. If HEAD is detached, configure a branch explicitly when you want runs to follow a moving branch.

Workflow data lives in `<state-dir>/workflow.sqlite`, separate from the disposable syntax cache. Keep that state directory across upgrades. Task files, bounded output logs and worktrees are under `<state-dir>/runs/<id>/`. Workflow state and its directory are private to the local user. Do not commit this state or agent worktrees.

Run branches are named `strata/run-<id>`. Strata invokes Git with hooks disabled when it creates them. It never changes the inspected checkout, pushes, merges, deletes branches or automatically removes run worktrees. Agents are instructed to stay in their supplied worktree. The worktree is Git isolation, not an operating-system security boundary: installed agents run as the service's user and retain their own sandbox/permission policy.

Codex launches as `codex exec --sandbox workspace-write --approve-for-me`; Claude Code uses `claude -p --permission-mode acceptEdits`. Codex routes approval requests through its automatic reviewer. Claude is explicitly granted file, search, shell and the three Strata reporting tools, with other MCP configurations excluded. Neither adapter uses a blanket permission-bypass flag. Configure installed executable paths with `--codex` / `STRATA_CODEX` and `--claude` / `STRATA_CLAUDE`; agent sign-in and any required tool permissions must be available to the service account. Failures appear in the run instead of claiming success. Codex uses its documented [non-interactive interface](https://developers.openai.com/codex/noninteractive) and [stdio MCP configuration](https://developers.openai.com/codex/mcp).

A SQLite transaction holds the active-run slot. An OS lock in Git's common directory prevents agents from two Strata instances from running concurrently against the same repository. A second server cannot open the same workflow state. After an unexpected service exit, a recovered run becomes Interrupted and holds its slot until its recorded agent process exits, then closes as failed with retained commits and reports. Recovery deliberately does not kill a potentially reused PID. If an interrupted process is still alive, stop it through its original agent process/session on the host; the recovered UI explains the wait. PID reuse can conservatively block recovery until that process exits.

Authenticated owner writes require same-origin JSON. Untrusted repository text, task previews and agent output render as text. The phone session can dispatch runs, so its access link has authority beyond repository viewing. Agent protocol scoping does not protect local files from a fully trusted process running as the same OS user.

## API

- `POST /api/ask`: `{base, head, sha, anchor, question, history}`; returns an answer, optional suggested comment and context omissions.
- `GET /api/workflow`: comments, history, run summaries and watched ref.
- `POST /api/comments`: `{anchor, sha, text}`.
- `PATCH /api/comments/<id>`: `{action, version, text? , note?}`; actions `edit`, `delete`, `reopen`, `verify`.
- `POST /api/runs/preview`: `{agent, commentIds, brief}`.
- `POST /api/runs`: `{previewId}`.
- `GET /api/runs/<id>`: progress, task, output and results.
- `POST /api/runs/<id>/cancel`: request process-group termination.

The viewer polls active runs every three seconds; SSE is not implemented. Completed work remains available by commit SHA to the ordinary comparison/source APIs without switching the inspected checkout.

## Validation and remaining boundaries

The deterministic integration agent performs real Git commits and reports through the production MCP transport. Tests cover exact preview delivery, stale drafts and refs, duplicate dispatch, concurrency, invalid attribution, unrelated comments, flagging, unanswered comments, verification, reopening, persistence, cancellation and missing executables. Browser coverage completes the loop on phone and desktop. These tests do not demonstrate a paid Codex or Claude session; a first real run still depends on local agent authentication and permissions.

Automatic brief generation, automatic dependency-rule creation from comments, commit-timeline attribution badges, historical comment-state projection, SSE and automatic merges remain outside this slice. Dependency rules are included in every task; owners can explicitly ask the agent to propose changes to `.strata.json` through a draft.

## Ask versus Comment

**Ask** and **+ Comment** stay visible above the scrolling review content, including source, diffs, dependencies and run results. They use the selected item or current folder/repository scope; reopening an unfinished comment preserves its original anchor and text. Description and metadata are collapsible, inspection helpers live under **Explore code**, and commit history sits on the map. Comments capture instructions; **Comments → View runs** holds preparation and progress. Ask is a contextual conversation using the installed, signed-in Claude Code client, with all tools, skills and extra MCP servers disabled. No provider call occurs until the owner submits a question. Source and comparison context, committed rules and scoped comments are bounded and any omissions are disclosed. Provider calls time out after 30 seconds.

Ask history stays in the open browser page and is lost on reload; each selected revision/scope has a separate conversation. Responses arrive when complete, rather than token streaming. An answer can propose a comment, but only **Make draft comment** saves it, anchored to the original question's selection and viewed revision. Ask cannot verify comments or start runs. Pinned answers and automatic brief generation remain deferred.
