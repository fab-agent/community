# End-to-end encryption — design note

Status: **encryption is a proposal, not implemented.** The *sender authenticity* part (Ed25519 signatures, key pinning, safety numbers) shipped in v0.2.0 — see the README's "Signed messages". Today message bodies are stored in plain text on the community server (see the README's security notes). This note describes how direct messages could become end-to-end encrypted without changing the product's shape. We will revisit it based on how the plugin is actually used.

## Goals

* The server (and anyone with access to its Cloudflare account or D1 database) cannot read message **bodies**.
* The recipient can tell **who** really sent a message (no server-forged messages).
* Zero new dependencies: Node's built-in `node:crypto` is enough.
* Keep the invite flow and admin model; E2EE is an addition, not a rewrite.

## Non-goals (v1)

* Hiding metadata. The server still sees who talks to whom and when. Names, departments, titles and tasks remain plain text — they are the community directory.
* Group channels (a later design: sender keys).
* Protection against a compromised endpoint (malware on a member's machine can read their screen and keys).
* Per-message forward secrecy / ratcheting (Signal-style). Out of scope; see "Known limits".

## Primitives (all in `node:crypto`)

| Purpose | Primitive |
| --- | --- |
| Key agreement | X25519 (`crypto.diffieHellman`) |
| Key derivation | HKDF-SHA256 (`crypto.hkdfSync`) |
| Content encryption | AES-256-GCM |
| Sender authenticity | Ed25519 signatures (`crypto.sign` / `crypto.verify`) |

## Keys

Each **device** (a Herdr installation running the plugin) generates two key pairs on first run:

* an X25519 *encryption* key pair, and
* an Ed25519 *signing* key pair.

Private keys never leave the device. They are stored next to `config.json` in the plugin config directory with mode `0600` (an OS keychain integration is a later hardening step). Public keys are uploaded to the server and attached to the member:

```
devices(id, member_id, enc_pub, sig_pub, label, created_at, revoked)
```

A member may have several devices (laptop, server box). Revoking a member revokes all their devices.

## Message format

For a message from device **S** to member **R** (and always also to the sender's own devices, so history is readable everywhere):

1. Generate a random 256-bit content key `K` and a 96-bit nonce.
2. `ciphertext = AES-256-GCM(K, nonce, plaintext, aad = from_member | to_member | timestamp)`.
3. For every recipient device `D` (R's devices + S's own devices):
   * generate an ephemeral X25519 key pair `(e, E)`;
   * `shared = X25519(e, D.enc_pub)`; `wrapKey = HKDF(shared, info = "community-v1/wrap")`;
   * `wrapped = AES-256-GCM(wrapKey, K)`; store `(D.id, E, wrapped)`.
4. `signature = Ed25519(S.sig_priv, ciphertext | nonce | aad | envelope-hash)`.

The server stores `{ciphertext, nonce, envelopes[], signature, sender_device}` and treats it as an opaque blob. A recipient device finds its envelope, unwraps `K`, verifies the signature against the sender device's `sig_pub`, then decrypts.

Server schema change: `messages.body` becomes `messages.blob` (JSON) plus a `v` column, with `v = 0` meaning legacy plain text so existing databases migrate without losing history.

## Trust and key verification

E2EE is only as strong as the guarantee that a public key really belongs to the person. A malicious or compromised server could otherwise hand out its own key (a machine-in-the-middle). Mitigations, in order of effort:

1. **Invite as trust anchor.** The admin who creates an invite sees the invitee's device fingerprint when the invite is redeemed, and confirms it out of band (a call, in person). Unconfirmed members show a "not verified" marker.
2. **Safety numbers.** Each pair of members can compare a short fingerprint (hash of both identity keys) shown in the TUI, like Signal's safety numbers.
3. **Key-change warnings.** The client pins the last seen keys per member (trust on first use). If a member's device list changes unexpectedly, the TUI shows a prominent warning before sending.

New devices of an existing member are added by an authenticated session of that member and announced to their contacts, who see "Ayşe added a new device".

## Operations

* **Retention** is unchanged: the server deletes blobs after `MESSAGE_RETENTION_DAYS`. Messages are not recoverable by the server either, so no export-before-delete on the server side.
* **Lost device / new device:** a new device cannot read earlier messages unless an existing device re-wraps their keys for it (a "link device" flow). Otherwise it starts with an empty history. This is a deliberate trade-off.
* **Moderation / legal hold:** admins cannot read content. If an organisation needs that, it must run in `e2ee = off` mode.
* **Rollout:** a per-community setting `E2EE = off | optional | required` in the Worker. `optional` lets old clients keep working during migration.

## Known limits

* A stolen long-term device key can decrypt messages that were wrapped for it (no ratchet). Mitigation: rotate device keys periodically; consider the Double Ratchet later if the use case justifies it.
* Metadata (sender, recipient, time, size) is visible to the server.
* The terminal and the pasted text (`/pull`) are outside the cryptographic boundary.

## Phases and effort

1. **Crypto module + tests** (key generation, wrap/unwrap, sign/verify) — about half a day.
2. **Server:** `devices` table, `v`/`blob` columns, device registration endpoints — about half a day.
3. **Client:** key storage, encrypt/decrypt in the TUI, "not verified" marker, safety numbers — about a day.
4. **Multi-device linking and key-change UX** — about a day.

Open questions: do communities want an escrow/admin-readable mode; is a per-message disappearing timer more useful than server retention; should keys live in the OS keychain from day one.
