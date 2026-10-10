# Threat model

What Community protects, against whom, and what it does not. Written to be checked: each claim names the file that implements it. If a claim does not match the code, the code wins and this document is a bug. Version: v0.3.0.

## Parts and trust

| Part | Where | Trusted for |
| --- | --- | --- |
| Plugin | member's machine (`src/`) | Everything: it holds the private keys |
| Server | Cloudflare Worker + D1 (`server/src/index.js`) | Availability, access control, retention. **Not** confidentiality of private content |
| Members | other people in the community | Their own words only |
| Admin | members with role `admin` | Inviting, revoking, archiving, key reset. Admins cannot read encrypted content |

## Adversaries

**A. The server operator, or anyone with the Cloudflare account or D1 database.** Honest-but-curious or fully malicious.

* Cannot read direct messages or private topics (including private topic titles): the server only stores `e2ee1:` / `e2ee1t:` envelopes. Primitives: X25519 + HKDF-SHA256 + AES-256-GCM (`src/e2ee.mjs`).
* Cannot forge a message in someone's name once that member's signing key is pinned by the reader: every message carries an Ed25519 signature over `community/v1\nfrom\ntarget\nts\nnonce\nbody` (`src/sign.mjs`). Readers verify locally.
* Cannot substitute a recipient's encryption key: the key is vouched for by the member's signing key (`enc_sig`, `verifyEncKey`). Cannot swap a private topic's key bundle: the creator signs the bundle (`bundleCanonical`).
* **Can** read public discussions, names, departments, titles, tasks, who talks to whom, when, and message sizes.
* **Can** withhold, delay, drop or replay messages (availability, not integrity). The server rejects a repeated nonce (409), so a captured message cannot be re-posted by a third party; the server also rejects timestamps more than 10 minutes from its clock, so a stale capture cannot be injected later even if the nonce store were pruned.
* **Can** lie at first contact: keys are trust-on-first-use. A malicious server can present a different signing key to a member you have never talked to. Defence: compare safety numbers with `/fp` over another channel.

**B. A network attacker.** Workers terminate TLS. Beyond TLS, private content is already encrypted and every message is signed, so a passive or active attacker gains what adversary A gains from the wire, nothing more.

**C. A malicious or compromised member.** Has a valid key, so:

* Can send anything, including prompt-injection text. A signature proves who wrote it, not that it is harmless. Mitigation: messages are shown to the human, `/pull` labels pasted text `untrusted` and `signature verified` / `UNVERIFIED` (`src/pull.mjs`, `src/chat.mjs`).
* Can read every private topic they belong to, including everything sent before their compromise. There is no forward secrecy and no ratchet.
* Can leak what they can read. Revoking a member stops future fetches; it cannot recall what they already downloaded.
* Cannot read other people's DMs or topics they were not wrapped into. Membership of a private topic is fixed at creation.

**D. A leaked personal API key.** Keys are stored as SHA-256 hashes on the server (`key_hash`), shown once at join. A leaked key lets an attacker act as that member towards the server (read public data, fetch ciphertext) but not sign messages or decrypt: those need the device's `signing.json`. Revoke the member and re-invite.

**E. Malware or physical access on a member's machine.** Out of scope. `signing.json` (mode 0600) holds the Ed25519 and X25519 private keys unencrypted. `state/last.json` holds the decrypted text of the last pulled message.

## Not protected

* Metadata (who, when, size, directory fields).
* Public discussions: signed but readable by the server.
* Forward secrecy and post-compromise security.
* Key recovery: lose the device, lose old encrypted messages. An admin resets your key and you start fresh. One device per member.
* The supply chain of the plugin itself: `herdr plugin install` runs unsandboxed code from the ref you install. Pin a tag (`--ref v0.3.0`) and read the code; it is small on purpose.
* Traffic analysis and deniability. Signatures are non-repudiable by design.

## Not examined

This has not had an independent security review or a formal analysis. The protocol is a simplified design built on `node:crypto` primitives, not a vetted messaging protocol such as Signal or MLS. Treat it as protection against a curious operator and a forging member, not as protection for life-critical secrets. Reviews and reports are welcome: see [SECURITY.md](../SECURITY.md).

Related: [E2EE design note](e2ee-design.md), README sections "End-to-end encryption and private topics" and "Signed messages".
