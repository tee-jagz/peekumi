# Tests

Automated tests check Git comparison accuracy, read-only access, authentication, language extraction and mobile interactions. Temporary fixture repositories exercise the engine; browser tests exercise the production Rust server at phone and desktop sizes.

Run `npm test`, `npm run test:rust` and `npm run test:browser` from the repository root. The `reference/` directory retains the previous Node implementation for equivalence checks. It is not the production backend.

Workflow integration tests use temporary Git repositories and a deterministic local agent that speaks the production stdio MCP protocol. `workflow-browser.mjs` completes draft → preview → dispatch → report → inspect → verify on phone and desktop. No real paid agent session runs in these tests.

Management/tunnel checks run with `node --test test/manage.test.mjs test/tunnel.test.mjs test/cloudflare.test.mjs`. They cover strict public-tunnel opt-in, CLI warning/pairing/cleanup, checksum verification and cache reuse, extraction errors, cancellation, startup/exit failures and Tailscale command compatibility. Downloads and tunnel processes are fixtures; no public tunnel or OS background service is started by these tests.
