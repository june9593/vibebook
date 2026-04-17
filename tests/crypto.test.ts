import { describe, it, expect } from "vitest";
import { deriveKey, encrypt, decrypt } from "../src/crypto.js";
import { randomBytes } from "node:crypto";

describe("crypto", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const salt = randomBytes(16);
    const key = deriveKey("correct horse battery staple", salt);
    const plaintext = Buffer.from("hello, memory 内存");
    const enc = encrypt(plaintext, key);
    const dec = decrypt(enc, key);
    expect(dec.toString("utf8")).toBe("hello, memory 内存");
  });

  it("wrong key fails to decrypt", () => {
    const salt = randomBytes(16);
    const k1 = deriveKey("passA", salt);
    const k2 = deriveKey("passB", salt);
    const enc = encrypt(Buffer.from("secret"), k1);
    expect(() => decrypt(enc, k2)).toThrow();
  });

  it("ciphertext differs on repeat (random IV)", () => {
    const salt = randomBytes(16);
    const key = deriveKey("p", salt);
    const a = encrypt(Buffer.from("x"), key);
    const b = encrypt(Buffer.from("x"), key);
    expect(a.equals(b)).toBe(false);
  });
});
