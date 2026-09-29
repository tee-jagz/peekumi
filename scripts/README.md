# Build and validation scripts

These scripts launch Strata, locate the Rust toolchain and measure backend performance. They are developer tooling rather than part of the browser interface or repository analysis engine.

- `start.mjs`: the npm entry point for the Rust service.
- `cargo.mjs`: invokes the installed Cargo toolchain.
- `benchmark-rust.mjs`: compares the Rust service with the retained Node reference.
- `benchmark.mjs`: measures the earlier Node analysis pipeline.
