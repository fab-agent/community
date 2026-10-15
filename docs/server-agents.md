# Server Agents (design for v0.5)

Status: implemented in v0.5 (see the notes under Open questions). Replaces nothing yet; extends the signing and E2EE design in `e2ee-design.md` and `threat-model.md`.

## Problem

Herdr 0.9 can show several SSH machines in one TUI (`herdr machine add`). A person now works from one client and reaches many servers, and each server runs many short-lived agents. Community today assumes one plugin per Herdr server and one member per plugin instance. That breaks down:

- Installing the plugin on every server creates N members, N device keys, N safety numbers per person, and puts key material on servers.
- Short-lived sub-agents cannot be members: invites, pins, `/fp` verification and revocation do not scale to identities that live for minutes.
- Everything on a server runs as the same OS user, so anything that can read a key file can speak as that member.

## Concepts

- **Human member**: a person. Runs the plugin on their own client only. Never installs the plugin or copies keys to a server.
- **Server Agent**: one long-lived member per server (or per managed environment), for the agents that run and manage that server. Kind `server_agent`. Created by an admin invite like any member, with a role that cannot be self-promoted.
- **Sub-agent**: any short-lived agent working under a Server Agent. Not a member and has no key. It speaks through the Server Agent's **broker**.
- **Broker**: a small local daemon on the server that is the only holder of the Server Agent's key. Sub-agents ask it to send; it applies policy, signs and sends.

## Identity and labels

Every message already carries a signed body (`community/v1\nfrom\ntarget\nts\nnonce\nbody`). Two optional, signed labels are added to the body envelope (stored outside the encrypted payload so the server can apply policy; both are clipped and stripped of control characters):

- `via`: which sub-agent asked the broker to send. **Declared by the caller** in its request to the broker (Node cannot read `SO_PEERCRED`, so the broker cannot verify it). The broker puts it in argv before any message text, so text cannot override it.
- `at` (location): the machine the sender was working on. For humans it is the saved machine of the focused workspace, read on the client. For Server Agents it is the server's own label, set by the broker from its config (callers cannot change it).

Wire format: when `via` or `at` is present, the signature covers `community/v2\nfrom\ntarget\nts\nnonce\nvia\nat\nbody`; without labels the original `community/v1` text is used, so existing clients and messages keep verifying.

Both labels are **assertions by the signer, not proofs**. A signature proves the message came from the holder of that member's key and was not altered. It does not prove which sub-agent or which machine produced it. Receivers show the labels in a distinct style and never use them for trust decisions.

People section: a member's current location is shown only if the member opted in.

## Ownership and presence

- **The admin who invites a Server Agent is responsible for it.** The invite records its creator and the Worker stores it as the member's `owner_id` when the invite is redeemed (an invite made with the root key has no owner until an admin assigns one with `POST /v1/admin/members/<name>/owner`). The TUI lists servers in a "Servers" section under their owner.
- **Servers have no presence.** Nobody sits at a server, so there is no online/offline state: the Worker returns `online: null` and does not write `last_seen` for Server Agents (no D1 write per request), and the TUI shows no dot.

## Server-side policy (enforced by the Worker, not by clients)

Anything enforced only in the client or the CLI can be bypassed by calling the API directly. These apply even if a Server Agent key is stolen:

| Policy | Default for `server_agent` |
|---|---|
| Presence | none (`online: null`, no `last_seen` writes) |
| Kind and role | `server_agent`, no admin, cannot invite, cannot change roles |
| Send rate | per-member sliding window (e.g. 20 messages / 10 min), configurable per member |
| Recipients | allowlist of member names or "admins only"; others rejected |
| Topics | may post in public topics it is allowed on; cannot create topics or private topics |
| Message size | smaller cap than humans |
| Revocation | existing per-member revoke; one call removes the whole server's voice |

Schema: migration `0005` adds `members.kind`, `members.policy` (JSON: rate, recipients, topics) and a small `rate_events` table (or reuses message timestamps). Existing members become `kind='human'` with unchanged behaviour.

## Broker

`src/broker.mjs`, one per server, started by a systemd unit.

