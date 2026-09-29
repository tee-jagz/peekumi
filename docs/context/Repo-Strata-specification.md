# Repo Strata: specification

Sep 29, 2026 · @Someone

## What this is

Repo Strata is a mobile-first review console for code written by AI coding agents. It lets one developer see what the agents changed at the level of architecture, judge whether it is sound, and steer the next round of work without reading every diff.

**The problem.** Codex and Claude Code run unattended on an always-on Mac mini and produce more change than one person can read line by line. Line diffs do not answer the questions that matter: did the structure drift, did a dependency rule break, which changed code is risky, and are the new tests real. Steering today means typing one-off instructions into a terminal.

**The idea, in three moves.**

1. **See.** Every commit becomes a snapshot of the codebase's structure (layers, modules, functions, dependencies) plus quality metrics. Comparing snapshots shows changes as added, changed or removed pieces and broken rules on a map you can drill into, from layers down to a function's patch.
2. **Understand.** Ask is a real-time AI conversation grounded in whatever you have selected: its code changes, metrics, history and existing comments.
3. **Steer.** While reviewing you leave draft comments pinned to modules, functions or dependencies. When ready, you send them together as one run to an agent, with a brief distilled from your Ask conversation. The agent's commits come back linked to the comments, and you verify or reopen each one.

**Who it is for.** One developer supervising their own agents, reviewing mostly from a phone. Not a team product and not a hosted service.

**Evidence so far.** A clickable mockup with sample data, and a working snapshot generator run on the open source repo cosmicpython/code: 176 commits scanned, 93 source-changing snapshots, 17 modules, and the single real rule break in its history found at commit #33 ("email in model"). Whether it helps on real agent work is untested; this spec is scoped to find that out quickly.

## Goals, non-goals and the success test

The first release must prove one thing: that reviewing agent work through this tool changes decisions. Everything else is secondary.

**Goals**

- Turn every commit on a watched branch into a structural snapshot within 60 seconds, without disturbing the agent's working directory.
- Show what changed between any two commits at three levels: layers, modules, functions, down to the function's patch.
- Flag dependency rule breaks from a per-repo layer config.
- Let the owner draft anchored comments, send them as a run to Codex or Claude Code, and see which commits addressed which comments.
- Work comfortably on a phone over a private network.

**Non-goals for v1**

- Multi-user access, accounts, sharing or hosting.
- Languages other than Python (the design keeps the door open; see the generator section).
- Automatic merging of agent branches.
- Replacing GitHub PR review. Line-level review stays where it is.

**Success test.** Use v1 for one week of real agent work on one of the owner's repos. It succeeds if it changed at least one decision: caught something that would otherwise have been missed, or produced a comment that sent an agent back. If the owner opens it less than expected, stop and rethink before building metrics or polish.

## System overview

Everything runs on the owner's always-on Mac mini; the phone only views and sends instructions.

&#91;embedded content: system overview · 10 components, one machine\]

Agents commit in their run worktrees; the hook queues each commit, the worker snapshots it into SQLite, and the API serves diffs to the phone over Tailscale. Comments and runs travel back through the same API: the dispatcher launches an agent headless, and the agent reports what it addressed through the MCP server.

## Snapshot generator

The generator turns one commit into one snapshot. `strata_gen.py` in the zip is a working prototype (about 200 lines, Python `ast`) that already does this for cosmicpython; production code should keep its behaviour and fix the limits listed below.

**Trigger and queue**

1. A `post-commit` hook in each watched repo appends the commit SHA and branch to a queue (a SQLite table is enough).
2. A single worker process drains the queue in order and skips SHAs already snapshotted.
3. The worker checks out each SHA into a dedicated `git worktree` under `~/.strata/worktrees/<repo>`, never the agent's working directory.
4. Backfill: on first registration, walk `git log --first-parent` and snapshot history oldest first.

**Extraction per commit (structure pass, target under 5 s)**

