// Message signing: every message is signed with an Ed25519 key that never leaves this device.
// Receivers verify against the sender's public key (pinned on first sight), so the server or another
// member cannot forge a message. Signing proves who wrote it, not that the text is harmless.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clean } from "./lib.mjs";
import { newEncKeys, rawPublic } from "./e2ee.mjs";

// Must match the Worker's `clip(body, 4000).trim()` exactly: the signature covers the stored text.
// Encrypted envelopes ("e2ee1…") may be longer than plain text.
export const canonBody = (s) => clean(s).slice(0, /^e2ee1/.test(s) ? 16000 : 4000).trim();
export const canonical = (from, target, ts, nonce, body) => `community/v1\n${from}\n${target}\n${ts}\n${nonce}\n${body}`;
export const dmTarget = (toId) => `dm:${toId}`;
export const topicTarget = (topicId) => `topic:${topicId}`;

const rawPub = (pubKeyObj) => Buffer.from(pubKeyObj.export({ format: "jwk" }).x, "base64url").toString("base64");

export const encKeyCanonical = (id, encPub) => `community/v1 enc\n${id}\n${encPub}`;
// signing.json holds both private keys (Ed25519 for signatures, X25519 for decryption). Mode 0600.
export function loadOrCreateSigner(dir) {
  const f = path.join(dir, "signing.json");
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  let changed = false;
  if (!j.pem) { j.pem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }); changed = true; }
  if (!j.encPem) { j.encPem = newEncKeys().priv.export({ type: "pkcs8", format: "pem" }); changed = true; }
  if (changed) { fs.writeFileSync(f, JSON.stringify(j), { mode: 0o600 }); fs.chmodSync(f, 0o600); }
  const priv = crypto.createPrivateKey(j.pem), encPriv = crypto.createPrivateKey(j.encPem);
  return { priv, pubkey: rawPub(crypto.createPublicKey(priv)), encPriv, encPub: rawPublic(crypto.createPublicKey(encPriv)) };
}
// The device vouches for its encryption key, so the server cannot substitute its own.
export const signEncKey = (signer, id) =>
  crypto.sign(null, Buffer.from(encKeyCanonical(id, signer.encPub)), signer.priv).toString("base64");
export function verifyEncKey(signPub, id, encPub, encSig) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signPub, "base64")]);
    return crypto.verify(null, Buffer.from(encKeyCanonical(id, encPub)), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(encSig, "base64"));
  } catch { return false; }
}
export const signBytes = (signer, text) => crypto.sign(null, Buffer.from(text), signer.priv).toString("base64");
export function verifyBytes(signPub, text, sig) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signPub, "base64")]);
    return crypto.verify(null, Buffer.from(text), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(sig, "base64"));
  } catch { return false; }
}

export function signMessage(signer, fromId, target, rawBody) {
  const body = canonBody(rawBody);
  const ts = Date.now();
  const nonce = crypto.randomBytes(12).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(canonical(fromId, target, ts, nonce, body)), signer.priv).toString("base64");
  return { body, ts, nonce, sig };
}

export function verifyMessage(pubkey, { from_id, target, ts, nonce, body, sig }) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey, "base64")]);
    const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(canonical(from_id, target, ts, nonce, body)), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

// Safety number: compare out of band (call, in person) to be sure nobody swapped a key.
export const fingerprint = (pubkey) =>
  crypto.createHash("sha256").update(Buffer.from(pubkey, "base64")).digest("hex").slice(0, 20).toUpperCase().match(/.{4}/g).join("-");

// Trust on first use. Returns "new" (pinned now), "ok", or "changed" (do not trust).
export function checkPin(pins, id, pubkey) {
  if (!pubkey) return "none";
  if (!pins[id]) { pins[id] = pubkey; return "new"; }
  return pins[id] === pubkey ? "ok" : "changed";
}

// Verdict for one received message: "ok" | "unsigned" | "changed" | "bad".
export function verdict(pins, member, msg, target) {
  if (!member?.pubkey) return msg.sig ? "bad" : "unsigned";
  if (checkPin(pins, member.id, member.pubkey) === "changed") return "changed";
  if (!msg.sig) return "unsigned"; // a keyed member's message without a signature is suspicious
  return verifyMessage(pins[member.id], { from_id: msg.from_id, target, ts: msg.ts, nonce: msg.nonce, body: msg.body, sig: msg.sig }) ? "ok" : "bad";
}
