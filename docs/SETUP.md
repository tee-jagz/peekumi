# Set up Peekumi

Peekumi keeps its current map and review workflow. One private server can examine several local Git checkouts. Agents continue to work in isolated worktrees. A connected browser has owner access or read-only access to all registered repositories. Register only the repos that are for those devices. Device permissions for each repository are not available yet.

## Ask your agent

“Set up Peekumi for these local repositories and make it accessible from my phone.” Give the agent this repository/distribution and `skills/peekumi-setup/SKILL.md`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
```

The installer selects the release archive for your system and does a check of its SHA-256 checksum. Then it installs the archive to `~/.local/lib/peekumi` and links `peekumi` into `~/.local/bin`. If the checksum is not correct, the installer installs nothing. Each archive contains the server, the interface, its own Node runtime, TypeScript and the parser helpers. Thus, Node, Rust and a compiler are not necessary.

Git is necessary. Python 3.9 or later is optional. If Python is available, Peekumi reads Python declarations. If Python is not available, Python files show as labelled file-level entries, and `peekumi doctor` gives the reason.

Release archives are available for these systems:

| System | Archive |
| --- | --- |
| Linux x86_64 and ARM64 with glibc 2.34 or later (Ubuntu 22.04+, Debian 12+, RHEL 9+, Fedora 35+) | `linux-x64`, `linux-arm64` |
| macOS on Apple silicon and Intel | `darwin-arm64`, `darwin-x64` |

Peekumi does not support Alpine and other musl systems yet. On these systems, build from source. On macOS, an installation with `curl` prevents the quarantine flag that a browser download adds to the unsigned binaries.

The installer reads these optional variables:

| Variable | Effect |
| --- | --- |
| `PEEKUMI_VERSION` | Installs a specific release tag, for example `v0.2.0`, instead of the latest release |
| `PEEKUMI_PREFIX` | The installation directory (default `~/.local/lib/peekumi`) |
| `PEEKUMI_BIN` | The directory where the installer links `peekumi` (default `~/.local/bin`) |
| `PEEKUMI_ARCHIVE` | Installs a local archive and does not download an archive. The `.sha256` file of the archive must be next to it |
| `GITHUB_TOKEN` | Lets the installer download from a private repository |

For example: `curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | PEEKUMI_VERSION=v0.2.0 sh`. If `~/.local/bin` is not on your PATH, the installer prints the line that you must add.

### From source

Contributors can build from source instead, and you can also do this on unsupported systems. You must have Git, a stable Rust toolchain and Node 22.13 or later:

```sh
npm ci
npm run build:rust
node scripts/manage.mjs install
```

`install` and `upgrade` bundle the Node runtime that runs them. Thus, use an official nodejs.org build of Node 22. The Homebrew Node must have a shared library that is outside its binary. Peekumi does not bundle this Node, and it does not change the current installation. Add `~/.local/lib/peekumi/bin` to PATH, or use the full path. `node scripts/package.mjs` makes a release archive and its checksum from the same installation.

## First run

```sh
peekumi doctor
peekumi repo add /absolute/path/to/repo
peekumi repo add /absolute/path/to/another-repo
peekumi start
peekumi status
peekumi pair
```

Registration is idempotent. Each repository must contain a commit. When more than one repo is registered, the Repository selector shows in the current comparison menu. When you change to a different repo, the page loads again to isolate the cached source, tasks and conversations. Save unsent drafts before you change repos. State uses stable repository IDs that do not depend on the list order.

A service that runs applies `repo add` and `repo remove` immediately. It does not restart, and the other repos do not change. Only the owner access token can change the set of repos. The `peekumi` command reads this token from the private state folder. Paired phones and browsers cannot change the set.

The first registered repo is the exception: if you remove it, the change occurs at the next `peekumi restart`. You cannot remove a repo that has an active agent run until the run is complete. When you remove a repo, Peekumi keeps its private state.

`peekumi start` creates a per-user launchd service on macOS or a systemd user service on Linux. The service starts at login. On Linux, if the service must start without a login, users can explicitly enable lingering with their system administrator. The server binds to localhost. `peekumi stop` stops automatic startup until the next start. `peekumi logs` and `peekumi doctor` help you find the cause of startup problems.

Use `peekumi serve` for foreground operation. Containers cannot run the background service. Systems without a systemd user session (this includes WSL without systemd) also cannot run it. `peekumi doctor` reports this, and `peekumi start` explains it. On these systems, run `peekumi serve` or use your own process manager to run it.

## Phone access and PWA

Install Tailscale on the host and on the phone. Sign in to Tailscale on the two devices. Then run these commands:

```sh
peekumi share
peekumi pair
```

`share` configures private Tailscale Serve HTTPS, enables secure cookies and restarts Peekumi. It never enables public Funnel. Tailscale can ask you to enable HTTPS for your tailnet. Before you give the default HTTPS endpoint of Serve to Peekumi, examine the current Serve configuration. After this, `peekumi pair` prints the HTTPS pairing link.

After you pair the phone, install the app with the browser action “Add to Home Screen” / “Install app”. Keep Tailscale connected. The PWA does not run the backend, and the network access requirements do not change.

The service worker caches only an explicit allowlist of application assets. It never caches source, API responses or pairing tokens. If you are offline, connect again to examine code. An update shows as a reload action. Save unsent drafts before you accept the update. Browser memory and usual browser history are not a guarantee of secure erasure.

## Device access

```sh
peekumi pair --read-only
peekumi devices
peekumi devices revoke <id>
```

An owner session can use Ask and dispatch tasks. A read-only session cannot call those APIs or fetch new PR refs. The server enforces access. Peekumi keeps device tokens as hashes. A device token expires after 30 days, and you can revoke each device token separately. Pairing links stay reusable secrets: if you revoke a device, a pairing link that the device kept stays valid.

To rotate all access, do these steps:

1. Stop the service.
2. Replace the related access-token file with a cryptographically random token.
3. Start the service again.

If you rotate the owner token, the saved session registry becomes invalid.

Tokens and config are under `~/.local/share/peekumi`, outside the repositories that Peekumi examines. `PEEKUMI_HOME` selects a different private state directory. Current direct-binary `.peekumi` deployments stay compatible, and Peekumi does not migrate them automatically.

Make a backup of the state directory while the service is stopped. The state directory contains comments, runs, worktrees and session hashes. Never publish it.

## Pull requests

1. Install GitHub CLI on the host.
2. Run `gh auth login` on the host.
3. In the comparison menu, select Pull requests.
4. Select an open PR.

Peekumi fetches `refs/peekumi/pr/<number>/...` and does a check of the fetched revision. Then it shows the complete merge-base-to-head diff in the current canvas. The checkout and the local branches do not change. The comparison menu shows the description, checks, conversation comments and review summaries. The link opens the full review thread on GitHub.

`gh` manages the GitHub credentials, and Peekumi does not keep them. This first integration supports github.com. Peekumi shows network/authentication failures with guidance. Ask uses the selected comparison, and local comments stay local. Agent dispatch keeps its current target branch, which you explicitly previewed. When you open a PR, Peekumi does not silently retarget an agent.

Inline sync of GitHub review threads and the publish/merge functions are deferred.

## Renamed from Strata

The name of Peekumi was Repo Strata until October 2026. All items from before the rename continue to operate:

- The `strata` command is an alias for `peekumi`. The installer links the two commands.
- If a `PEEKUMI_*` setting is not set, Peekumi reads the `STRATA_*` setting with the same name. Thus, `STRATA_HOME` continues to select the state folder.
- Peekumi uses a current `~/.local/share/strata` folder in its current location. The next time that the service starts from a stopped state, `peekumi start` moves the folder to `~/.local/share/peekumi`. Peekumi never moves a state folder that you select with `PEEKUMI_HOME` or `STRATA_HOME`.
- A start or a stop replaces the background service that has the former name. Thus, the former service does not return at login.
- Repositories that have dependency rules in `.strata.json` keep these rules. If the two files exist, Peekumi uses `.peekumi.json`.
- Paired phones stay paired. You can still verify agent runs that started before the rename.

## Updates and recovery

To upgrade, run the install command again. The command installs the latest release over the current release. If the background service was in operation, the command restarts it. `peekumi upgrade` does not download from the internet. It installs the bundle that it is part of. The installer and from-source builds use it in this way.

Peekumi stages the installation before an atomic directory switch. It keeps the previous installation next to the new installation (`peekumi.previous-<time>`) for rollback, and it removes older backups. Peekumi keeps the state. Never replace the state directory with bundle files. Active runs prevent managed stops/upgrades.

Configuration and SQLite schemas have versions. Peekumi upgrades current unversioned workflow/cache schemas and does not delete records. Peekumi does not open workflow state that has a newer schema, and it does not overwrite that state. Future migrations must obey this rule and include fixtures for earlier versions. Before you upgrade, keep a backup that you made while the service was stopped. It is possible that older binaries cannot read a newer database.

## Release verification

For each pull request, the Distribution workflow builds, tests and packages each platform. Then the workflow installs each archive with `install.sh` and does a check with `peekumi doctor`. When you push a `v*` tag that matches `package.json`, the four archives and their checksums go to a draft GitHub release. A maintainer reviews and publishes this release. The Linux archives are built on Ubuntu 22.04, so they run on older glibc versions.

A generated artifact is not evidence of validation until that workflow passes. The macOS background service and the Linux systemd integration must have their related host environments. A phone setup by a second person and a one-week review trial are still release acceptance checks. Automated tests do not make claims about these checks.
