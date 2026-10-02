<p align="center"><img src="docs/brand/peek.svg" width="120" alt="Peek, the Peekumi mascot: a round, one-eyed character looking over three layered lines"></p>

# Peekumi

Explore a repository and its changes from your phone, from the folder structure down to a single function, then ask about it or hand work to an agent.

Peekumi maps your repository's real folders, files and declarations, colours what changed between two commits, and shows the code and its static relationships. **Ask** answers questions about the selection with Claude Code, and **Instructions** become tasks that Codex or Claude Code carry out in a separate worktree for you to review. It reads committed code only and never changes your checkout.

| Repository map | Time travel | Tasks |
| --- | --- | --- |
| [<img src="docs/screenshots/mobile-map.png" width="260" alt="Mobile repository map with coloured changes, floating map controls and the Ask and Instruction box">](docs/screenshots/mobile-map.png) | [<img src="docs/screenshots/mobile-history.png" width="260" alt="Commit cards above the repository map in Time mode">](docs/screenshots/mobile-history.png) | [<img src="docs/screenshots/mobile-tasks.png" width="260" alt="Tasks view with a draft instruction ready to send to an agent">](docs/screenshots/mobile-tasks.png) |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
peekumi repo add /path/to/repo
peekumi start
peekumi share   # private HTTPS for your phone over Tailscale
peekumi pair    # prints the link to open on your phone
```

Prebuilt for macOS and Linux (glibc 2.34+); only Git is required. See [setup](docs/SETUP.md) for details, phone pairing and building from source, or give your agent the [setup skill](skills/peekumi-setup/SKILL.md).

## Learn more

- [User guide](docs/USER-GUIDE.md): every control, view and icon, with screenshots.
- [Ask, instructions and agent runs](docs/WORKFLOW.md).
- [Relationships and dependency rules](docs/RELATIONSHIPS.md), including `.peekumi.json`.
- [Development](docs/DEVELOPMENT.md): building, testing, benchmarks and analysis limits.
- [Architecture](docs/ARCHITECTURE.md), [scope](docs/MVP.md), [validation](docs/VALIDATION.md) and [brand](docs/brand/README.md).

Peekumi was called Repo Strata until October 2026; the `strata` command and settings still work ([details](docs/SETUP.md#renamed-from-strata)).
