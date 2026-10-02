# Build and validation scripts

These scripts launch Strata, locate the Rust toolchain and measure backend performance. They are developer tooling rather than part of the browser interface or repository analysis engine.

- `start.mjs`: the npm entry point for the Rust service.
- `cargo.mjs`: invokes the installed Cargo toolchain.
- `benchmark-rust.mjs`: compares the Rust service with the retained Node reference.
- `benchmark.mjs`: measures the earlier Node analysis pipeline.

- `manage.mjs`: installation, registry, dependency diagnostics, OS background service, pairing, revocation and Tailscale HTTPS setup.
- `package.mjs`: platform archive with bundled Node/TypeScript and SHA-256 checksum; excludes private state.
- `guide-screenshots.mjs`: regenerates the user guide's labelled screenshots, its icon images and the README screenshots from a private, temporary Strata instance on this repository. Run `npm run build:rust` first.
