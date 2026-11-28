---
name: peekumi-setup
description: Install Peekumi, register local repositories, and configure persistent private phone access. Use when someone asks their agent to set up or upgrade Peekumi.
---

Read `docs/SETUP.md` in the Peekumi distribution (use the path the user gives or the installed `peekumi` binary).

1. Check current state with `peekumi status`, `peekumi repo list`, and `peekumi doctor`. Reuse the existing private state directory and registered repositories instead of regenerating tokens.
2. If running from source, install dependencies, build Peekumi, and run `node scripts/manage.mjs install`. Use the installed `peekumi` command for service setup thereafter.
3. Register requested existing Git checkouts with `peekumi repo add` (idempotent) and start the background service with `peekumi start`. Adding/removing repos applies live except removing the first registered repo, which requires `peekumi restart` (blocked while an agent run is active).
4. For phone access, prefer Tailscale Serve via `peekumi share` (private to the tailnet, never Funnel). If Tailscale is not signed in or HTTPS is disabled, report the cause and setup steps. If using a temporary public tunnel (`peekumi share --tunnel cloudflare`), confirm with the user that a public Cloudflare URL is acceptable before starting it.
5. Generate a pairing link with `peekumi pair` (or `peekumi pair --read-only`), or share the temporary link printed by Cloudflare `share` (which stops on Ctrl+C). Never commit pairing credentials.
6. Verify the server loads assets and switches repositories cleanly, then share the URL and note any missing optional capabilities (such as `gh` for PR context or Python for Python parsing).
