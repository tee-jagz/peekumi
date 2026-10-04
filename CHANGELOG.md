# Changelog

This file records the changes in each release of Peekumi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow [Semantic Versioning](https://semver.org/).

## Unreleased

This is the first public release. Peekumi was called Repo Strata during its development, and the former `strata` command and `STRATA_*` settings still work.

### Map and inspection

- A mobile map of the real folders, files and declarations of a repository, with pan, pinch and zoom, and drill-down from the folder structure to one function.
- Coloured Git comparisons between two commits, a Time mode with commit cards, read-only branch switching, and PR merge-base comparisons through the GitHub CLI.
- Static relationships (imports, calls, implementations and inheritance) with committed dependency rules. Unresolved and ambiguous targets stay explicit.
- Dependency lines that do not cross cards and that run straight into their arrowheads.
- Declaration details: inputs, outputs, fields, documentation and the changed parts of a declaration.
- Language adapters for Rust, Python, JavaScript, TypeScript and Svelte scripts. Peekumi labels all other tracked files.

### Ask

- Questions about the selection, answered by the Claude Code client on your computer, with the code, its callers and its dependencies.
- Read-only lookups and code search at the compared revisions, with names in the answer linked to the map.
- Answers in ASD-STE100 Simplified Technical English that stream while Claude writes them.
- One saved conversation for each branch.

### Instructions and agent tasks

- Instructions anchored to folders, files, declarations or dependencies, and an exact task preview.
- Tasks that Codex or Claude Code do in a separate worktree, with run-scoped reports and owner approval.
- Explore changes on the map, request changes as a next round that continues from the last commit of the agent, and collect changes while you explore.
- A Tasks button that shows a running task from every view.

### Setup and access

- Prebuilt archives for macOS and Linux (x64 and ARM64) and a one-line installer that verifies checksums.
- A background service, several repositories on one server, and `peekumi repo add` and `remove` without a restart.
- Private phone access through Tailscale Serve, and an explicit, temporary public option through a Cloudflare Quick Tunnel.
- Owner and read-only device pairing with revocation, and an installable PWA.

### Brand and documentation

- Peek, an animated mascot with states for work, lookups, review and errors.
- A user guide with labelled screenshots. All documentation is in ASD-STE100 Simplified Technical English.
