# Peekumi

Build a mobile-first repository map with coloured Git comparisons and drill-down to source. The product intent in docs/MVP.md defines scope. The HTML mockup in docs/context/repo-strata-context.zip is the authoritative visual and interaction reference: preserve its glass surfaces, curved dependency lines and zoom drill-down. The approved mobile update uses a single SVG graph canvas, a peek/half/full review sheet, and an independent Ask/Comment composer. Commit mini cards appear only in Time mode; do not add a folder strip or stacked canvases. Do not substitute a dashboard or file-card explorer.

- Keep repository inspection read-only. Explicit owner dispatch may create a dedicated agent worktree and run the selected agent there; never switch or edit the inspected checkout, push, merge, or alter hooks.
- Account for every tracked file. Unsupported, binary, oversized, and restricted files must remain visible and explicitly labelled.
- Use the actual directory hierarchy. Do not invent architectural layers.
- Typed import, call, implementation and inheritance edges describe static declarations, not runtime execution. Unresolved or ambiguous targets must remain explicit.
- Never commit inspected repository source, snapshots, credentials, or local access tokens.
- Run npm test for engine/server changes and npm run test:browser for interface changes. Inspect mobile and desktop screenshots.
- The next authorized slice includes anchored comments, frozen task previews, isolated agent runs, reports and owner verification. Contextual Ask is now authorized with read-only repository lookups at the compared revisions only; it cannot run code, change files or state, or dispatch work. Health scoring remains deferred.

- Keep production module and API documentation readable in Peekumi: Rust `//!` and `///`, JavaScript `@module` and JSDoc, and Python docstrings. Explain responsibility and meaningful inputs, outputs, errors and side effects; keep directory READMEs aligned with the implementation.
- Write all documentation that people read (the root README, docs/, directory READMEs and skills) in ASD-STE100 Simplified Technical English: short sentences, one instruction per sentence, active voice, simple tenses and approved words. Keep commands, paths, API routes and interface labels exactly as they are.
