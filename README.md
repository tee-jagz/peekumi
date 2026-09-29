# Repo Strata

Explore a repository and its changes from your phone, from the overall structure down to the implementation.

Strata reads committed Git objects and serves a mobile web interface. It leaves the inspected repository's working tree, branches and hooks untouched.

## Run

Requirements: Node.js 22+, Git, and Python 3.9+ for Python symbol extraction. Python is not required for file-level inspection or JavaScript/TypeScript analysis.

```sh
npm ci
npm start -- /path/to/repository
```

Open the access link printed in the terminal. The token in its URL fragment is exchanged for an HttpOnly session cookie and removed from browser history. The session lasts seven days or until the service restarts. Local access credentials live in `.strata/`, which is excluded from Git.

Choose an initial comparison:

```sh
npm start -- /path/to/repository --base HEAD~10 --head HEAD
```

On a Mac with multiple Python installations, choose a working interpreter explicitly:

```sh
STRATA_PYTHON=/usr/bin/python3 npm start -- /path/to/repository --base HEAD~10
```

## Open from your phone

Bind to the host's private network address:

```sh
npm start -- /path/to/repository --host 192.168.1.20 --port 4317
```

Open the printed access link on a phone on the same trusted Wi-Fi network. For access away from home, bind Strata to localhost and use Tailscale Serve, or put the service behind an authenticated HTTPS reverse proxy. For example: `tailscale serve --bg --http=4317 http://127.0.0.1:4317`. Your phone must be connected to the same Tailscale network. Userspace Tailscale installations may require `--socket=/path/to/tailscaled.sock` before `serve`. With HTTPS, add `--secure-cookie`. Plain HTTP does not encrypt source or session cookies: use it only on a trusted local network. Do not expose this port directly to the public internet.

The service is platform-independent Node code with Git subprocesses; this first slice has been tested on macOS. Linux has not yet been exercised here.

## Explore

- Select explicit base and head commits. The commit strip and comparison picker list the latest 80 first-parent commits from HEAD; startup flags can select other Git revisions.
- Explore the glass card deck from the supplied mockup. Tap once to select, then tap the selected card or Open to zoom in. Nested packages follow the repository's actual structure.
- Added is green, modified is purple, removed is red, unchanged is grey. Text labels accompany colour.
- Use Time to review each commit against its first parent; tap a peeking sheet or commit chip to move through history. Use Diff to choose a base and switch the map between Before and After.
- Use file search, breadcrumbs, and the scoped Changes list to navigate. Large maps scroll inside the stage; the review panel scrolls independently.
- Select curved dependency lines in the map, then inspect their endpoints in Dependencies. Neighbours appear as dashed cards. These are static import relationships, not a runtime call graph.
- Structure shows the current topology; Changes colours the comparison. Health scoring is not yet measured.
- Open a symbol to highlight it in the full source. Switch between Before, After and a complete file diff.
- Refresh to discover new commits. Uncommitted work is not included.

## Analysis and limitations

Python uses `ast`; JavaScript and TypeScript use the TypeScript compiler parser. Svelte script blocks use the same parser, with non-JavaScript data scripts excluded. Templates remain visible in file diffs. Files are considered changed using Git object identity and file mode, so constants, templates, comments, and changes outside extracted symbols remain visible.

Python imports resolve relative paths and unique dotted-module suffixes. JavaScript imports resolve relative paths and the conventional Svelte `$lib` alias. Other aliases, dynamic imports without a literal target, and ambiguous Python modules remain unresolved. Import lists include external or unresolved imports explicitly. Custom module resolution and full Svelte template analysis are future work.

Every tracked file appears, including tests and unsupported languages. Binary files, symlinks, submodules, files above 512 KiB, and common secret filenames are labelled without source previews. This filename restriction is not a secret scanner; the viewer is private because other source files can contain sensitive code or data.

Renames currently appear as removal plus addition. Symbol identity is qualified name within a file, and duplicate names are not independently tracked. Parse failures fall back to file-level inspection. Up to six snapshots are cached in memory. There is no database, history backfill, or agent orchestration yet.

## Verify

```sh
npm test
npx playwright install chromium
npm run test:browser
```

Test against a different repository:

```sh
STRATA_TEST_REPO=/path/to/visalytics STRATA_TEST_BASE=HEAD~10 npm run test:browser
```

`STRATA_BROWSER_CHANNEL=chrome` uses an installed Chrome instead of Playwright's downloaded Chromium. Browser tests save local screenshots under `test-results/`; these can contain inspected code and are never committed.

See [MVP scope](docs/MVP.md), [architecture](docs/ARCHITECTURE.md), and [first integration results](docs/VALIDATION.md).

## This workspace

The preview inspects `/Users/tolu/projects/visalytics` on localhost port 4317, using a ten-commit comparison. It is reachable privately at `http://tolu-mac-mini.tailb34901.ts.net:4317/` with Tailscale enabled on the client. The Tailscale daemon uses `/Users/tolu/.config/tailscale/tailscaled.sock`; Serve forwards port 4317 to `http://127.0.0.1:4317`. The previous LAN URL has been retired. Its access link is in `.strata/access-link.txt`; its process ID and logs are in `.strata/server.pid` and `.strata/server.log`. This background preview does not start automatically after a reboot. To stop it, inspect the saved PID and stop that process. Use the commands above to restart it or run on another host.

## Original context

The original specification and prototype archive are preserved in [docs/context](docs/context/README.md). The archive's HTML mockup is the visual and interaction reference. [The current MVP scope](docs/MVP.md) defines which features are implemented.
