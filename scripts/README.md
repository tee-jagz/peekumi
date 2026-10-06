# Build and validation scripts

These scripts start Peekumi, find the Rust toolchain and measure the backend performance. They are tools for developers. They are not part of the browser interface or the repository analysis engine.

- `start.mjs`: The npm entry point for the Rust service.
- `cargo.mjs`: Runs the installed Cargo toolchain.
- `benchmark-rust.mjs`: Compares the Rust service with the Node reference, which the repository keeps.
- `benchmark.mjs`: Measures the earlier Node analysis pipeline.

- `manage.mjs`: Installation, the registry, dependency diagnostics, the OS background service, pairing, revocation and tunnel selection. By default, `share` uses private Tailscale. Only `share --tunnel cloudflare` opens a public tunnel, and that tunnel runs in the foreground. If Tailscale status or exposure fails, `share` prints the cause, the private setup steps and the public opt-in command. Then it exits with a non-zero code. It does not save the configuration or restart the service.
- `tunnel/tailscale.mjs`: A tunnel provider with the operations `available`, `status`, `expose` and `url`. It runs the Tailscale commands and does not change a Serve configuration that is already there. `manage.mjs` keeps the configuration and restarts the service.
- `tunnel/cloudflare.mjs`: A provider with the same operations, and also `close`. On the first explicit exposure, it downloads a pinned file, verifies it and keeps it in a cache. It runs its private binary with automatic updates disabled. It waits for a connected Quick Tunnel, and it closes the tunnel on cancellation or failure. Diagnostics do not download or run the binary. Peekumi verifies macOS archives before extraction and Linux binaries before it runs them. Peekumi verifies the cached files again for each exposure.
- `tunnel/cloudflare-release.mjs`: The four platform assets and their SHA-256 digests, pinned from the asset data of the official GitHub release. When you update them, verify the actual assets. The macOS hashes in the release notes can be different from the asset digests. Peekumi does not look up releases at runtime.
- `tunnel/select.mjs`: Strict selection on the command line. Environment variables and the saved configuration cannot enable Cloudflare. `manage.mjs` sets up secure cookies and prints a temporary pairing link. It does not save the Cloudflare hostname.
- `package.mjs`: Makes a platform archive with bundled Node/TypeScript and a SHA-256 checksum. The archive does not include private state.
- `release-notes.mjs`: Prints the notes of a GitHub release: the install steps and the section of `CHANGELOG.md` for the version. The Distribution workflow uses it. A version without a changelog section is an error.

Setup agents must tell the owner that Cloudflare makes a public URL. They must get the explicit approval of the owner before they run `peekumi share --tunnel cloudflare`. Refer to the [setup skill](../skills/peekumi-setup/SKILL.md) and the [setup guide](../docs/SETUP.md#optional-public-cloudflare-tunnel).

`install.sh` at the repository root downloads a release archive and verifies its checksum. Then it installs the archive with the `peekumi upgrade` command from that archive.
- `guide-screenshots.mjs`: Generates again the labelled screenshots and the icon images for the user guide, and the README screenshots. It uses a private, temporary Peekumi instance on this repository. Run `npm run build:rust` before you use this script.