- Files: all source files matching the repo config's include globs, minus exclude globs (tests, migrations, generated code).
- Parser: tree-sitter with per-language queries. The prototype uses Python `ast`; switching to tree-sitter now makes the second language cheap.
- Entities: top-level functions; class methods as `Class.method`; classes with no methods as one entity.
- Entity hash: SHA-1 of the normalised syntax tree (no positions, no comments, no formatting). A different hash means the code changed; formatting-only edits do not count.
- Dependencies: internal imports resolved to modules. External packages are ignored.
- Calls: calls between entities inside the same module (name match for functions, `self.x` or `cls.x` for methods). Cross-module call resolution is a later step via SCIP indexers.
- Patches: for every entity whose hash changed, a unified diff of its old and new source text, capped at 80 lines, stored with the snapshot.

**Identity (fix before real use)**

- Module id = repo-relative path without extension (`src/allocation/domain/model`), not file stem. The prototype uses stems, which breaks when two files share a name.
- Renames and moves: use `git diff -M` rename detection between consecutive snapshots and record `renamed_from` so history, comments and anchors follow the module. For entities, match removed and added functions in the same commit by body similarity above 0.8.

**Metrics (metrics pass, runs after the structure pass and may lag)**

| Metric | Tool | When | Cost |
| --- | --- | --- | --- |
| Cyclomatic complexity | computed from the tree (or radon) | every snapshot | milliseconds |
| Line coverage per entity | the repo's test command writing LCOV or coverage.py JSON, mapped to entity line ranges | every snapshot on watched branches | seconds to minutes |
| CRAP | complexity² × (1 − coverage)³ + complexity | derived | free |
| Mutation score | mutmut, run only on entities changed since the parent | queued, lowest priority | minutes to hours |

Metrics that have not run are `null`, never zero. The viewer shows them as pending or not measured.

## Snapshot schema and storage

Store snapshots, not diffs. Each commit gets one immutable snapshot; any comparison between two commits is computed on request. That is what makes "compare any base with head" cheap.

**Repo config** (`.strata.yml` in the repo root, or registered on the Mac mini)

```yaml
name: pipeline-core
language: python
include: ["src/**/*.py"]
exclude: ["**/tests/**", "**/test_*.py", "**/conftest.py", "**/migrations/**"]
test_command: "pytest --cov=src --cov-report=json:.strata/coverage.json"
layers:                      # outer to inner; first match wins
  entry:    ["src/**/entrypoints/**", "src/**/bootstrap.py"]
  app:      ["src/**/service_layer/**", "src/**/views.py"]
  domain:   ["src/**/domain/**"]
  adapters: ["src/**/adapters/**", "src/**/config.py"]
rules:                       # a dependency from -> to is a violation
  - {from: domain, to: [app, entry, adapters]}
  - {from: app, to: [entry]}
  - {from: adapters, to: [app, entry]}
```

