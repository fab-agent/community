# Server Agents (design for v0.5)

Status: proposed. Replaces nothing yet; extends the signing and E2EE design in `e2ee-design.md` and `threat-model.md`.

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

- `via`: which sub-agent asked the broker to send (name and, where known, the herdr pane). Set by the broker from the caller's local socket credentials, not by the sub-agent's text.
- `at` (location): the machine the sender was working on. For humans it is the saved machine of the focused workspace, read on the client. For Server Agents it is the server's own label.

Both labels are **assertions by the signer, not proofs**. A signature proves the message came from the holder of that member's key and was not altered. It does not prove which sub-agent or which machine produced it. Receivers show the labels in a distinct style and never use them for trust decisions.

People section: a member's current location is shown only if the member opted in.

## Server-side policy (enforced by the Worker, not by clients)

Anything enforced only in the client or the CLI can be bypassed by calling the API directly. These apply even if a Server Agent key is stolen:

| Policy | Default for `server_agent` |
|---|---|
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
- Reads the caller's identity from `SO_PEERCRED` (uid/pid) for the `via` label and per-caller limits.
- Local policy before sending: recipient allowlist, rate limit, redaction pass (the existing `share.mjs` rules, stricter by default on servers), optional human-approval hook for sensitive recipients. The Worker's policy is the backstop.
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
- Labels can lie. A compromised sub-agent can claim any `via` unless the broker sets it from peer credentials, which is why the broker does.
- Prompt injection: inbox text stays untrusted and is never auto-delivered to agents.

## Open questions

1. Can the client plugin read which saved machine owns the focused workspace through the Herdr API? If not, location needs a manual selector.
2. Do plugin panes, `pane send-text` and the pane picker work over `--machine` as assumed? (Test on a real machine before building.)
3. Rate limits as fixed numbers or per-member config set at invite time?
4. Should Server Agents be visible in People as a separate section ("Servers")?

## Test plan

- Worker: unit/integration tests against local D1 (`wrangler dev --local`) for each policy; then one pass against the live test server.
- Broker: unix-socket tests including peer credential labels, rate limit and allowlist; a two-user setup test in a container.
- Client: pure-logic tests for grouping and labels; TUI behaviour is verified by hand on a real client with a saved machine.
