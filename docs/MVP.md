# Peekumi MVP

The owner wants to keep in contact with the engineering of agent implementations from a phone. From the phone, the owner moves between the complete repository and the exact code details as necessary.

## Visual and interaction contract

Use the original HTML mockup in `docs/context/repo-strata-context.zip` as the visual reference. Keep the pastel background of the mockup. In light mode, the background colours are sky, peach, mint and sand. In dark mode, they are ocean, ember, pine and slate. Do not use purple. Also keep the frosted surfaces, the rounded hierarchy cards and the curved dependency arrows.

The approved update replaces the stacked commit sheets with one graph canvas and a review sheet that expands. On a phone, the map occupies the upper part of a fixed viewport, and the review panel scrolls below the map. At desktop widths, the panel is on the right side.

A tap selects a card or a dependency. A second tap, or the main action of the selection, zooms into a card. The Home and Up controls of the map zoom out.

Time shows a commit strip above the single graph canvas, and the strip scrolls horizontally. By default, Time and Diff compare each commit with its first parent. If you select a base manually, the base stays pinned when you change the commit or the view. The base stays pinned until “Use previous commit” restores automatic selection. The root commit compares with itself. Diff gives base/head revision selectors and Before/After, but it does not stack canvases or show a folder strip.

Use real packages and symbols. Do not invent layers or health measurements. Large real maps use an SVG pan/zoom viewport. The labels are readable at 1:1, and an optional Fit control is available. Changes only hides the unchanged cards at each hierarchy level.

The review sheet on the phone has three heights: peek, half and full. To change the height, drag or click the handle of the sheet, or use the arrow/Home/End keys. Peek shows the selection, its documentation summary and, where available, compact inputs/outputs. Peek does not show inspection controls. The expanded views give direct access to Details, Source, Changes, Relations and Discussion.

Ask/Comment is an independent composer. It stays available in every inspection view and at every sheet height. When you navigate, the unsent text keeps its original anchor and revision.

The review sheet and its controls are frosted glass. The text areas are more opaque and are readable. Controls are icons with accessible names and tooltips. The map key continues to use words.

Comments become frozen task previews, isolated agent runs, reports and owner verification. The preparation, progress and results are under the Tasks action, which is always in the header. Ask discusses the committed context, and its tools are disabled. Structure replaces the Health lens, which Peekumi does not measure.

## First usable slice

- Run a service next to a Git repository on macOS or Linux. Open its web UI with a URL.
- Browse the real directory hierarchy. Show the static import, call, implementation and inheritance relationships. Show the source evidence and the unresolved targets.
- Evaluate the versioned .peekumi.json dependency rules against the committed snapshots. Show the violations and the configuration errors.
- Compare two explicit commits. Show the added, changed and removed files in the rollup of their directories.
- Drill into Rust, Python and JavaScript/TypeScript symbols. Then drill into the source and the complete file diffs. Peekumi extracts the symbols from Svelte scripts. Svelte template changes stay visible at the file level.
- Show the README summaries of directories (or Python package docstrings) with revision provenance. Include links to the complete documentation. Show the adapter capabilities and limitations.
- When the user drills down into a file, load the module/class/function documentation from the code and the declaration metadata. Do not infer types or generate descriptions.
- Account for every tracked file, including tests, configuration, assets and unsupported languages. When Changes only is disabled, keep every tracked file visible.
- Support a phone viewport of 390 × 844, touch targets, Home and Up navigation, search and stable alphabetical positions.
- Protect source/API access with a local token and an authenticated session. For remote access, use a private network or an authenticated HTTPS reverse proxy.

Visalytics is the first integration target. It is a repository that contains both Python and Svelte/TypeScript code. Peekumi must not change its working directory.

## Deferred

These items are deferred:

- Automatic Ask brief generation
- Health scores
- Coverage
- Mutation testing
- Inferred architecture
- Compiler-backed call resolution and runtime dispatch
- Uncommitted work
- Persistent history indexing
- Rename-aware symbol continuity

## Acceptance

From a phone, do these steps in a real agent session:

1. Identify the changed areas.
2. Follow their dependencies.
3. Drill down to the exact source and diffs.
4. Decide if you must steer the implementation.

Test the accuracy of the map against Git. Do not test only against rendered examples.

## Review workflow

The authorized next slice is implemented as [WORKFLOW.md](WORKFLOW.md) describes. The slice contains anchored drafts, the exact task preview, Codex/Claude dispatch, scoped MCP reporting and owner verification. Inspection stays read-only. Dispatch creates a separate worktree.

The map key is with the floating zoom/fit controls on the canvas. The map key opens as an overlay and does not use a permanent content row. It contains the colour lens. Before/After floats over the map in Diff. When you drag the sheet, the inspection navigation becomes available at approximately half height.

The task UI shows human-readable updates, the reported checks and the review of changed files together. With one review note, task review can verify all the addressed comments. Task review does not merge or deploy the run branch. After approval, the owner can merge the task into the watched branch with a fast-forward, confirm it and undo it. Peekumi never pushes or deploys. Agent JSON and generated prompts are optional diagnostics.

Owners can change the viewed branch from the comparison line in the header. This is a read-only Git inspection. It does not change local edits or the checkout. A completed task offers Explore changes. Explore changes shows on the map all the work of the agent: it compares the agent branch with the commit where the task started. A ready cue shows on Tasks, and a Back to task chip restores the previous view.

By default, the comparison base stays the first parent of the selected commit, unless you pin a manual base.
