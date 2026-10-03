# Build and validation scripts

These scripts launch Peekumi, locate the Rust toolchain and measure backend performance. They are developer tooling rather than part of the browser interface or repository analysis engine.

- `start.mjs`: the npm entry point for the Rust service.
- `cargo.mjs`: invokes the installed Cargo toolchain.
- `benchmark-rust.mjs`: compares the Rust service with the retained Node reference.
- `benchmark.mjs`: measures the earlier Node analysis pipeline.

- `manage.mjs`: installation, registry, dependency diagnostics, OS background service, pairing, revocation and explicit tunnel selection. `share` defaults to private Tailscale; only `share --tunnel cloudflare` opens a public foreground tunnel. Tailscale status/exposure failures print the cause, private setup steps and the public opt-in command, then exit non-zero before saving configuration or restarting the service.
- `tunnel/tailscale.mjs`: tunnel provider with `available`, `status`, `expose` and `url` operations; owns Tailscale commands and protects existing Serve configuration. Management retains configuration persistence and service restarts.
- `tunnel/cloudflare.mjs`: the same provider operations plus `close`; verifies and caches a pinned download on first explicit exposure, runs its private binary with automatic updates disabled, waits for a connected Quick Tunnel and closes it on cancellation/failure. Diagnostics do not download or execute it. macOS archives are verified before extraction; Linux binaries are verified before execution. Cached artifacts are reverified on every exposure.
- `tunnel/cloudflare-release.mjs`: four platform assets and SHA-256 digests pinned from the official GitHub release asset metadata. When updating, verify the actual assets; upstream macOS release-body hashes can differ from asset digests. No release lookup occurs at runtime.
- `tunnel/select.mjs`: strict CLI selection; environment variables and saved configuration cannot enable Cloudflare. Management owns secure-cookie setup and prints a temporary pairing link without saving the Cloudflare hostname.
- `package.mjs`: platform archive with bundled Node/TypeScript and SHA-256 checksum; excludes private state.

Setup agents must explain that Cloudflare creates a public URL and obtain the owner's explicit approval before running `peekumi share --tunnel cloudflare`; see the [setup skill](../skills/peekumi-setup/SKILL.md) and [setup guide](../docs/SETUP.md#optional-public-cloudflare-tunnel).

`install.sh` at the repository root downloads a release archive, verifies its checksum and installs it with the archive's own `peekumi upgrade`.
- `guide-screenshots.mjs`: regenerates the user guide's labelled screenshots, its icon images and the README screenshots from a private, temporary Peekumi instance on this repository. Run `npm run build:rust` first.
