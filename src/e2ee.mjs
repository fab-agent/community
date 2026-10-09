// End-to-end encryption primitives (node:crypto only): X25519 key agreement, HKDF-SHA256, AES-256-GCM.
//  * Direct message: random content key, wrapped separately for sender and recipient via an ephemeral X25519 key.
//  * Private topic: one random topic key, wrapped for each member at creation; messages use AES-GCM with that key.
// Authenticity comes from the Ed25519 signatures in sign.mjs; the server only ever sees opaque envelopes.
import crypto from "node:crypto";

export const DM_PREFIX = "e2ee1:", TOPIC_PREFIX = "e2ee1t:";
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export const rawPublic = (keyObj) => Buffer.from(keyObj.export({ format: "jwk" }).x, "base64url").toString("base64");
export const publicFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(raw, "base64")]), format: "der", type: "spki" });
export function newEncKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  return { priv: privateKey, pub: rawPublic(publicKey) };
}

const wrapKeyFrom = (priv, pubRaw, epkRaw) =>
  Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: priv, publicKey: publicFromRaw(pubRaw) }), Buffer.from(epkRaw, "base64"), "community/v1 wrap", 32));
function gcmSeal(key, plain, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: b64u(iv), ct: b64u(ct) };
}
function gcmOpen(key, { iv, ct }, aad) {
  const buf = unb64u(ct), d = crypto.createDecipheriv("aes-256-gcm", key, unb64u(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}
// Wrap a 32-byte key to a recipient's public X25519 key with a fresh ephemeral key. aad binds the wrap to its owner.
export function wrapKey(recipientPub, key, aad) {
  const eph = newEncKeys();
  return { epk: eph.pub, ...gcmSeal(wrapKeyFrom(eph.priv, recipientPub, eph.pub), key, aad) };
}
export function unwrapKey(encPriv, w, aad) {
  const k = Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: encPriv, publicKey: publicFromRaw(w.epk) }), Buffer.from(w.epk, "base64"), "community/v1 wrap", 32));
  return gcmOpen(k, w, aad);
}

// ---- direct messages ----
export function sealDM(plain, fromId, target, recipients /* [{id, encPub}] incl. sender */) {
  const ck = crypto.randomBytes(32), body = gcmSeal(ck, Buffer.from(plain, "utf8"), `${target}\n${fromId}`);
  const w = {};
  for (const r of recipients) w[r.id] = wrapKey(r.encPub, ck, `dm-key\n${r.id}`);
  return DM_PREFIX + b64u(JSON.stringify({ ...body, w }));
}
export function openDM(envelope, myId, encPriv, fromId, target) {
  try {
    const e = JSON.parse(unb64u(envelope.slice(DM_PREFIX.length)).toString());
    const ck = unwrapKey(encPriv, e.w[myId], `dm-key\n${myId}`);
    return gcmOpen(ck, e, `${target}\n${fromId}`).toString("utf8");
  } catch { return null; }
}

// ---- private topics ----
export const newTopicKey = () => crypto.randomBytes(32);
export const sealTopicText = (tk, plain, aad) => TOPIC_PREFIX + b64u(JSON.stringify(gcmSeal(tk, Buffer.from(plain, "utf8"), aad)));
export function openTopicText(tk, envelope, aad) {
  try { return gcmOpen(tk, JSON.parse(unb64u(envelope.slice(TOPIC_PREFIX.length)).toString()), aad).toString("utf8"); } catch { return null; }
}
export const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
// What the topic creator signs, so the server cannot swap in a topic key it knows.
export const bundleCanonicalH = (creatorId, titleEnv, hashes /* {memberId: sha256 of its wrap} */) =>
  `community/v1 topic\n${creatorId}\n${titleEnv}\n` + Object.keys(hashes).sort().map((id) => `${id}:${hashes[id]}`).join("\n");
export const bundleCanonical = (creatorId, titleEnv, wraps /* {memberId: wrapString} */) =>
  bundleCanonicalH(creatorId, titleEnv, Object.fromEntries(Object.entries(wraps).map(([id, w]) => [id, sha256hex(w)])));
