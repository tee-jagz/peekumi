# Tests

Automated tests check the accuracy of Git comparisons, read-only access, authentication, language extraction and mobile interactions. Temporary fixture repositories are the test data for the engine. Browser tests check the production Rust server at phone and desktop sizes.

Run these commands from the repository root:

1. Run `npm test`.
2. Run `npm run test:rust`.
3. Run `npm run test:browser`.

The `reference/` directory keeps the previous Node implementation for equivalence checks. It is not the production backend.

Workflow integration tests use temporary Git repositories and a deterministic local agent. This agent uses the production stdio MCP protocol. `workflow-browser.mjs` completes draft → preview → dispatch → report → inspect → verify on phone and desktop. These tests do not run a real paid agent session.

To run only the management and tunnel checks, run `node --test test/manage.test.mjs test/tunnel.test.mjs test/cloudflare.test.mjs`. These checks cover:

- The strict opt-in for a public tunnel.
- The warning, the pairing link and the cleanup of the command.
- The checksum check, the reuse of the cache, extraction errors, cancellation, and failures at startup or at exit.
- Compatibility with the Tailscale commands.

For a Tailscale failure, the checks make sure that the command shows the original cause, the recovery steps and the public opt-in command. They also make sure that the command exits with a non-zero code and does not change the saved state. This is true for the default selection and for the explicit selection. The downloads and the tunnel processes are fixtures. These tests do not start a public tunnel or an OS background service.
