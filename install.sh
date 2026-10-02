#!/bin/sh
# Installs or upgrades Repo Strata from a release archive.
#
#   curl -fsSL https://raw.githubusercontent.com/tee-jagz/repo-strata/main/install.sh | sh
#
# Detects the platform, downloads the matching release archive and its SHA-256 checksum,
# verifies the archive, installs it to STRATA_PREFIX and links `strata` into STRATA_BIN.
# Re-running upgrades in place; the previous installation is kept as one backup.
#
# Environment:
#   STRATA_VERSION  release tag to install, such as v0.2.0 (default: the latest release)
#   STRATA_REPO     GitHub repository (default: tee-jagz/repo-strata)
#   STRATA_PREFIX   installation directory (default: ~/.local/lib/strata)
#   STRATA_BIN      directory for the `strata` link (default: ~/.local/bin)
#   STRATA_ARCHIVE  install this local archive instead of downloading; its .sha256 must sit beside it
#   GITHUB_TOKEN    token for downloads while the repository is private
set -eu

repo=${STRATA_REPO:-tee-jagz/repo-strata}
prefix=${STRATA_PREFIX:-$HOME/.local/lib/strata}
bindir=${STRATA_BIN:-$HOME/.local/bin}

fail() {
  echo "strata install: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "Git is required. Install Git, then run this again."
command -v tar >/dev/null 2>&1 || fail "tar is required."

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); Strata runs on Linux and macOS" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

fetch() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" "$1" -o "$2"
  else
    curl -fsSL "$1" -o "$2"
  fi
}

if [ -n "${STRATA_ARCHIVE:-}" ]; then
  [ -f "$STRATA_ARCHIVE" ] || fail "no archive at $STRATA_ARCHIVE"
  [ -f "$STRATA_ARCHIVE.sha256" ] || fail "no checksum at $STRATA_ARCHIVE.sha256"
  archive=$STRATA_ARCHIVE
  expected=$(cut -d' ' -f1 "$STRATA_ARCHIVE.sha256")
else
  command -v curl >/dev/null 2>&1 || fail "curl is required to download Strata"
  api=https://api.github.com/repos/$repo/releases
  if [ -n "${STRATA_VERSION:-}" ]; then
    release=$api/tags/$STRATA_VERSION
  else
    release=$api/latest
  fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$release" -o "$work/release.json" ||
      fail "could not read the release from $release"
  else
    curl -fsSL "$release" -o "$work/release.json" ||
      fail "could not read the release from $release (private repositories need GITHUB_TOKEN)"
  fi
  # Asset API URLs work for private repositories with a token; public downloads use either.
  asset_url() {
    tr ',' '\n' <"$work/release.json" | awk -v want="$1" '
      /"url": *"[^"]*\/releases\/assets\// {
        url = $0; sub(/.*"url": *"/, "", url); sub(/".*/, "", url)
      }
      index($0, "\"name\": \"" want "\"") || index($0, "\"name\":\"" want "\"") { print url; exit }'
  }
  name=$(tr ',' '\n' <"$work/release.json" | grep '"name": *"strata-[^"]*-'"$os-$arch"'\.tar\.gz"' |
    head -1 | sed 's/.*"name": *"\([^"]*\)".*/\1/')
  [ -n "$name" ] || fail "the release has no archive for $os-$arch"
  archive=$work/$name
  echo "Downloading $name"
  fetch "$(asset_url "$name")" "$archive" || fail "download failed"
  fetch "$(asset_url "$name.sha256")" "$archive.sha256" || fail "checksum download failed"
  expected=$(cut -d' ' -f1 "$archive.sha256")
fi

actual=$(sha256 "$archive")
[ "$actual" = "$expected" ] || fail "checksum mismatch for $(basename "$archive"); nothing was installed"

tar -xzf "$archive" -C "$work"
bundle=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'strata-*' | head -1)
[ -x "$bundle/bin/strata" ] || fail "the archive does not contain a Strata bundle"

# The bundle installs itself: staged copy, atomic swap, one backup, and a refusal to replace
# an installation while an agent run is active.
STRATA_INSTALLER=1 "$bundle/bin/strata" upgrade "$prefix"

mkdir -p "$bindir"
ln -sf "$prefix/bin/strata" "$bindir/strata"
echo "Linked $bindir/strata"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Add $bindir to your PATH, for example: export PATH=\"$bindir:\$PATH\"" ;;
esac

if "$prefix/bin/strata" status 2>/dev/null | grep -q '"running": true'; then
  echo "Restarting the running service with the new version"
  "$prefix/bin/strata" restart
fi

echo
echo "Next: strata doctor, then strata repo add /path/to/repository and strata start."
echo "Setup guide: https://github.com/$repo/blob/main/docs/SETUP.md"
