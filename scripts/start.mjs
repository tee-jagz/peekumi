#!/usr/bin/env node
// Keep npm start as a convenience entry point for the Rust executable.
process.argv.splice(2, 0, "run", "--release", "--locked", "--");
await import("./cargo.mjs");
