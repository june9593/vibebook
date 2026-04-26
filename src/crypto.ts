import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("MEMVC1\0\0"); // 8 bytes
const KEY_LEN = 32;
const IV_LEN = 12;   // GCM standard
const TAG_LEN = 16;

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** File layout: MAGIC(8) | IV(12) | TAG(16) | CIPHERTEXT */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  return encryptWithIv(plaintext, key, iv);
}

/**
 * Deterministic-IV variant for git clean filters: same plaintext + key must
 * yield identical ciphertext, otherwise every `git add` would mark every file
 * dirty even when nothing changed and the repo would explode.
 *
 * IV = HMAC-SHA256(key, plaintext)[:12]. This is the SIV-lite pattern git-crypt
 * uses. Trade-off: an attacker who guesses a candidate plaintext can confirm
 * it by reproducing the IV — i.e., we lose semantic security against known-
 * plaintext. Acceptable here: raw_sessions are AI conversations, not crypto
 * keys, and the threat model is "private repo got accidentally cloned by
 * someone with no passphrase."
 */
export function encryptDeterministic(plaintext: Buffer, key: Buffer): Buffer {
  const iv = createHmac("sha256", key).update(plaintext).digest().subarray(0, IV_LEN);
  return encryptWithIv(plaintext, key, iv);
}

function encryptWithIv(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("bad magic");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Quick header check used by the smudge filter: a blob is encrypted iff it
 * starts with our MAGIC. Files committed before encryption was enabled (or
 * in plaintext-mode repos) lack the header and pass through untouched.
 */
export function isEncryptedBlob(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}
