# Tests

Automated tests check Git comparison accuracy, read-only access, authentication, language extraction and mobile interactions. Temporary fixture repositories exercise the engine; browser tests exercise the production Rust server at phone and desktop sizes.

Run `npm test`, `npm run test:rust` and `npm run test:browser` from the repository root. The `reference/` directory retains the previous Node implementation for equivalence checks. It is not the production backend.

Workflow integration tests use temporary Git repositories and a deterministic local agent that speaks the production stdio MCP protocol. `workflow-browser.mjs` completes draft → preview → dispatch → report → inspect → verify on phone and desktop. No real paid agent session runs in these tests.
