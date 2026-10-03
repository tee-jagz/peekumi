# Build and validation scripts

These scripts start Peekumi, find the Rust toolchain and measure the backend performance. They are tools for developers. They are not part of the browser interface or the repository analysis engine.

- `start.mjs`: The npm entry point for the Rust service.
- `cargo.mjs`: Runs the installed Cargo toolchain.
- `benchmark-rust.mjs`: Compares the Rust service with the Node reference, which the repository keeps.
- `benchmark.mjs`: Measures the earlier Node analysis pipeline.

- `manage.mjs`: Installation, the registry, dependency diagnostics, the OS background service, pairing, revocation and Tailscale HTTPS setup.
- `package.mjs`: Makes a platform archive with bundled Node/TypeScript and a SHA-256 checksum. The archive does not include private state.

`install.sh` at the repository root downloads a release archive and verifies its checksum. Then it installs the archive with the `peekumi upgrade` command from that archive.
- `guide-screenshots.mjs`: Generates again the labelled screenshots and the icon images for the user guide, and the README screenshots. It uses a private, temporary Peekumi instance on this repository. Run `npm run build:rust` before you use this script.
