# Tests

Automated tests check the accuracy of Git comparisons, read-only access, authentication, language extraction and mobile interactions. Temporary fixture repositories are the test data for the engine. Browser tests check the production Rust server at phone and desktop sizes.

Run these commands from the repository root:

1. Run `npm test`.
2. Run `npm run test:rust`.
3. Run `npm run test:browser`.

The `reference/` directory keeps the previous Node implementation for equivalence checks. It is not the production backend.

Workflow integration tests use temporary Git repositories and a deterministic local agent. This agent uses the production stdio MCP protocol. `workflow-browser.mjs` completes draft → preview → dispatch → report → inspect → verify on phone and desktop. These tests do not run a real paid agent session.
