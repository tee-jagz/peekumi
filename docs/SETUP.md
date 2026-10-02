# Set up Strata

Strata keeps its existing map and review workflow. One private server can inspect several local Git checkouts; agents still work in isolated worktrees. A connected browser has either owner access or read-only access to all registered repositories. Register only repos intended for those devices. Per-repository device permissions are not implemented yet.

## Ask your agent

“Set up Strata for these local repositories and make it accessible from my phone.” Give the agent this repository/distribution and `skills/strata-setup/SKILL.md`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
```

The installer picks the release archive for your system, verifies its SHA-256 checksum, installs it to `~/.local/lib/strata` and links `strata` into `~/.local/bin`. If the checksum does not match, nothing is installed. Each archive carries the server, the interface, its own Node runtime, TypeScript and the parser helpers, so you do not need Node, Rust or a compiler.

You need Git. Python 3.9 or later is optional: with it, Strata reads Python declarations; without it, Python files appear as labelled file-level entries and `strata doctor` says why.

Release archives exist for:

| System | Archive |
| --- | --- |
| Linux x86_64 and ARM64 with glibc 2.34 or later (Ubuntu 22.04+, Debian 12+, RHEL 9+, Fedora 35+) | `linux-x64`, `linux-arm64` |
| macOS on Apple silicon and Intel | `darwin-arm64`, `darwin-x64` |

Alpine and other musl systems are not supported yet; build from source there. On macOS, installing with `curl` avoids the quarantine flag that a browser download would add to the unsigned binaries.

The installer reads these optional variables:

| Variable | Effect |
| --- | --- |
| `STRATA_VERSION` | Install a specific release tag, such as `v0.2.0`, instead of the latest |
| `STRATA_PREFIX` | Installation directory (default `~/.local/lib/strata`) |
| `STRATA_BIN` | Where to link `strata` (default `~/.local/bin`) |
| `STRATA_ARCHIVE` | Install a local archive instead of downloading; its `.sha256` file must sit beside it |
| `GITHUB_TOKEN` | Download from a private repository |

For example: `curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | STRATA_VERSION=v0.2.0 sh`. If `~/.local/bin` is not on your PATH, the installer prints the line to add.

### From source

Contributors and unsupported systems can build instead. You need Git, a stable Rust toolchain and Node 22.13 or later:

```sh
npm ci
npm run build:rust
node scripts/manage.mjs install
```

`install` and `upgrade` bundle the Node runtime that runs them, so use an official nodejs.org build of Node 22. Homebrew's Node depends on a shared library outside its binary; Strata refuses to bundle it and leaves the existing installation untouched. Add `~/.local/lib/strata/bin` to PATH, or invoke the full path. `node scripts/package.mjs` turns the same installation into a release archive with its checksum.

## First run

```sh
strata doctor
strata repo add /absolute/path/to/repo
strata repo add /absolute/path/to/another-repo
strata start
strata status
strata pair
```

Registration is idempotent. Repositories must contain a commit. The Repository selector appears in the existing comparison menu when multiple repos are registered. Switching repos reloads the page to isolate cached source, tasks and conversations; save unsent drafts first. State uses stable repository IDs, independent of list order. Adding/removing repos requires `strata restart`; removing a repo retains its private state.

`strata start` creates a per-user launchd service on macOS or a systemd user service on Linux. It starts at login. Linux users who need startup without logging in can explicitly enable lingering with their system administrator. The server binds to localhost. `strata stop` stops automatic startup until the next start. `strata logs` and `strata doctor` diagnose startup problems. Use `strata serve` for foreground operation. Containers and systems without a systemd user session (including WSL without systemd) cannot run the background service; `strata doctor` reports this, and `strata start` explains it. Run `strata serve` there, or under your own process manager.

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

Run the install command again to upgrade. It installs the latest release over the existing one and restarts the background service if it was running. `strata upgrade` is not an internet downloader: it installs the bundle it belongs to, which is how the installer and from-source builds use it. Installation is staged before an atomic directory switch; the previous installation is kept beside it (`strata.previous-<time>`) for rollback, and older backups are removed. State is retained; never replace the state directory with bundle files. Active runs prevent managed stops/upgrades.

Configuration and SQLite schemas are versioned. Existing unversioned workflow/cache schemas are upgraded without deleting records. Newer workflow schemas are refused rather than overwritten. Future migrations must preserve this rule and include fixtures for earlier versions. Keep a stopped-state backup before upgrading; older binaries may not understand a newer database.

## Release verification

The Distribution workflow builds, tests and packages each platform on every pull request. Each archive is then installed with `install.sh` and checked with `strata doctor`. Pushing a `v*` tag that matches `package.json` attaches the four archives and their checksums to a draft GitHub release, which a maintainer reviews and publishes. The Linux archives are built on Ubuntu 22.04 so they run on older glibc versions. A generated artifact is not evidence of validation until that workflow passes. macOS background service and Linux systemd integration require their respective host environments. A second-person phone setup and one-week review trial remain release acceptance checks, not claims made by automated tests.
