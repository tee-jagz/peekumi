#!/bin/sh
# Installs or upgrades Peekumi from a release archive.
#
#   curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
#
# Detects the platform, downloads the matching release archive and its SHA-256 checksum,
# verifies the archive, installs it to PEEKUMI_PREFIX and links `peekumi` into PEEKUMI_BIN.
# Re-running upgrades in place; the previous installation is kept as one backup.
#
# Environment (each also accepts its STRATA_ name from before the rename):
#   PEEKUMI_VERSION  release tag to install, such as v0.2.0 (default: the latest release)
#   PEEKUMI_REPO     GitHub repository (default: tee-jagz/peekumi)
#   PEEKUMI_PREFIX   installation directory (default: ~/.local/lib/peekumi)
#   PEEKUMI_BIN      directory for the `peekumi` and `strata` links (default: ~/.local/bin)
#   PEEKUMI_ARCHIVE  install this local archive instead of downloading; its .sha256 must sit beside it
#   GITHUB_TOKEN     token for downloads while the repository is private
set -eu

repo=${PEEKUMI_REPO:-${STRATA_REPO:-tee-jagz/peekumi}}
prefix=${PEEKUMI_PREFIX:-${STRATA_PREFIX:-$HOME/.local/lib/peekumi}}
bindir=${PEEKUMI_BIN:-${STRATA_BIN:-$HOME/.local/bin}}
version=${PEEKUMI_VERSION:-${STRATA_VERSION:-}}
local_archive=${PEEKUMI_ARCHIVE:-${STRATA_ARCHIVE:-}}

fail() {
  echo "peekumi install: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "Git is required. Install Git, then run this again."
command -v tar >/dev/null 2>&1 || fail "tar is required."

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); Peekumi runs on Linux and macOS" ;;
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

# An asset's API URL sends the file itself only with this Accept header; without it, the API
# sends a JSON description of the asset. This is true with or without a token.
fetch() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" "$1" -o "$2"
  else
    curl -fsSL -H "Accept: application/octet-stream" "$1" -o "$2"
  fi
}

if [ -n "$local_archive" ]; then
  [ -f "$local_archive" ] || fail "no archive at $local_archive"
  [ -f "$local_archive.sha256" ] || fail "no checksum at $local_archive.sha256"
  archive=$local_archive
  expected=$(cut -d' ' -f1 "$local_archive.sha256")
else
  command -v curl >/dev/null 2>&1 || fail "curl is required to download Peekumi"
  api=https://api.github.com/repos/$repo/releases
  if [ -n "$version" ]; then
    release=$api/tags/$version
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
  # Asset API URLs work for a public repository, and for a private one with a token.
  asset_url() {
    tr ',' '\n' <"$work/release.json" | awk -v want="$1" '
      /"url": *"[^"]*\/releases\/assets\// {
        url = $0; sub(/.*"url": *"/, "", url); sub(/".*/, "", url)
      }
      index($0, "\"name\": \"" want "\"") || index($0, "\"name\":\"" want "\"") { print url; exit }'
  }
  name=$(tr ',' '\n' <"$work/release.json" | grep '"name": *"peekumi-[^"]*-'"$os-$arch"'\.tar\.gz"' |
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
bundle=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'peekumi-*' | head -1)
[ -x "$bundle/bin/peekumi" ] || fail "the archive does not contain a Peekumi bundle"

# The bundle installs itself: staged copy, atomic swap, one backup, and a refusal to replace
# an installation while an agent run is active.
PEEKUMI_INSTALLER=1 "$bundle/bin/peekumi" upgrade "$prefix"

mkdir -p "$bindir"
ln -sf "$prefix/bin/peekumi" "$bindir/peekumi"
# The command's name before the rename keeps working.
ln -sf "$prefix/bin/peekumi" "$bindir/strata"
echo "Linked $bindir/peekumi (and strata)"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Add $bindir to your PATH, for example: export PATH=\"$bindir:\$PATH\"" ;;
esac

if "$prefix/bin/peekumi" status 2>/dev/null | grep -q '"running": true'; then
  echo "Restarting the running service with the new version"
  "$prefix/bin/peekumi" restart
fi

echo
echo "Next: peekumi doctor, then peekumi repo add /path/to/repository and peekumi start."
echo "Setup guide: https://github.com/$repo/blob/main/docs/SETUP.md"