**Snapshot record** (one JSON document per commit; the prototype's `strata.json` is an array of these in a slightly flatter shape)

```json
{
  "repo": "pipeline-core",
  "sha": "e5c7710", "parent": "19fd62b", "branch": "main",
  "author": "Claude Code", "agent": "claude-code", "run_id": 4,
  "message": "Add retries to judge scoring", "committed_at": "2026-09-30T11:48:00Z",
  "modules": {
    "src/domain/judge": {
      "layer": "domain", "renamed_from": null,
      "entities": {
        "score": {"hash": "9f2c1a0b3d4e", "lines": [12, 31], "cc": 5, "coverage": 0.72, "crap": 7.4, "mutation": null}
      }
    }
  },
  "deps":  [{"from": "src/domain/judge", "to": "src/adapters/llm_client", "kind": "dep"}],
  "calls": {"src/domain/judge": [["score", "parse_verdict"]]},
  "patches": {"src/domain/judge::score": [" def score(case, answer, model):", "+    for attempt in range(3):"]},
  "metrics_status": {"complexity": "done", "coverage": "done", "mutation": "queued"}
}
```

**Storage.** One SQLite file per repo at `~/.strata/<repo>.db`:

| Table | Key | Holds |
| --- | --- | --- |
| snapshots | sha | the JSON document above, plus parent and committed\_at columns for ordering |
| queue | sha | pending work and which pass (structure, coverage, mutation) |
| comments | id | anchor, text, status, run\_id, created\_at\_sha, rule flag |
| runs | id | agent, branch, brief, comment ids, started and finished times, result SHAs |
| flags | comment\_id | reason an agent could not address a comment |

Size check from the prototype: 93 snapshots of a 17-module repo, with patches, came to 420 KB of JSON.

## Diff and review engine

The engine compares a base snapshot with a head snapshot and returns statuses and change items. It is pure functions over two snapshots, so it can run in the API or in the browser; the mockup runs it in the browser (`itemsFor`, `modStatus`, `fnStatus` in the viewer code).

**Statuses**

| Level | Added / removed | Changed when | Unchanged |
| --- | --- | --- | --- |
| Entity | present in only one snapshot | hash differs | hash equal |
| Module | present in only one snapshot | any entity added, removed or changed, or its outgoing dependency set changed | otherwise |
| Layer | not applicable | any module in it is not unchanged | otherwise |

**Roll-up of metrics.** A parent shows its worst child: a module's complexity is its highest entity complexity, its mutation score is its lowest. This is deliberate, so one weak function cannot hide inside a healthy module.

**Health score (0 to 1)** used by the Health colour lens:

- With coverage and mutation: mean of clamp(1 − (CRAP − 5) / 25) and clamp((mutation − 0.4) / 0.5).
- Complexity only: clamp(1 − (complexity − 3) / 8).

**Change items.** Each comparison produces a list the viewer shows, sorted bad first, then good, then neutral:

| Kind | Example | Severity rule |
| --- | --- | --- |
| module | New module dedupe | bad if born with health below 0.5 |
| edge | judge now depends on llm\_client | bad if it breaks a rule; good if a broken rule is removed |
| modmetric | judge CRAP 8 to 22 | bad if worse by the threshold, good if better |
| fn | Changed score() | bad or good if health moves more than 0.08 |
| fnmetric | dedupe() better tested (code unchanged) | test-only changes, from metrics alone |
| fnsummary | judge: functions 1 changed, 1 added | neutral pointer into the module |

Thresholds: complexity or CRAP change of 3 or more (2 in complexity-only mode); mutation change of 0.08 or more.

**Scope.** Items are filtered by the viewer's level: repo shows module, edge, modmetric and fnsummary items; a layer shows those touching the layer; a module shows its fn and fnmetric items and its own edges.

**Known blind spot.** A base-to-head diff hides churn inside the range: a rule broken and fixed between the two commits never appears. The Time view is what exposes it, so both views are required.

## API

A small HTTP service on the Mac mini (FastAPI or similar) serves the viewer's static files and this JSON API. The same service exposes an MCP server for agents. All endpoints are scoped to a registered repo.

| Method and path | Returns or does |
| --- | --- |
| GET /api/repos | registered repos with branch, snapshot count, last commit |
| GET /api/repos/{repo}/commits?branch=&limit= | commit list: sha, parent, author, agent, run\_id, message, time, bad-item count vs parent |
| GET /api/repos/{repo}/snapshots/{sha} | one snapshot document (without patches) |
| GET /api/repos/{repo}/history?since=&until= | a range of snapshots for the Time view, patches omitted |
| GET /api/repos/{repo}/diff?base=&head=&scope= | change items for the scope (repo, layer:\<name>, module:\<id>) |
| GET /api/repos/{repo}/patch?base=&head=&entity= | the entity's patches for every commit in the range, in order |
| GET /api/repos/{repo}/comments?status= | comments with anchors and status |
| POST /api/repos/{repo}/comments | create a draft comment: anchor, text, created\_at\_sha, rule flag |
| PATCH /api/comments/{id} | edit text, verify, reopen, delete a draft |
| POST /api/repos/{repo}/runs/preview | body: agent, comment ids, brief; returns the exact task text |
| POST /api/repos/{repo}/runs | dispatch a run (see the agent contract) |
| GET /api/repos/{repo}/runs | runs with status, branch, results |
| POST /api/ask | proxy to the Claude API with the context pack; streams the answer |
| POST /api/brief | distil an Ask conversation plus chosen comments into a brief |
| GET /api/events | server-sent events: snapshot ready, metrics updated, run progress |

**Anchors** are stable identifiers, not positions: `{"kind":"module","module":"src/domain/judge"}`, `{"kind":"entity","module":…,"entity":"score"}`, `{"kind":"dep","from":…,"to":…}`, `{"kind":"layer_dep","from":"domain","to":"adapters"}`, `{"kind":"call","module":…,"from":…,"to":…}`. When a module or entity is renamed, stored anchors are rewritten from the rename records.

## Viewer

The viewer is a single-page web app served by the API, built mobile first and tested at 390 × 844. The mockup in the zip is the visual and interaction reference: match its behaviour, not necessarily its code structure. It is plain HTML, CSS and JavaScript with no build step; a framework is fine if it keeps the page fast on a phone.

**Layout.** Header (repo name, Time or Diff switch), a map stage (about 55% of the height on a phone), and a scrolling review panel below it. On screens 900 px and wider the panel moves to a 400 px right column.

**Views (what depth means)**

- **Time.** A stack of commit cards. The commit under review is in front; the three before it peek out above it with author and message. Tapping a peeking card moves back to that commit. Commit chips in the panel jump anywhere; chips carry a red count of bad items versus the parent.
- **Diff.** Two cards: the base behind, the reviewed commit in front. A "Compare with" picker chooses any earlier commit as base. A Before and After switch brings the base to the front.

**Levels and navigation**

| Level | Cards | Neighbours (dashed, outside the view) | Inside each card |
| --- | --- | --- | --- |
| Repo | one per layer, stacked | none; layer dependencies drawn as arcs in the right gutter | module pills, up to 3 plus a count |
| Layer | modules, one or two rows | modules from other layers it touches, up to 4 per row with a "+N more" | one bar per function, coloured |
| Module | functions, 1 to 3 columns inside the module frame | modules it depends on (below) and that depend on it (above) | name, class as a muted suffix, metric at one column |

Tap selects; tapping a selected card opens it with a zoom from that card. A back chevron and breadcrumb go up with the reverse zoom. Positions are stable across commits: the layout is computed from every module and function that ever existed, so things do not jump when you change commit. Escape clears the selection, then goes up.

**Colour lens** (switch at the bottom of the stage)

- **Health:** red through amber to green from the health score; a parent shows its worst child.
- **Changes:** green added, violet changed, red dashed outline for removed, grey unchanged.
- Rule breaks always show a red "!" badge on the dependency, in both lenses.

**Lines.** Solid for depends on or calls, dotted for implements, red for a rule break, dashed red for removed in Changes. Tapping a line selects it for comments and Ask.

**Review panel**, top to bottom: commit chips (and the compare picker in Diff), commit title and meta, the selection strip (name, kind, status pill, metric now and before, Open, Comment, Ask), the run bar when drafts exist, then three tabs: Changes, Comments, Ask. Changes lists the scoped change items; tapping one navigates to the level where it is visible and pulses the relevant line. When a function is selected, its patches for the range show above the list.

**Performance targets.** First paint under 1 s on a phone over Tailscale for a repo of 200 modules; level changes under 100 ms after data is loaded. Cap drawn call edges: in multi-column function grids, draw only the selected function's calls.

## Comments, runs and the agent contract

Comments are instructions collected during review and sent together; nothing reaches an agent until the owner dispatches a run. This batching is the core of the steering loop: the agent sees related feedback at once and plans one change, and the owner can revise half-formed notes before anything happens.

**Comment states**

| State | Meaning | Owner actions |
| --- | --- | --- |
| Draft | written, not sent | edit, delete, include in a run |
| With agent | sent in run N, not yet resolved | none (view the run) |
| Addressed | the agent linked a commit to it | Verify, Reopen (back to Draft), jump to that commit |
| Flagged | the agent reported it could not address it, with a reason | Reopen with changes, or delete |
| Verified | the owner confirmed the fix | none |
| Unreported | the run ended without the agent resolving or flagging it | Reopen |

Statuses follow the timeline: viewing an older commit shows each comment as it stood then. A comment on a dependency can be marked "Enforce as a rule"; rules are appended to the repo config's rules and included in every later run.

**Preparing a run** (the Prepare run screen in the mockup): pick the agent (Codex or Claude Code), tick which drafts go, and write or draft the brief. "Preview task" shows the exact text the agent will receive. Runs always start from the latest commit on the watched branch.

**Dispatch.** v1 allows one active run per repo to avoid agents colliding.

1. Create a worktree on a new branch `strata/run-<N>` from the latest commit.
2. Write the task to `.strata/run-<N>.md` in that worktree.
3. Start the agent headless in the worktree: `claude -p` for Claude Code or `codex exec` for Codex, with the task as the prompt and the strata MCP server configured.
4. Stream progress to the viewer through `/api/events`. When the process exits, snapshot the branch's new commits and close the run.

**Task template** (generated; the mockup's preview produces exactly this shape)

```markdown
# Task for Codex, run 4
Repository: pipeline-core. Start from #6 (88d0a4f) on a new branch, strata/run-4.

## Brief
Decisions: ... Constraints: ... Open questions: ...

## Review comments
Address each one. Put its id in the message of the commit that addresses it.
1. [c5] pipeline.run() (function, left on #6)
   run() is now the riskiest function in the repo. Split loading, dedupe and writing into separate steps.

## Rules in force
- judge → llm_client: Domain must not call adapters.

## When you finish
For each comment you addressed, call resolve_comment(id, commit). If you could not address one, call flag_comment(id, reason) instead of guessing.
```

**MCP tools exposed to agents**

| Tool | Arguments | Effect |
| --- | --- | --- |
| get\_run | run\_id | the task, comments with anchors, rules |
| resolve\_comment | comment\_id, commit\_sha, note | marks Addressed and links the commit |
| flag\_comment | comment\_id, reason | marks Flagged |
| get\_snapshot\_context | module or entity | current structure, metrics and recent patches for that anchor |

**Attribution.** Every agent commit carries trailers `Strata-Run: 4` and `Strata-Comment: c5`, and the agent's identity in the author name or a `Strata-Agent: codex` trailer. The generator reads these into the snapshot's `agent` and `run_id` fields. Without this, the timeline cannot say who did what.

## Ask

Ask is the real-time channel: questions, clarification and planning with an AI while reviewing. It never instructs agents directly. Its only path to an agent is through the owner: a suggestion becomes a draft comment, or pinned answers shape a run's brief.

**Context pack** sent with every question, built from the current view (`contextText()` in the mockup):

- Repo name, layer definitions and rules.
- Commit under review and the base it is compared with.
- The current scope and the selected item with status and metrics, now and at base.
- Change items in scope.
- Patches in the range for the selected function, or for every function of the selected module.
- Comments already left on the selection or scope, with their status.

Keep the pack under about 12,000 tokens; when patches exceed that, send the newest first and name what was cut.

**Prompt rules.** Plain prose, at most about 110 words, no headings. When a concrete instruction for the agent would help, the answer ends with a line beginning `Suggested comment:`. The viewer strips that line from the bubble and offers "Make it a draft comment".

**Pinning and the brief.** Any answer can be pinned. On Prepare run, "Draft from Ask" sends the chosen comments plus the conversation (pinned messages marked) to the model with this instruction: keep only decisions and constraints the owner settled on, ignore ideas that were raised and dropped, and write three short labelled parts: Decisions, Constraints, Open questions. The owner edits the result. The raw conversation is never sent to the agent, because it contains dead ends an agent could act on.

**Model access.** In production the API proxies to the Claude API with the owner's key held on the Mac mini, and streams tokens to the viewer. The mockup uses the claude.ai artifact runtime instead; that part does not carry over.

## Security and deployment

The system can start agents that run with full permissions on the owner's machine, so anything that can write a comment or dispatch a run can effectively execute code. Access control is the most important non-functional requirement.

- **Network.** Serve only on the Tailscale interface, never on 0.0.0.0 and never through a public tunnel. Cloudflare Quick Tunnels (no auth, public URL) are explicitly ruled out.
- **Auth.** Even inside the tailnet, require a session token set on first visit from the Mac mini itself, so a compromised device on the tailnet cannot dispatch runs.
- **Untrusted text.** Code, commit messages, patches and agent output are data. They may appear in the Ask context but must never become comments, rules or runs without the owner's explicit action.
- **Secrets.** The Claude API key stays on the Mac mini in the keychain or an environment file, never sent to the browser.
- **Isolation.** Agents run only in `strata/run-<N>` worktrees. Strata never pushes, merges or deletes branches; merging stays manual in v1.
- **Process.** One launchd service runs the API, worker and MCP server, restarts on failure, and logs to `~/.strata/logs`.
- **Install.** `pipx install strata`, `strata init <repo path>` (writes the hook and a starter `.strata.yml`), `strata serve`. Registering a repo backfills its history.

## Build plan

Build in this order and stop at milestone 3 for the one-week test before investing in metrics. Each milestone ends with its exit check.

1. **Snapshots from a real repo.** Generator with path-based ids, tree-sitter extraction, entity hashing, deps, calls, patches, repo config, SQLite store, post-commit hook, worktree worker, backfill. *Exit:* history of one of the owner's repos snapshotted; a new commit is snapshotted within 60 seconds.
2. **Viewer on live data.** API read endpoints and the viewer from the mockup, served over Tailscale with the session token; Time and Diff views, three levels, both lenses, Changes tab, patches. *Exit:* the owner can find every structural change and rule break of a real agent session from a phone.
3. **Comments and runs.** Draft comments with anchors, Prepare run, task preview, dispatch to `claude -p` and `codex exec`, commit trailers, MCP tools, run tracking, verify and reopen, flagged and unreported states. *Exit:* one full loop completed on real work: drafts sent, agent commits linked, comments verified.
4. **The one-week test.** Use milestones 1 to 3 for a week of normal agent work. *Exit:* the success test in the goals section; decide to continue or stop.
5. **Ask.** Context pack, streaming answers, suggested comments, pinning, brief drafting. *Exit:* a run's brief drafted from Ask and accepted with light edits.
6. **Metrics.** Complexity, then coverage per commit, then mutation testing on changed entities in the background, with pending states in the viewer. *Exit:* the Health lens distinguishes a hollow test from a real one on a known example.
7. **Hardening.** Rename tracking for anchors, a second language adapter, layout limits for 200+ module repos. *Exit:* comments survive a module move; a TypeScript repo renders.

Ask comes after the test on purpose: the test should measure whether seeing and steering help, before adding the most visible feature.

## Known limits and open questions

**Known limits, from building the prototype**

- Layouts strain beyond about 15 functions per module and 6 modules per layer; names truncate on a phone. A repo of a few hundred files needs grouping (sub-packages as an extra level) or search, not just smaller cards.
- Rule checking is only as good as the layer config. Repos without clear layers lose the strongest signal.
- Complexity alone turned cosmicpython almost entirely green (its most complex function scores 6). Health is weak until coverage and mutation run.
- Calls are tracked only within a module.
- The prototype identifies modules by file name; see the identity fix in the generator section.
- Agent attribution has not been tested on a real agent-committed repo.

**Open questions**

- Which repo is the first real target, and does it have layers worth encoding?
- Should runs start from the latest commit on main, or from the branch the owner is viewing?
- Where do agent branches go after verification: merged by the owner through GitHub, or merged locally?
- Should two runs for one repo ever run in parallel, for example on non-overlapping modules?
- For repos in more than one language (Python plus SQL and dbt), is a dbt adapter needed in v1? dbt's manifest already provides the model graph.

## Reference material in the zip

The zip `repo-strata-context.zip` holds everything built so far, meant to be read as context before building.

| Path | What it is | Use it for |
| --- | --- | --- |
| SPEC.md | this document as Markdown | context for a developer or a coding agent |
| README.md | what each file is and how to open or run it | orientation |
| mockup/repo-strata-sample.html | clickable mockup on sample data, with seeded comments and runs | the visual and interaction reference |
| mockup/repo-strata-cosmicpython.html | the same viewer on real snapshots of cosmicpython/code, data embedded | seeing real history; layout stress cases |
| generator/strata\_gen.py | prototype snapshot generator (Python ast, first-parent history) | the extraction logic to port to tree-sitter |
| data/cosmicpython-snapshots.json | the generator's output: 93 snapshots, 17 modules, 222 patches | a test fixture for the API and viewer |

Both HTML files open directly in a browser with no build step. Ask in the mockups only works inside claude.ai, because it uses the artifact runtime; everything else works offline.
