import { describe, it, expect } from "vitest";
import { encryptDeterministic, decrypt, isEncryptedBlob, deriveKey } from "../src/crypto.js";
import { Buffer } from "node:buffer";

describe("encryptDeterministic — git filter requirement", () => {
  const key = deriveKey("hunter2", Buffer.from("AAAAAAAAAAAAAAAAAAAAAA==", "base64"));

  it("round-trips through encrypt + decrypt", () => {
    const pt = Buffer.from("# session 1\n## User\nfix the bug\n", "utf8");
    const ct = encryptDeterministic(pt, key);
    expect(ct.equals(pt)).toBe(false);
    expect(decrypt(ct, key).equals(pt)).toBe(true);
  });

  it("is deterministic — same plaintext + key → identical ciphertext", () => {
    // Without this property, every `git add` would mark every file as
    // changed and the repo would explode.
    const pt = Buffer.from("the quick brown fox", "utf8");
    const a = encryptDeterministic(pt, key);
    const b = encryptDeterministic(pt, key);
    expect(a.equals(b)).toBe(true);
  });

  it("yields different ciphertext for different plaintexts", () => {
    const a = encryptDeterministic(Buffer.from("hello", "utf8"), key);
    const b = encryptDeterministic(Buffer.from("hellp", "utf8"), key);
    expect(a.equals(b)).toBe(false);
  });

  it("isEncryptedBlob recognizes our header", () => {
    const ct = encryptDeterministic(Buffer.from("payload", "utf8"), key);
    expect(isEncryptedBlob(ct)).toBe(true);
    expect(isEncryptedBlob(Buffer.from("plain old markdown\n"))).toBe(false);
    expect(isEncryptedBlob(Buffer.alloc(0))).toBe(false);
  });

  it("decrypt rejects tampered ciphertext", () => {
    const ct = encryptDeterministic(Buffer.from("secret", "utf8"), key);
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decrypt(tampered, key)).toThrow();
  });
});
