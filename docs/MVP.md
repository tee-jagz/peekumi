# Repo Strata MVP

The owner wants to stay connected to the engineering behind agent implementations from a phone, moving between the whole repository and exact code details as needed.

## First usable slice

- Run a service beside a Git repository on macOS or Linux and access its web UI by URL.
- Browse the real directory hierarchy, with static internal import relationships.
- Compare two explicit commits. Roll added, changed, and removed files up into their directories.
- Drill into Python and JavaScript/TypeScript symbols, then source and complete file diffs. Svelte script symbols are extracted; template changes remain visible at file level.
- Keep every tracked file visible, including tests, configuration, assets, and unsupported languages.
- Support a phone viewport of 390 × 844, touch targets, breadcrumbs, search, and stable alphabetical positioning.
- Protect source/API access with a local token and authenticated session. Use a private network or authenticated HTTPS reverse proxy for remote access.

Visalytics is the first integration target: a mixed Python and Svelte/TypeScript repository. Its working directory must remain untouched.

## Deferred

Ask, agent dispatch, comments, rules, health scores, coverage, mutation testing, inferred architecture, cross-module call graphs, uncommitted work, persistent history indexing, and rename-aware symbol continuity.

## Acceptance

From a phone, identify changed areas in a real agent session, follow their dependencies, drill to exact source and diffs, and decide whether implementation needs steering. Test map accuracy against Git, not just rendered examples.
