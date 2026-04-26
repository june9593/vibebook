import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Buffer } from "node:buffer";
import { readConfig, getPassphrase } from "../config.js";
import { decrypt, deriveKey } from "../crypto.js";

/**
 * Dump a session file (or any repo file) to stdout, decrypting on the fly
 * when the path ends in `.enc`. Used by the in-session /vibebook skill so
 * Claude doesn't need to know about the passphrase or AES.
 *
 * Path resolution:
 *   - absolute path → used as-is
 *   - relative path → resolved against `cfg.repoPath`
 *
 * Decryption uses the same key derivation as everything else (passphrase +
 * repo salt + scrypt + AES-256-GCM).
 */
export async function catCmd(path: string): Promise<void> {
  if (!path) throw new Error("usage: vibebook cat <path>");
  const cfg = readConfig();
  const abs = isAbsolute(path) ? path : join(cfg.repoPath, path);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  const data = readFileSync(abs);
  if (abs.endsWith(".enc")) {
    const key = deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"));
    process.stdout.write(decrypt(data, key));
  } else {
    process.stdout.write(data);
  }
}
