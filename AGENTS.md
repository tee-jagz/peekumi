# Repo Strata

Build a mobile-first repository map with coloured Git comparisons and drill-down to source. The product intent in docs/MVP.md defines scope. The HTML mockup in docs/context/repo-strata-context.zip is the authoritative visual and interaction reference: preserve its glass commit deck, curved dependency lines, zoom drill-down, and stage/review-panel layout. Do not substitute a dashboard or file-card explorer.

- Keep the inspected repository read-only. Read committed objects through Git; never checkout, execute its code, or alter its hooks.
- Account for every tracked file. Unsupported, binary, oversized, and restricted files must remain visible and explicitly labelled.
- Use the actual directory hierarchy. Do not invent architectural layers.
- Typed import, call, implementation and inheritance edges describe static declarations, not runtime execution. Unresolved or ambiguous targets must remain explicit.
- Never commit inspected repository source, snapshots, credentials, or local access tokens.
- Run npm test for engine/server changes and npm run test:browser for interface changes. Inspect mobile and desktop screenshots.
- Keep the first release focused on map, compare, navigation, and source. Agent orchestration and health scoring are deferred.

- Keep production module and API documentation readable in Strata: Rust `//!` and `///`, JavaScript `@module` and JSDoc, and Python docstrings. Explain responsibility and meaningful inputs, outputs, errors and side effects; keep directory READMEs aligned with the implementation.
