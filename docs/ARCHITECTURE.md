# Architecture

The first release has three parts:

1. `src/engine.mjs` reads Git trees and blobs, extracts symbols, resolves static imports, and compares snapshots. It caches by immutable commit SHA. Git supplies file identity and complete file diffs; symbol hashes are supplemental information.
2. `src/server.mjs` serves static assets and a token-protected, read-only API. It accepts a single configured repository path and starts no agents or repository code.
3. `public/` is a dependency-free browser UI. Its styling is derived directly from the supplied HTML mockup. `public/model.js` aggregates file changes into hierarchy cards and import edges into connections at the current depth. The renderer places them in stacked commit sheets, supports selection and zoom navigation, and fetches full source only when a file is opened. The frontend caches six comparisons and twelve opened source files to avoid repeated transfers.

`src/python_ast.py` receives source strings through stdin. It parses them without importing or executing them. The TypeScript compiler runs inside the Node process. Failed parsers produce explicit file-level fallbacks.

## API

- `POST /api/session`: exchange an access token for a session cookie.
- `GET /api/repo`: repository name, branch, recent commits, initial revisions.
- `GET /api/compare?base=&head=`: files, statuses, symbols, and import edges for two commits.
- `GET /api/source?base=&head=&path=`: before and after source plus a direct file diff.

All API endpoints except session creation require a valid session or bearer token. No CORS access is granted. Cross-origin session creation is rejected. The browser renders repository text with `textContent`.

## Boundaries

The inspected repository is read-only. No working-tree traversal is used for source extraction, so symlinks are not followed. Git diffs disable external diff drivers and text conversion. The host runtime and its Git installation are trusted.

The hierarchy is physical structure. Static import dependencies do not prove runtime coupling or architectural quality. This release makes no health claims.
