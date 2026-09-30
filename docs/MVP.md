# Repo Strata MVP

The owner wants to stay connected to the engineering behind agent implementations from a phone, moving between the whole repository and exact code details as needed.

## Visual and interaction contract

Use the original HTML mockup in `docs/context/repo-strata-context.zip` as the visual reference. Preserve its pastel background, frosted surfaces, rounded hierarchy cards and curved dependency arrows. The approved update replaces stacked commit sheets with one graph canvas and an expandable review sheet. On a phone the map occupies the upper portion of a fixed viewport and the review panel scrolls below; at desktop widths the panel sits to the right.

Tap selects a card or dependency. A second tap or Open zooms into a card; breadcrumbs and the back chevron zoom out. Time shows a horizontally scrollable commit strip above the single graph canvas and defaults to comparing each commit with its first parent, as does Diff. A manually selected base stays pinned across commit changes and view switches until “Use previous commit” restores automatic selection. The root commit compares with itself. Diff provides base/head revision selectors and Before/After; it does not stack canvases or show a folder strip. Use real packages and symbols; do not invent layers or health measurements. Large real-world maps use an SVG pan/zoom viewport, with readable labels at 1:1 and an optional Fit control. Changes only hides unchanged cards at each hierarchy level.

The phone review sheet has peek, half and full heights, controlled by dragging its handle, clicking it, or using arrow/Home/End keys. Peek shows the selection and its documentation summary; expanded views offer Details, Source, Changes, Relations and Discussion directly. Ask/Comment is an independent, persistent composer in every inspection view and sheet height. Unsent text retains its original anchor and revision while navigating. Controls share glass surfaces with readable, more opaque text areas. Comments become frozen task previews, isolated agent runs, reports and owner verification; preparation and progress live under Comment → Discussion → View runs. Ask discusses committed context with tools disabled. Structure replaces the unmeasured Health lens.

## First usable slice

- Run a service beside a Git repository on macOS or Linux and access its web UI by URL.
- Browse the real directory hierarchy, with static import, call, implementation and inheritance relationships. Show source evidence and unresolved targets.
- Evaluate versioned .strata.json dependency rules against committed snapshots and show violations and configuration errors.
- Compare two explicit commits. Roll added, changed, and removed files up into their directories.
- Drill into Rust, Python and JavaScript/TypeScript symbols, then source and complete file diffs. Svelte script symbols are extracted; template changes remain visible at file level.
- Show directory README summaries (or Python package docstrings) with revision provenance and links to the complete documentation. Expose adapter capabilities and limitations.
- Load code-authored module/class/function documentation and declaration metadata on file drill-down, without inferred types or generated descriptions.
- Keep every tracked file accounted for (and visible with Changes only disabled), including tests, configuration, assets, and unsupported languages.
- Support a phone viewport of 390 × 844, touch targets, breadcrumbs, search, and stable alphabetical positioning.
- Protect source/API access with a local token and authenticated session. Use a private network or authenticated HTTPS reverse proxy for remote access.

Visalytics is the first integration target: a mixed Python and Svelte/TypeScript repository. Its working directory must remain untouched.

## Deferred

Automatic Ask brief generation, health scores, coverage, mutation testing, inferred architecture, compiler-backed call resolution and runtime dispatch, uncommitted work, persistent history indexing, and rename-aware symbol continuity.

## Acceptance

From a phone, identify changed areas in a real agent session, follow their dependencies, drill to exact source and diffs, and decide whether implementation needs steering. Test map accuracy against Git, not just rendered examples.

## Review workflow

The authorized next slice is implemented in [WORKFLOW.md](WORKFLOW.md): anchored drafts, exact task preview, Codex/Claude dispatch, scoped MCP reporting, and owner verification. Inspection stays read-only; dispatch creates a separate worktree.
