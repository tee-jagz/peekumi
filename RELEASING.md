# Releasing Peekumi

This document is for the maintainer. It tells you how to make a release. A release is a Git tag `vX.Y.Z` and a GitHub release with an archive for each platform.

## Version numbers

Peekumi uses [Semantic Versioning](https://semver.org/). Before 1.0.0, increase the second number (0.3.0) for new features or changes that break something, and the third number (0.2.1) for fixes only.

## During development

Each pull request adds one line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). The release notes come from this section, so it must be complete before a release.

## Make a release

1. Make sure that `main` is up to date and that CI passed on its last commit.
2. Read the `## [Unreleased]` section of `CHANGELOG.md`. Make each line clear for users.
3. Run `npm run release -- 0.3.0`. Use `--dry-run` first to see the changes. The script does these steps:
   - It sets the version in `package.json`, `package-lock.json`, `Cargo.toml` and `Cargo.lock`.
   - It changes `## [Unreleased]` into `## [0.3.0] - <today>` and adds a new, empty `## [Unreleased]` above it.
   - It refuses a version that is not newer, and an `Unreleased` section with no changes.
4. Run `npm test`, `npm run test:rust` and `npm run test:browser`.
5. Commit the changes: `git commit -am "Release 0.3.0"`.
6. Make the tag and push both: `git tag -a v0.3.0 -m "Peekumi 0.3.0"`, then `git push origin main v0.3.0`.
7. The Distribution workflow builds and tests each platform, checks that the tag agrees with `package.json`, and makes a **draft** release. The notes come from the changelog (`scripts/release-notes.mjs`).
8. Open the draft release. Check the notes and the eight files (four archives and four `.sha256` files).
9. Publish the release. The installer uses the latest published release.

## After the release

- Install the release with the one-line command from the README on a clean computer, with no token, and run `peekumi doctor`.
- If a platform failed only because a runner was slow, run the failed job again. Do not change the tag.
- If the release has a defect, do not move the tag. Fix the defect and make a new release with a higher third number.
