# Tests

Automated tests check the accuracy of Git comparisons, read-only access, authentication, language extraction and mobile interactions. Temporary fixture repositories are the test data for the engine. Browser tests check the production Rust server at phone and desktop sizes.

Run these commands from the repository root:

1. Run `npm test`.
2. Run `npm run test:rust`.
3. Run `npm run test:browser`.

`ui.test.mjs` checks the rule that keeps the interface on the components. It adds new UI to a copy of `frontend/` and expects `scripts/lint-ui.mjs` to fail. It also renders every component and screen, and checks their accessible names and classes.

The `reference/` directory keeps the previous Node implementation for equivalence checks. It is not the production backend.

Workflow integration tests use temporary Git repositories and a deterministic local agent. This agent uses the production stdio MCP protocol. `workflow-browser.mjs` completes draft → preview → dispatch → report → inspect → verify on phone and desktop. These tests do not run a real paid agent session.

To run only the management and tunnel checks, run `node --test test/manage.test.mjs test/tunnel.test.mjs test/cloudflare.test.mjs`. These checks cover:

- The strict opt-in for a public tunnel.
- The warning, the pairing link and the cleanup of the command.
- The checksum check, the reuse of the cache, extraction errors, cancellation, and failures at startup or at exit.
- Compatibility with the Tailscale commands.

For a Tailscale failure, the checks make sure that the command shows the original cause, the recovery steps and the public opt-in command. They also make sure that the command exits with a non-zero code and does not change the saved state. This is true for the default selection and for the explicit selection. The downloads and the tunnel processes are fixtures. These tests do not start a public tunnel or an OS background service.

## Write a browser test

A browser test starts the real Rust server on a temporary repository, opens it in Chromium with Playwright, and acts as a user does. Use `test/navigation-browser.mjs` as an example.

1. Make a file `test/<subject>-browser.mjs`, and add `node test/<subject>-browser.mjs` to the `test:browser` script in `package.json`.
2. Make a repository with `fixture({ files })` from `workflow-support.mjs`. It holds `module.py` and your files in one commit. It returns:
   - `server.url` and `server.token`: open `server.url + "/#token=" + server.token` to pair the page.
   - `req(route, body)`: an owner API call, for example to make an instruction or start a task.
   - `git(...)`: Git in the repository, for a second commit or a branch.
   - `close()`: stops the server and removes the folders. Call it in `finally`.
3. Test at a phone size (`390 × 844`) and a desktop size (`1366 × 768`). Use `reducedMotion: "reduce"` unless the test is about motion.
4. Find elements by their role and their name (`getByRole("button", { name: "Approve" })`) or by a stable `data-` attribute, not by their position.
5. Wait for a state (`locator.waitFor()`, `page.waitForFunction()`, or `waitFor()` from `workflow-support.mjs`), not for a fixed time.
6. Collect `pageerror` events, and check at the end that there are none.
7. Write screenshots to `test-results/`, and look at them for an interface change.

The fake agent (`workflow-fixture.mjs`) acts as both Claude Code and Codex. It reads the task text and does fixed work, with no network. Words in the task change what it does:

| Word in the task | What the fake agent does |
|---|---|
| `WAIT_FOR_STOP` | A session turn works until the owner stops it. |
| `FOCUS` | A session agent reads a file, runs a command on it and adds a file, so the map can show where it works. |
| `WAIT_FOR_CANCEL` (as the task brief) | A task works until the owner cancels it. |
| `FOCUS_TASK` (as the task brief) | A task reads a file and then works for a while. |

Never start a real, paid agent in a test.
