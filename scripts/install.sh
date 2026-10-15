#!/bin/sh
# One-command installer for a Community server agent.
#
#   curl -fsSL https://raw.githubusercontent.com/fab-agent/community/v0.5.1/scripts/install.sh | sh -s -- <community-url> <invite-code> [machine-label] [--hardened]
#
# Light (default): no root, no daemon. --hardened: run as root (sudo); installs the broker service.
# Needs: node >= 22, curl, tar, bash. The release archive is checked against its published sha256 and, when `gh` is
# available, against its GitHub build attestation.
set -eu
VERSION="v0.5.1"
BASE="${COMMUNITY_RELEASE_BASE:-https://github.com/fab-agent/community/releases/download/$VERSION}"
die() { echo "community install: $*" >&2; exit 1; }

hardened=0; pos=""
for a in "$@"; do
  case "$a" in --hardened) hardened=1 ;; *) pos="$pos
$a" ;; esac
done
url=$(printf '%s' "$pos" | sed -n '2p'); code=$(printf '%s' "$pos" | sed -n '3p'); label=$(printf '%s' "$pos" | sed -n '4p')
[ -n "$url" ] && [ -n "$code" ] || die "usage: install.sh <community-url> <invite-code> [machine-label] [--hardened]"
[ -n "$label" ] || label=$(hostname -s 2>/dev/null || hostname)

command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
command -v bash >/dev/null || die "bash is required"
command -v node >/dev/null || die "node >= 22 is required (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "node >= 22 is required, found $(node -v)"
[ "$hardened" = 0 ] || [ "$(id -u)" = 0 ] || die "--hardened needs root: curl ... | sudo sh -s -- <url> <code> <label> --hardened"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
name="community-$VERSION.tar.gz"
curl -fsSL -o "$tmp/$name" "$BASE/$name" || die "could not download $BASE/$name"
curl -fsSL -o "$tmp/$name.sha256" "$BASE/$name.sha256" || die "could not download the checksum"
want=$(cut -d' ' -f1 "$tmp/$name.sha256")
if command -v sha256sum >/dev/null; then have=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
[ "$want" = "$have" ] || die "checksum mismatch, refusing to install"
if [ -z "${COMMUNITY_SKIP_ATTEST:-}" ] && command -v gh >/dev/null && gh attestation verify "$tmp/$name" --repo fab-agent/community >/dev/null 2>&1; then
  echo "build attestation verified"
else
  echo "note: build attestation not checked (gh missing or offline); sha256 matched"
fi
tar xzf "$tmp/$name" -C "$tmp"
dir="$tmp/community-$VERSION"
[ -d "$dir/scripts" ] || die "unexpected archive layout"

if [ "$hardened" = 1 ]; then
  bash "$dir/scripts/install-broker.sh" "$url" "$code" "$label"
  # give the person who ran sudo the `community` command and skill too (the broker holds the key)
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    sudo -u "$SUDO_USER" -H bash "$dir/scripts/install-agent.sh" "$url" "$code" "$label" --no-join
    echo "add $SUDO_USER's agents to the socket group:  usermod -aG community-agents $SUDO_USER"
  fi
else
  bash "$dir/scripts/install-agent.sh" "$url" "$code" "$label"
fi
