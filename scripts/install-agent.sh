#!/usr/bin/env bash
# Light install of a Server Agent (no root needed, no daemon).
# Usage: install-agent.sh <community-url> <invite-code> <machine-label> [--no-join]
#   --no-join  only install the tools (use when a broker already holds the key on this machine)
# Installs: ~/.local/share/fab-community (code), ~/.local/bin/community (command), a skill for Claude and Codex,
# and joins the Community with a one-time invite (the invite decides: human or server agent).
set -euo pipefail
url="${1:?community url}"; code="${2:?invite code}"; label="${3:?machine label}"; mode="${4:-}"
src="$(cd "$(dirname "$0")/.." && pwd)"
node="$(command -v node)" || { echo "node >= 22 is required" >&2; exit 1; }
share="$HOME/.local/share/fab-community"; cfg="$HOME/.config/fab-community"; bin="$HOME/.local/bin"
mkdir -p "$share" "$bin"
rsync -a --delete --exclude .git --exclude node_modules --exclude server --exclude test --exclude docs "$src/" "$share/"
printf '#!/bin/sh\nCOMMUNITY_CONFIG_DIR="%s" COMMUNITY_AT="%s" exec "%s" "%s/src/agent.mjs" "$@"\n' "$cfg" "$label" "$node" "$share" > "$bin/community"
chmod 755 "$bin/community"
for d in "$HOME/.claude/skills/community" "$HOME/.codex/skills/community"; do
  mkdir -p "$d"; cp "$share/skills/community-server/SKILL.md" "$d/SKILL.md"
done
if [ "$mode" != "--no-join" ]; then
  COMMUNITY_CONFIG_DIR="$cfg" "$node" "$share/src/cli.mjs" join "$url" "$code"
  cat <<MSG

Light install done. The key lives in $cfg and is readable by every process that runs as $(id -un).
If it leaks, the damage is limited by this agent's server-side policy and the member can be revoked.
For customer-facing servers or agents that read untrusted input, use the broker (scripts/install-broker.sh).
MSG
fi
echo "command: $bin/community   (make sure $bin is on PATH)"
