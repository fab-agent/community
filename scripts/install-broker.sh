#!/usr/bin/env bash
# Install the Community broker on a server (run as root). Usage: install-broker.sh <community-url> <invite-code> <machine-label>
# Creates user `community-broker` (holds the Server Agent key) and group `community-agents` (may talk to the socket).
# Agents must NOT run as community-broker; that separation is what keeps the key out of their reach.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
url="${1:?community url}"; code="${2:?invite code}"; label="${3:?machine label}"
src="$(cd "$(dirname "$0")/.." && pwd)"
node="$(readlink -f "$(command -v node)")"
id community-broker >/dev/null 2>&1 || useradd --system --home-dir /var/lib/community-broker --create-home --shell /usr/sbin/nologin community-broker
getent group community-agents >/dev/null || groupadd --system community-agents
install -d -o root -g root -m 0755 /opt/community
case "$node" in /root/*|/home/*) # the broker user cannot execute a node that lives in a private home: ship a copy
  install -d -m 0755 /opt/community/bin; install -m 0755 "$node" /opt/community/bin/node; node=/opt/community/bin/node;;
esac
rsync -a --delete --exclude /bin --exclude .git --exclude node_modules --exclude server --exclude test "$src/" /opt/community/
cfg=/var/lib/community-broker/config; install -d -o community-broker -g community-broker -m 0700 "$cfg"
sudo -u community-broker env COMMUNITY_CONFIG_DIR="$cfg" "$node" /opt/community/src/cli.mjs join "$url" "$code"
printf '{"at":"%s","recipients":null,"rate":{"max":10,"window_s":60},"max_body":2000}\n' "$label" > "$cfg/broker.json"
chown community-broker:community-broker "$cfg/broker.json"; chmod 600 "$cfg/broker.json"
cat > /etc/systemd/system/community-broker.service <<UNIT
[Unit]
Description=Community broker (Server Agent)
After=network-online.target
[Service]
User=community-broker
Group=community-agents
RuntimeDirectory=community-broker
RuntimeDirectoryMode=0750
ExecStart=$node /opt/community/src/broker.mjs --config-dir $cfg --socket /run/community-broker/broker.sock
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$cfg
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now community-broker
echo "broker up. Add agent users to the group:  usermod -aG community-agents <user>"
