---
name: peekumi-setup
description: Install Peekumi, register local repositories, and configure persistent private phone access. Use when someone asks their agent to set up or upgrade Peekumi.
---

Do not change the current Peekumi canvas, the Ask/Instruction workflow or the isolated agent-worktree workflow. Setup does not give permission to edit the repositories that Peekumi examines or to dispatch agents.

Read `docs/SETUP.md` in the Peekumi distribution. It gives the commands and the platform requirements. To find the distribution, use the path that the user gives or the installed `peekumi`. Do not assume a checkout location.

1. Examine the current output of `peekumi status`, `peekumi repo list` and `peekumi doctor`. Use the current private state directory and registered repositories again. Do not replace tokens to repair the connection.
2. If you run Peekumi from source, install the dependencies. Then build Peekumi. Then run `node scripts/manage.mjs install`. For all subsequent service setup, use the installed command.
3. Use `peekumi repo add` to register only the Git checkouts that the user asks for. These checkouts must exist. It is safe to do this command again. Use `peekumi start` for the background service. A service that runs applies `repo add` and `repo remove` without a restart (to remove the first registered repo, `peekumi restart` is still necessary). An active agent run prevents restarts and prevents the removal of that repo.
4. If the user asks for phone access, use `peekumi share` after the user signs in to Tailscale. This command uses private Serve, never Funnel. It is possible that the user must do the account login, enable HTTPS or authorize the device. If Tailscale is not ready, tell the user the cause and the setup steps.
   Before you run `peekumi share --tunnel cloudflare`, tell the owner that its URL is public and that anyone on the internet can reach it. Also tell the owner that the traffic goes through Cloudflare, and that the private pairing link gives owner access to all registered repositories. Ask the owner if they want that public tunnel. Wait for explicit approval before you run it, unless the owner already approved it after that explanation. A request for phone access is not approval, and a Tailscale failure is not approval.
5. Use `peekumi pair` for the private link of the owner. Use `peekumi pair --read-only` for access that is only for exploration. For an approved Cloudflare tunnel, use the temporary pairing link that `share` prints. Keep that command running, and tell the user that Ctrl+C closes the tunnel and that the next run gets a new URL. Do not commit or publish pairing credentials. Tell the user to open the link one time. Then tell the user to install/bookmark the plain HTTPS address.
6. Make sure that the server assets load and that repository selection operates correctly. Give the user the address (a temporary address for Cloudflare) and a list of the missing optional capabilities. Do not say that the phone can connect until you do a test from that device.

GitHub CLI and its current authentication give PR context for local checkouts. PR inspection only reads data, but it also fetches private refs. It does not publish comments, push branches, merge or dispatch agents. At this time, Python is an optional external parser dependency. Tell the user if Python is not available.
