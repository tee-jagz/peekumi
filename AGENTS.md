# Repo Strata

Build a mobile-first repository map with coloured Git comparisons and drill-down to source. The product intent in docs/MVP.md supersedes the original broad specification.

- Keep the inspected repository read-only. Read committed objects through Git; never checkout, execute its code, or alter its hooks.
- Account for every tracked file. Unsupported, binary, oversized, and restricted files must remain visible and explicitly labelled.
- Use the actual directory hierarchy. Do not invent architectural layers.
- Import edges are static dependencies, not runtime call graphs.
- Never commit inspected repository source, snapshots, credentials, or local access tokens.
- Run npm test for engine/server changes and npm run test:browser for interface changes. Inspect mobile and desktop screenshots.
- Keep the first release focused on map, compare, navigation, and source. Agent orchestration and health scoring are deferred.
