# Verification and CRAP scores

Peekumi helps you decide whether to accept one change from a coding agent. For each commit pair (`start` to `head`), Peekumi shows four separate parts:

1. **Peekumi checks:** dependency rules, sandboxed verification checks, and CRAP scores that Peekumi measured itself.
2. **CI:** checks that an outside CI service reported, with the exact commit SHA and read time.
3. **Agent claims:** checks that the agent says it ran. Peekumi never shows agent claims as proof.
4. **Blind spots:** what nobody checked, including changed tests, changed CI files, changed `.peekumi.json` files, unresolved links, and loose files.

Peekumi never combines these parts into one green "verified" badge.

## Configure checks in `.peekumi.json`

Add a `checks` object to `.peekumi.json` at the root of your repository:

```json
{
  "version": 1,
  "groups": {},
  "rules": [],
  "checks": {
    "prepare": {
      "command": ["npm", "ci"],
      "timeoutSeconds": 300,
      "cacheKey": ["package-lock.json"],
      "cacheDirs": ["node_modules"]
    },
    "items": [
      {
        "id": "unit",
        "name": "Unit tests",
        "command": ["pytest", "--cov=pkg", "--cov-report=lcov:coverage/lcov.info"],
        "timeoutSeconds": 120,
        "expect": "pass",
        "coverage": "coverage/lcov.info"
      }
    ]
  }
}
```

Peekumi always reads `checks` from the `start` commit, never from the `head` commit. An agent cannot weaken its own checks in the change under review. If `.peekumi.json` changed between `start` and `head`, Peekumi flags that change under **Blind spots**.

## Sandbox isolation

Each verification run checks a private `git archive` copy of `head` with no `.git` folder. Your checkout, branches, and Git hooks never change.

- **Prepare phase (`--prepare`):** Opt-in only. It runs inside the sandbox with network access and writes only to the private copy and the prepare cache. Peekumi never runs `--prepare` automatically when an agent reports.
- **Check phase:** Runs inside the sandbox with no network access, a private empty `HOME`, a private `TMPDIR`, and a clean environment with no tokens. Any prepared cache is read-only. Access to `~/.ssh`, `~/.aws`, `~/.config/gh`, Keychains, the inspected checkout, and Peekumi state is denied.
- **Process limits:** Each check has a timeout. When time expires, Peekumi kills the entire process group. Peekumi keeps the last 64 KiB of combined output.
- **Fail closed:** On macOS Peekumi uses Seatbelt (`/usr/bin/sandbox-exec`). On Linux Peekumi uses bubblewrap (`bwrap`). If the sandbox fails or is unavailable, the run stops with state `blocked`. Peekumi never runs repository code without a sandbox.

## Command line

Run checks directly from a terminal or from an agent:

```sh
peekumi verify --start main --head HEAD
peekumi verify --start main --head HEAD --prepare --json
```

Exit codes:

- `0`: every configured check matched its expected outcome.
- `1`: one or more checks failed or timed out.
- `2`: verification was blocked (missing config, invalid commits, prepare failure, or sandbox error).

When an agent runs `peekumi verify` itself, Peekumi still runs its own verification when the agent reports.

## HTTP API

- `POST /api/verify/runs`: starts a sandboxed run in the background with `{start, head, prepare?, runId?}` (owner only).
- `GET /api/verify/runs?head=&runId=`: lists saved verification runs, newest first.
- `GET /api/verify/runs/<id>`: reads one verification run record.
- `GET /api/crap?base=&head=`: computes before and after CRAP scores for changed Python functions.

When a task agent finishes on a repository with `checks` configured at `start`, Peekumi starts an offline verification run automatically. On a failed check, tap **Send failure to agent** to start the next round with the check output.

## Approval binding

An approval record on the server names the exact `start` commit, `head` commit, addressed instructions, and evidence snapshot. Merging requires an approval record that matches the current commits. Both **Update with main** and **Keep these files** (salvage) move the commits and clear the previous approval.

## Coverage and CRAP scores

Peekumi computes CRAP scores for changed Python functions from LCOV coverage reports captured by sandboxed verification runs. Coverage never comes from an agent claim.

For each changed Python function:

```text
CRAP = complexity^2 * (1 - coverage)^3 + complexity
```

A CRAP score above `30` counts as risky. The map highlights changed Python functions with their CRAP score and marks risky functions in red. Each score displays its coverage commit, verification run ID, artifact path, and calculator. When `PEEKUMI_CRAPPER_PATH` points to a pinned `crapper 0.1.0` installation (with parser SHA-256 verification), Peekumi uses it. Otherwise Peekumi uses its embedded isolated Python AST complexity and LCOV calculator.

Languages other than Python always show **CRAP not available** with an explicit reason and appear in `excludedFiles`.