- Holds the Server Agent key. Listens on a unix socket.
- **Separation is only real if the key is owned by a different OS user than the agents.** The install script creates a dedicated user (e.g. `community-broker`), stores the config and key there with mode 0600, and creates a socket group that agent processes join. If an operator runs the broker as the same user as the agents, the broker still gives policy and labels but **not** key secrecy; the install script says so.
- Local policy before sending: optional recipient allowlist, sliding-window rate limit, size cap, and the `share.mjs` redaction pass. The Worker's policy is the backstop. A human-approval hook for sensitive recipients is not implemented in v0.5.
- Socket mode 0660, owned by the `community-agents` group; only members of that group can reach it. Protocol: one JSON request per connection (`send`, `post`, `inbox`, `who`, `topics`, `read`); `exec`-style commands do not exist.
- API: send DM, post to topic, read inbox (returns untrusted-labelled text). The inbox is never injected into agent prompts automatically.

## Headless install without the plugin

- `node src/cli.mjs join <fci_...>` redeems an invite from the command line and creates the device key (today only the TUI does this).
- Config directory falls back to `~/.config/fab-community` when Herdr is not installed (`HERDR_PLUGIN_CONFIG_DIR` still overrides).
- Distributed as a signed release asset (attestation already exists).

## Client changes

- Agents section: groups **Local** and one group per saved machine; remote agents are read with `herdr --machine <label> ...`. Sharing keeps the current flow (preview, Enter, redaction, signed E2EE DM) and the card names the source machine.
- Remote sharing is **opt-in per machine**; off by default, and a stronger redaction pass plus a "remote machine" warning in the preview.
- `/pull` into a remote pane is refused in v0.5.
- Version check: `--machine` forwarding needs matching Herdr versions on both ends; show a clear error otherwise.

## Out of scope

- Human multi-device (a person on two clients): the device-add flow and per-device E2EE wrapping. Deferred.
- Cryptographic attribution of sub-agents. Not possible while they share an OS user; documented as a limitation.
- Herdr Cloud.

## Threat notes

- Stolen Server Agent key: attacker is limited by server policy and can be revoked in one call; cannot impersonate a human.
- Compromised sub-agent with no key access (separate OS user): can only use the broker, bounded by its rate limit and allowlist.
- Compromised sub-agent when broker and agents share a user: can read the key; only server policy limits it.
- Labels can lie. A compromised sub-agent can claim any `via`; only `at` is fixed by the broker. Receivers must treat both as hints.
- Prompt injection: inbox text stays untrusted and is never auto-delivered to agents.

## Open questions

1. **Location from Herdr.** Resolved: the Herdr API (`herdr api snapshot`, `herdr api schema`, herdr 0.9.3) exposes no machine for a pane or workspace, so there is no `auto` mode. Humans set the label by hand with `/at <label>` (stored as `location` in `config.json`, signed with each message; no extra request to the server).
2. **`--machine` behaviour.** `herdr --machine <label> pane list|read` and `workspace list` work as assumed. Plain `herdr ...` commands always address this client's own server, even when a machine is selected in the UI, so `/pull` (`pane send-text`) cannot reach a remote pane by accident; it additionally refuses ids that are not local panes. See "Verified" below.
3. Rate limits are per-member policy set at invite time (default 20 / 10 min).
4. Servers appear in People as a separate "Servers" section under their owner.

### Verified (Herdr 0.9.3, two saved machines)

- `herdr pane list` returned only this client's panes while a saved machine was marked `selected` in `herdr machine list`; `herdr --machine <label> pane list` returned that machine's panes. Pane ids repeat across machines (`w1:p1` can exist on both), so the TUI keys remote agents by machine and pane.
- The Agents section listed `Local` plus the opted-in machine, and showed the other saved machine as "sharing off" without querying it.
- Not yet verified by hand: running the Community pane while a remote machine is selected in the Herdr UI (plugins then run on that machine), and a version-mismatch error from `--machine`.

## Test plan

- Worker: unit/integration tests against local D1 (`wrangler dev --local`) for each policy; then one pass against the live test server.
- Broker: unix-socket tests including peer credential labels, rate limit and allowlist; a two-user setup test in a container.
- Client: pure-logic tests for grouping and labels; TUI behaviour is verified by hand on a real client with a saved machine.
