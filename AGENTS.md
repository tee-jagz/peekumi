# Peekumi

Mobile-first Git repository map with coloured comparisons, static relationships, dependency rules, contextual Ask, isolated agent runs/sessions, and sandboxed verification.

## Visual & UI conventions
- Follow the component library and tokens in `frontend/ui.js`, `frontend/ui.css`, and `docs/design/` (`docs/context/repo-strata-context.zip` is historical reference only).
- Keep the single SVG graph canvas, peek/half/full review sheet, and independent Ask/Instruction/Session composer. Commit mini cards appear only in Time mode; do not add a folder strip, stacked canvases, or a file-card dashboard.
- Build new interface elements from `frontend/ui.js` rather than raw DOM/inline styles outside the component modules. `npm run lint` runs `scripts/lint-ui.mjs` to block new UI debt (`node scripts/lint-ui.mjs --update` tightens `scripts/ui-baseline.json` when old UI is migrated).

## Core invariants
- **Read-only inspection:** The map, relationships, rules, and Ask never execute repository code or modify the inspected checkout.
- **Honest accounting:** Every tracked file stays visible on the map, with explicit labels for unsupported, binary, oversized, or restricted files. Use the real directory hierarchy; do not invent layers.
- **Static relationships:** Import, call, implementation, and inheritance edges come from static declarations, not runtime execution. Keep unresolved and ambiguous targets explicit.
- **Isolated execution:** Task runs and multi-turn Sessions run in dedicated worktrees on `peekumi/*` branches. Verification runs execute configured checks in an OS sandbox against a `git archive` copy of one commit; CRAP scores come only from sandboxed coverage runs at that commit and show their source and limits.
- **Explicit owner writes:** Fast-forward merges (with undo) and committing blocking owner files happen only on explicit owner confirmation. Never switch the inspected checkout to another branch, push, alter Git hooks, or commit inspected repository source, snapshots, credentials, or local tokens.

## Development & commits
- Run `npm test` and `npm run test:rust` for engine/server changes, and `npm run test:browser` for UI changes (inspect mobile and desktop screenshots).
- Run `npm run format` and `npm run lint` before committing.
- Keep module/API doc comments (`//!`/`///`, `@module`/JSDoc, Python docstrings) and directory READMEs accurate and concise.
- Use the `Peekumi-Agent` commit trailer; do not add a `Co-Authored-By` line.
