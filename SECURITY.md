# Security Policy

## Supported versions

Only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub:
**Security → Report a vulnerability** on <https://github.com/fab-agent/community/security/advisories/new>.

Include what you found, the affected component (plugin or `server/` Worker), and steps to reproduce. You can expect an acknowledgement within a few days; we will coordinate a fix and a disclosure date with you and credit you if you wish.

## Scope

In scope: the plugin (`src/`), the Worker (`server/`), the invite/key handling, and message sanitisation.

Known and documented limits (not vulnerabilities): direct messages and private topics are end-to-end encrypted but public discussions, metadata and the directory are readable by the server operator, there is no forward secrecy or key recovery (see the [threat model](docs/threat-model.md) and [E2EE design note](docs/e2ee-design.md)), and `herdr plugin install` runs unsandboxed code from the ref you install (pin a tag with `--ref`).
