# Set up Peekumi

Peekumi keeps its existing map and review workflow. One private server can inspect several local Git checkouts; agents still work in isolated worktrees. A connected browser has either owner access or read-only access to all registered repositories. Register only repos intended for those devices. Per-repository device permissions are not implemented yet.

## Ask your agent

“Set up Peekumi for these local repositories and make it accessible from my phone.” Give the agent this repository/distribution and `skills/peekumi-setup/SKILL.md`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
```

The installer picks the release archive for your system, verifies its SHA-256 checksum, installs it to `~/.local/lib/peekumi` and links `peekumi` into `~/.local/bin`. If the checksum does not match, nothing is installed. Each archive carries the server, the interface, its own Node runtime, TypeScript and the parser helpers, so you do not need Node, Rust or a compiler.

You need Git. Python 3.9 or later is optional: with it, Peekumi reads Python declarations; without it, Python files appear as labelled file-level entries and `peekumi doctor` says why.

Release archives exist for:

| System | Archive |
| --- | --- |
| Linux x86_64 and ARM64 with glibc 2.34 or later (Ubuntu 22.04+, Debian 12+, RHEL 9+, Fedora 35+) | `linux-x64`, `linux-arm64` |
| macOS on Apple silicon and Intel | `darwin-arm64`, `darwin-x64` |

Alpine and other musl systems are not supported yet; build from source there. On macOS, installing with `curl` avoids the quarantine flag that a browser download would add to the unsigned binaries.

The installer reads these optional variables:

| Variable | Effect |
| --- | --- |
| `PEEKUMI_VERSION` | Install a specific release tag, such as `v0.2.0`, instead of the latest |
| `PEEKUMI_PREFIX` | Installation directory (default `~/.local/lib/peekumi`) |
| `PEEKUMI_BIN` | Where to link `peekumi` (default `~/.local/bin`) |
| `PEEKUMI_ARCHIVE` | Install a local archive instead of downloading; its `.sha256` file must sit beside it |
| `GITHUB_TOKEN` | Download from a private repository |

For example: `curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | PEEKUMI_VERSION=v0.2.0 sh`. If `~/.local/bin` is not on your PATH, the installer prints the line to add.

### From source

Contributors and unsupported systems can build instead. You need Git, a stable Rust toolchain and Node 22.13 or later:

```sh
npm ci
npm run build:rust
node scripts/manage.mjs install
```

`install` and `upgrade` bundle the Node runtime that runs them, so use an official nodejs.org build of Node 22. Homebrew's Node depends on a shared library outside its binary; Peekumi refuses to bundle it and leaves the existing installation untouched. Add `~/.local/lib/peekumi/bin` to PATH, or invoke the full path. `node scripts/package.mjs` turns the same installation into a release archive with its checksum.

## First run

```sh
peekumi doctor
peekumi repo add /absolute/path/to/repo
peekumi repo add /absolute/path/to/another-repo
peekumi start
peekumi status
peekumi pair
```

Registration is idempotent. Repositories must contain a commit. The Repository selector appears in the existing comparison menu when multiple repos are registered. Switching repos reloads the page to isolate cached source, tasks and conversations; save unsent drafts first. State uses stable repository IDs, independent of list order. Adding/removing repos requires `peekumi restart`; removing a repo retains its private state.

`peekumi start` creates a per-user launchd service on macOS or a systemd user service on Linux. It starts at login. Linux users who need startup without logging in can explicitly enable lingering with their system administrator. The server binds to localhost. `peekumi stop` stops automatic startup until the next start. `peekumi logs` and `peekumi doctor` diagnose startup problems. Use `peekumi serve` for foreground operation. Containers and systems without a systemd user session (including WSL without systemd) cannot run the background service; `peekumi doctor` reports this, and `peekumi start` explains it. Run `peekumi serve` there, or under your own process manager.

## Phone access and PWA

Install and sign into Tailscale on the host and phone, then run:

```sh
peekumi share
peekumi pair
```

`share` configures private Tailscale Serve HTTPS, enables secure cookies, and restarts Peekumi. It never enables public Funnel. Tailscale may ask you to enable HTTPS for your tailnet. Review existing Serve configuration before assigning its default HTTPS endpoint to Peekumi. `peekumi pair` now prints the HTTPS pairing link. After pairing, install through the browser's “Add to Home Screen” / “Install app” action and keep Tailscale connected. The PWA does not run the backend or bypass network access requirements.

### Optional public Cloudflare tunnel

For temporary phone access without Tailscale, explicitly run:

```sh
peekumi share --tunnel cloudflare
```

**The URL is public and reachable from the internet.** Traffic passes through Cloudflare. Peekumi still requires device pairing; keep the printed pairing link private because it grants owner access to all registered repositories. The command warns before downloading or exposing the service. Plain `peekumi share` (or `--tunnel tailscale`) continues to use private Tailscale; no environment setting or saved preference enables Cloudflare.

On first opt-in, Peekumi downloads pinned `cloudflared` 2026.9.3 from Cloudflare's official GitHub release and verifies its SHA-256 digest before extracting or running it. It supports the same four macOS/Linux architectures as Peekumi's distribution. Downloads are cached under the private state directory's `tunnel/` folder and reverified on reuse. A mismatched checksum stops sharing without executing the download; remove the indicated cached artifact and explicitly retry if the cache is damaged. No system installation, Cloudflare account or login is needed. Existing cloudflared configuration is left alone, and automatic binary updates are disabled.

The command enables secure cookies and restarts Peekumi if necessary, then prints the temporary HTTPS URL and its pairing link. Open that printed link on your phone and keep the command running. Ctrl+C closes the tunnel; each new run gets a new hostname. The hostname is not saved, and `peekumi pair` continues to use the existing permanent URL. Closing the tunnel leaves Peekumi running with secure cookies enabled. The download remains cached; a later `start`, `restart` or `doctor` does not launch Cloudflare.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are intended for testing and development, have no uptime guarantee, allow at most 200 in-flight requests and do not support Server-Sent Events. Use Tailscale for ongoing phone access and a stable PWA address.

The service worker caches an explicit allowlist of application assets only. It never caches source, API responses or pairing tokens. When offline, reconnect to inspect code. Updates appear as a reload action; save unsent drafts before accepting. Browser memory and ordinary browser history are not a secure-erasure guarantee.

## Device access

```sh
peekumi pair --read-only
peekumi devices
peekumi devices revoke <id>
```

Owner sessions can Ask and dispatch tasks; read-only sessions cannot call those APIs or fetch new PR refs. Access is enforced on the server. Device tokens are stored hashed, expire after 30 days, and can be revoked individually. Pairing links remain reusable secrets; revoking a device does not invalidate a pairing link it retained. To rotate all access, stop the service, replace the relevant access-token file with a cryptographically random token, and start again. Rotating the owner token invalidates the saved session registry.

Tokens and config live under `~/.local/share/peekumi`, outside inspected repositories. `PEEKUMI_HOME` selects another private state directory. Existing direct-binary `.peekumi` deployments remain compatible and are not migrated automatically. Back up the state directory while stopped; it contains comments, runs, worktrees and session hashes. Never publish it.

## Pull requests

Install GitHub CLI and run `gh auth login` on the host. In the comparison menu, choose Pull requests, then select an open PR. Peekumi fetches `refs/peekumi/pr/<number>/...`, verifies the fetched revision, and displays the complete merge-base-to-head diff in the existing canvas. The checkout and local branches are unchanged. Description, checks, conversation comments and review summaries appear in the comparison menu; the link opens the full review thread on GitHub.

GitHub credentials are managed by `gh`, not stored in Peekumi. This first integration supports github.com. Network/authentication failures are displayed with guidance. Ask uses the selected comparison; local comments remain local. Agent dispatch retains its existing explicitly previewed target branch; opening a PR does not silently retarget an agent. Inline GitHub review-thread syncing and publishing/merging are deferred.

## Renamed from Strata

Peekumi was called Repo Strata until October 2026. Everything from before the rename keeps working:

- The `strata` command is an alias for `peekumi`; the installer links both.
- `STRATA_*` settings are read whenever the matching `PEEKUMI_*` setting is unset, so `STRATA_HOME` still selects the state folder.
- An existing `~/.local/share/strata` is used where it is, and `peekumi start` moves it to `~/.local/share/peekumi` the next time the service starts from a stopped state. A state folder chosen with `PEEKUMI_HOME` or `STRATA_HOME` is never moved.
- Starting or stopping replaces the background service registered under its former name, so it does not return at login.
- Repositories with dependency rules in `.strata.json` keep them; `.peekumi.json` is preferred when both exist.
- Paired phones stay paired, and agent runs started before the rename can still be verified.

## Updates and recovery

Run the install command again to upgrade. It installs the latest release over the existing one and restarts the background service if it was running. `peekumi upgrade` is not an internet downloader: it installs the bundle it belongs to, which is how the installer and from-source builds use it. Installation is staged before an atomic directory switch; the previous installation is kept beside it (`peekumi.previous-<time>`) for rollback, and older backups are removed. State is retained; never replace the state directory with bundle files. Active runs prevent managed stops/upgrades.

Configuration and SQLite schemas are versioned. Existing unversioned workflow/cache schemas are upgraded without deleting records. Newer workflow schemas are refused rather than overwritten. Future migrations must preserve this rule and include fixtures for earlier versions. Keep a stopped-state backup before upgrading; older binaries may not understand a newer database.

## Release verification

The Distribution workflow builds, tests and packages each platform on every pull request. Each archive is then installed with `install.sh` and checked with `peekumi doctor`. Pushing a `v*` tag that matches `package.json` attaches the four archives and their checksums to a draft GitHub release, which a maintainer reviews and publishes. The Linux archives are built on Ubuntu 22.04 so they run on older glibc versions. A generated artifact is not evidence of validation until that workflow passes. macOS background service and Linux systemd integration require their respective host environments. A second-person phone setup and one-week review trial remain release acceptance checks, not claims made by automated tests.
