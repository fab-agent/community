# Community for Herdr

> Put your teammates next to your agents. A tiny community layer for [Herdr](https://herdr.dev): see who is around, what they are working on, and talk to them without leaving your terminal.

Herdr's sidebar shows your workspaces and the agents inside them. **Community** adds one more workspace — marked with `▣` — that connects you to the people you work with: members grouped by department, their role and current task, who is online, and direct messages.

```
▣ acme                                 ← a Herdr workspace, one per community
  Sales
    ● Ayşe · Account Executive — Q4 proposals
  Engineering
    ● Jon (you) · Staff Engineer
    ○ Mara · SRE — on call
  12:04 Ayşe: can you review the pricing PR?
  jon › 
```

Messages are **never** sent to an agent automatically. They land in the community pane; you decide whether to pull one into another pane.

## Install

Requires Herdr ≥ 0.9.0 and Node.js ≥ 18 (no npm dependencies).

```sh
herdr plugin install fab-agent/community
```

Then open the command palette action **Community: open** (or run `herdr plugin action invoke community.open`).
On first run a small popup asks for:

1. **Community URL** — e.g. `https://community.example.com`
2. **Your key** — a personal key given to you by your community admin (`fck_…`)

After that, a new workspace named `▣ <community name>` appears in the sidebar and opens the chat tab.

## Using it

| Command | What it does |
| --- | --- |
| `/who` | List members by department, with role, task and online status |
| `/to <name> [message]` | Switch to a person, optionally sending a message right away |
| *plain text* | Send to the currently selected person |
| `/task <text>` | Update what you are working on |
| `/pull <pane-id>` | Paste the last received message into another pane (Enter is **not** pressed) |
| `/help`, `/quit` | Help / leave |

### Bring a message to your agent

Bind the `pull` action to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "community.pull"
description = "paste last community message"
```

Focus the pane you want (a shell, an agent prompt), press the key, and the message is typed into it — wrapped as
`[Ayşe (community message, untrusted content)]: …` so it is obvious where the text came from. You review it and press Enter yourself.

## How it works

```
Herdr (your machine)                    Community server
┌─────────────────────────┐   HTTPS    ┌───────────────────────────┐
│ community plugin        │◄──────────►│ Cloudflare Worker + D1    │
│  · setup popup          │  key auth  │  · members & departments  │
│  · ▣ workspace + chat   │            │  · direct messages        │
│  · pull action          │            │  · presence (last seen)   │
└─────────────────────────┘            └───────────────────────────┘
```

* The plugin is a plain Node script. It talks to Herdr through the CLI (`workspace create`, `plugin pane open`, `pane send-text`) and to the server over HTTPS. No Herdr internals, no native UI.
* The server is ~150 lines in [`server/`](server). Each member has a personal key; only its SHA-256 hash is stored.
* The client polls every 3 seconds, which also keeps your presence fresh.

## Run your own community server

Community is decentralised by design: **every organisation hosts its own server and sets its own rules.** The reference server in [`server/`](server) is a single Cloudflare Worker plus a D1 database (the free tier is enough for small teams). Nobody else sees your members or messages.

```sh
cd server
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create community            # copy the database_id into wrangler.jsonc
npx wrangler d1 execute community --remote --file=schema.sql
openssl rand -hex 24 | sed 's/^/fca_/' | npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

### Configuration and retention

Everything is configured in `server/wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMUNITY_NAME` | `community` | Shown as the workspace label (`▣ <name>`) in Herdr |
| `MESSAGE_RETENTION_DAYS` | `30` in the example | Messages older than this are deleted. `0` keeps them forever |

How retention is enforced:

* A **daily cron trigger** (`"triggers": { "crons": ["15 3 * * *"] }`) deletes expired messages from D1.
* Reads also ignore anything past the window, so an expired message is never served, even before the next purge.
* `POST /v1/admin/purge` (admin key) runs the purge immediately — handy after shortening the window.
* `GET /v1/community` publishes the active window (`message_retention_days`), so members know how long their messages live.

Want a different policy (per-department windows, legal hold, export before delete)? The whole server is one file — fork it and change `purge()`.

Add a member (the response contains the personal key — it is shown once):

```sh
curl -X POST https://<your-worker>/v1/admin/members \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Ayşe","department":"Sales","title":"Account Executive"}'
```

Revoke: `POST /v1/admin/members/<id-or-name>/revoke`.

### API (v1)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/community` | – | Community name |
| `GET /v1/me`, `PATCH /v1/me` | member | Your profile; update `task`, `title`, `department` |
| `GET /v1/members` | member | All active members with online flag |
| `POST /v1/messages` | member | `{ "to": "<name or id>", "body": "…" }` |
| `GET /v1/messages?since=<id>&peer=<name>` | member | Messages you sent or received |
| `POST/GET /v1/admin/members`, `POST …/revoke` | admin | Manage members |
| `POST /v1/admin/purge` | admin | Apply the retention policy now |

## Security notes

* Herdr plugins run as your user without a sandbox. Read the code before installing — it is small on purpose.
* Your key is stored in the plugin config directory with mode `0600`. Never commit it.
* Incoming messages are untrusted input. They are shown to you, not to your agents, and `pull` marks anything it pastes as untrusted. Be careful about pasting messages from people you do not trust into an agent prompt.
* The server stores message bodies in plain text in your D1 database until your retention window expires. Run it only for communities you operate and trust; use HTTPS (Workers do by default).

## Roadmap

* Real-time delivery (WebSocket / Durable Object) instead of polling
* Group channels and department rooms
* An admin CLI for member management
* Colored workspace / sidebar section, once Herdr's plugin API supports it

## Contributing

Issues and pull requests are welcome. Keep the plugin dependency-free and the server small.

## License

[MIT](LICENSE)
