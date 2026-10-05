# Instructions, runs and verification

When you examine a repository, you can collect feedback. You preview this feedback as one task, and then you send it to an agent in a separate worktree. The agent reports return to the instructions, and the owner reviews them. The interface calls these items instructions. The API, the MCP tools and the commit trailers keep the name `comment`. The map, the source viewer and the dependency evidence stay the surface where you examine the repository.

## Using the loop

1. Select a folder, file, declaration or dependency. Then select **Instruction**. If you select nothing, the instruction is for the current folder or repository. **Discussion** shows the saved drafts for that selection, and **Tasks** also shows them. A draft keeps its immutable Git SHA and anchor. Navigation does not move a draft to a different selection.
2. You can edit or delete drafts with no restriction. **Prepare run** selects the drafts and an optional brief. The task uses the agent, model and effort that you chose for tasks in **Agents** (**Change** opens that list). **Preview task** freezes them in the task, and every round of the task uses them. **Preview task** shows the exact task, the start SHA, the new branch and the committed dependency rules.
3. **Dispatch run** uses that saved preview, and a preview starts only one run. If the watched branch or a selected draft changed, make a new preview. If you dispatch the same preview again, Peekumi returns the original run. Each repository can have only one active run.
4. Monitor the progress in **Tasks**. Examine the agent output, the original task and the result commits. **Stop run** stops the agent process group. The maximum time for a run is one hour. Logs keep the first MiB, and Peekumi drains the output that follows.
5. **Explore changes** opens the agent branch on the map and compares it with the start commit of the run. Thus, the map colours each change that the agent made. **Back to task** restores the previous branch and base. Check results that the agent reports are evidence from the agent. These results do not come from an independent test execution by Peekumi.
6. **Approve** records your review of each addressed instruction against that exact commit, with an optional note (**Add note**). **Approve** does not merge. The task then shows **Approved · ready to merge**. Until you merge, **Reopen review** takes the approval back, and you can still request changes. When all result commits are on the watched branch, the task shows **Merged into main** (or **Applied to main** if you merged it in a different way). An applied task is a closed record: it has no review actions, and **Follow up** starts a new instruction at the same place, for a new task.
7. **Merge into main** shows the commits and the changed files, and asks you to confirm. Peekumi then does a fast-forward of the watched branch to the last commit of the task. It never makes a merge commit on the watched branch, and it never pushes. If the watched branch is checked out in the folder that you examine, Git updates its files. If it is not checked out, only the branch moves. **Undo merge** moves the branch back while the branch and the merged files have no new changes.

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
- `POST /api/runs/<id>/revise`: `{feedback?}` (necessary if no instructions were collected for the task). It starts the next round of a finished run that is not yet revised, and returns that round (`round`, `revises`, `feedback`). Peekumi rejects the request while a run is active or when nothing remains to change.

The viewer polls active runs every three seconds. Peekumi does not have SSE. The usual comparison/source APIs can get completed work by commit SHA. They do not change the checkout that you examine.

## Validation and remaining boundaries

The deterministic integration agent makes real Git commits and reports through the production MCP transport. The tests cover exact preview delivery, stale drafts and refs, duplicate dispatch, concurrency, invalid attribution and unrelated comments. They also cover flags, unanswered comments, verification, reopen, follow-up rounds, persistence, cancellation and missing executables. The browser tests complete the loop on phone and desktop. These tests do not show a paid Codex or Claude session. For a first real run, local agent authentication and permissions are still necessary.

These items are outside this slice: automatic brief generation, automatic dependency-rule creation from comments, commit-timeline attribution badges, historical comment-state projection, SSE, merges without an owner action, and push. Each task includes the dependency rules. Owners can use a draft to explicitly ask the agent to propose changes to `.peekumi.json`.

## Ask versus Instruction

**Ask** and **Instruction** stay visible at the bottom edge. They are outside the review content that scrolls, which includes source, diffs, dependencies and run results. The question or draft input stays directly below the mode switch, and its anchor and revision are visible. The two modes use the selected item or the current folder/repository scope. If you reopen an unfinished instruction, it keeps its original anchor and text.

To get direct Details, Source, Changes, Relations and Discussion views, drag the sheet up. Commit mini cards show above the graph only in Time mode. Diff uses base/head selectors. **Discussion** shows the conversation that matches the box: Ask questions and answers, or the instructions on the selection. **Tasks** contains each draft, preparation and progress.

Ask is a contextual conversation that uses the installed, signed-in Claude Code client. All built-in tools, skills and other MCP servers are disabled for Ask. Ask makes no provider call until the owner sends a question. Source and comparison context, static relationships, committed rules and scoped instructions have limits. Ask tells you about all omissions.

Ask runs Claude Code. Choose its model and effort in **Agents**. Without a choice on the device, Ask uses the server defaults: Sonnet at low effort. To change these defaults, set `--ask-model` or `PEEKUMI_ASK_MODEL` and `--ask-effort` or `PEEKUMI_ASK_EFFORT`. The interface streams each answer while Claude writes it.

## Agents

**Agents** has one row for each job: **Ask** answers questions, and **Tasks** change code. Open it from the chip next to the composer, which shows what the current mode uses, or from **Agents** in the Tasks view. For each job, select a provider, then one of its models, then an effort:

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
