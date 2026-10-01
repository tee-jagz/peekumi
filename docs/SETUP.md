# Set up Strata

Strata keeps its existing map and review workflow. One private server can inspect several local Git checkouts; agents still work in isolated worktrees. A connected browser has either owner access or read-only access to all registered repositories. Register only repos intended for those devices. Per-repository device permissions are not implemented yet.

## Ask your agent

“Set up Strata for these local repositories and make it accessible from my phone.” Give the agent this repository/distribution and `skills/strata-setup/SKILL.md`.

From source, Git, Rust and Node 22.13+ are needed to build:

```sh
npm ci
npm run build:rust
node scripts/manage.mjs install
```

The default installation is `~/.local/lib/strata`. Add its `bin` directory to PATH, or invoke the full path. The bundle includes the server, UI, Node, TypeScript and parser helpers. Git remains a host dependency. Python 3.9+ enables Python extraction; `strata doctor` reports missing parsers and optional tools. We retain the proven adapters rather than introducing a parser rewrite during packaging.

```sh
strata doctor
strata repo add /absolute/path/to/repo
strata repo add /absolute/path/to/another-repo
strata start
strata status
strata pair
```

Registration is idempotent. Repositories must contain a commit. The Repository selector appears in the existing comparison menu when multiple repos are registered. Switching repos reloads the page to isolate cached source, tasks and conversations; save unsent drafts first. State uses stable repository IDs, independent of list order. Adding/removing repos requires `strata restart`; removing a repo retains its private state.

`strata start` creates a per-user launchd service on macOS or a systemd user service on Linux. It starts at login. Linux users who need startup without logging in can explicitly enable lingering with their system administrator. The server binds to localhost. `strata stop` stops automatic startup until the next start. `strata logs` and `strata doctor` diagnose startup problems. Use `strata serve` for foreground operation.

## Phone access and PWA

Install and sign into Tailscale on the host and phone, then run:

```sh
strata share
strata pair
```

`share` configures private Tailscale Serve HTTPS, enables secure cookies, and restarts Strata. It never enables public Funnel. Tailscale may ask you to enable HTTPS for your tailnet. Review existing Serve configuration before assigning its default HTTPS endpoint to Strata. `strata pair` now prints the HTTPS pairing link. After pairing, install through the browser's “Add to Home Screen” / “Install app” action and keep Tailscale connected. The PWA does not run the backend or bypass network access requirements.

The service worker caches an explicit allowlist of application assets only. It never caches source, API responses or pairing tokens. When offline, reconnect to inspect code. Updates appear as a reload action; save unsent drafts before accepting. Browser memory and ordinary browser history are not a secure-erasure guarantee.

## Device access

```sh
strata pair --read-only
strata devices
strata devices revoke <id>
```

Owner sessions can Ask and dispatch tasks; read-only sessions cannot call those APIs or fetch new PR refs. Access is enforced on the server. Device tokens are stored hashed, expire after 30 days, and can be revoked individually. Pairing links remain reusable secrets; revoking a device does not invalidate a pairing link it retained. To rotate all access, stop the service, replace the relevant access-token file with a cryptographically random token, and start again. Rotating the owner token invalidates the saved session registry.

Tokens and config live under `~/.local/share/strata`, outside inspected repositories. `STRATA_HOME` selects another private state directory. Existing direct-binary `.strata` deployments remain compatible and are not migrated automatically. Back up the state directory while stopped; it contains comments, runs, worktrees and session hashes. Never publish it.

## Pull requests

Install GitHub CLI and run `gh auth login` on the host. In the comparison menu, choose Pull requests, then select an open PR. Strata fetches `refs/strata/pr/<number>/...`, verifies the fetched revision, and displays the complete merge-base-to-head diff in the existing canvas. The checkout and local branches are unchanged. Description, checks, conversation comments and review summaries appear in the comparison menu; the link opens the full review thread on GitHub.

GitHub credentials are managed by `gh`, not stored in Strata. This first integration supports github.com. Network/authentication failures are displayed with guidance. Ask uses the selected comparison; local comments remain local. Agent dispatch retains its existing explicitly previewed target branch; opening a PR does not silently retarget an agent. Inline GitHub review-thread syncing and publishing/merging are deferred.

## Updates and recovery

Build/download the next bundle, then stop Strata and run its `install` command to the same installation directory. Start with the installed command afterward. `upgrade` is an alias for installation from the current bundle, not an automatic internet downloader. Installation is staged before an atomic directory switch; the previous installation is retained beside it for rollback. State is retained; never replace the state directory with bundle files. Active runs prevent managed stops/upgrades.

Configuration and SQLite schemas are versioned. Existing unversioned workflow/cache schemas are upgraded without deleting records. Newer workflow schemas are refused rather than overwritten. Future migrations must preserve this rule and include fixtures for earlier versions. Keep a stopped-state backup before upgrading; older binaries may not understand a newer database.

## Release verification

The release workflow builds Linux and macOS bundles and runs tests. A generated artifact is not evidence of validation until that workflow passes. macOS background service and Linux systemd integration require their respective host environments. A second-person phone setup and one-week review trial remain release acceptance checks, not claims made by automated tests.
