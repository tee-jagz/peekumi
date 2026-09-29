# Repo Strata MVP

The owner wants to stay connected to the engineering behind agent implementations from a phone, moving between the whole repository and exact code details as needed.

## Visual and interaction contract

Use the original HTML mockup in `docs/context/repo-strata-context.zip` as the visual reference. Preserve its pastel background, frosted commit sheets, rounded hierarchy cards, curved dependency arrows, selection strip, and compact review panel. On a phone the map occupies the upper portion of a fixed viewport and the review panel scrolls below; at desktop widths the panel sits to the right.

Tap selects a card or dependency. A second tap or Open zooms into a card; breadcrumbs and the back chevron zoom out. Time stacks recent commit sheets and compares each commit with its first parent. Diff stacks base and head and supports Before/After. Use real packages and symbols; do not invent layers or health measurements. Large real-world maps use an SVG pan/zoom viewport, with readable labels at 1:1 and an optional Fit control. Changes only hides unchanged cards at each hierarchy level.

The first implementation uses Changes, Source, and Dependencies review tabs. Comments and Ask remain deferred. Structure replaces the unmeasured Health lens.

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

Ask, agent dispatch, comments, health scores, coverage, mutation testing, inferred architecture, cross-module call graphs, uncommitted work, persistent history indexing, and rename-aware symbol continuity.

## Acceptance

From a phone, identify changed areas in a real agent session, follow their dependencies, drill to exact source and diffs, and decide whether implementation needs steering. Test map accuracy against Git, not just rendered examples.
