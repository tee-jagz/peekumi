---
name: peekumi-setup
description: Install Peekumi, register local repositories, and configure persistent private phone access. Use when someone asks their agent to set up or upgrade Peekumi.
---

Preserve Peekumi's existing canvas, Ask/Instruction and isolated agent-worktree workflow. Setup does not authorize editing inspected repositories or dispatching agents.

Read `docs/SETUP.md` in the Peekumi distribution for the commands and platform requirements. Locate the distribution from the user's supplied path or installed `peekumi`; do not assume a checkout location.

1. Inspect existing `peekumi status`, `peekumi repo list` and `peekumi doctor`. Reuse the private state directory and registered repositories; never replace tokens to fix connectivity.
2. If running from source, install dependencies and build, then run `node scripts/manage.mjs install`. Use the installed command for subsequent service setup.
3. Register only requested existing Git checkouts with `peekumi repo add`. Repeating it is safe. Use `peekumi start` for the background service; restart an existing service after changing the registry. Active agent runs block restarts.
4. When phone access is requested, use `peekumi share` after the user has signed into Tailscale. This uses private Serve, never Funnel. Account login, HTTPS enablement or device authorization may need user action.
5. Use `peekumi pair` for the owner's private link or `peekumi pair --read-only` for exploration-only access. Never commit or publish pairing credentials. Tell the user to open the link once, then install/bookmark the plain HTTPS address.
6. Verify server assets load, repository selection works, and provide the stable address plus any missing optional capabilities. Do not claim phone reachability without testing from that device.

GitHub CLI and its existing authentication enable PR context for local checkouts. PR inspection is read-only apart from fetching private refs. It does not publish comments, push branches, merge or dispatch agents. Python is currently an optional external parser dependency; report when it is unavailable.
