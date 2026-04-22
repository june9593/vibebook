import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Path of the on-disk passphrase. Plain text on purpose — chmod 600 is the
 * only protection. Users who want stronger storage should set VIBEBOOK_PASSPHRASE
 * via shell init / 1Password CLI / etc.
 */
export function passphrasePath(): string {
  return join(homedir(), ".vibebook", "passphrase");
}

export function readPassphraseFile(): string | undefined {
  const p = passphrasePath();
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8").trim() || undefined;
}

export function writePassphraseFile(passphrase: string): void {
  const p = passphrasePath();
  mkdirSync(join(homedir(), ".vibebook"), { recursive: true });
  writeFileSync(p, passphrase + "\n", { mode: 0o600 });
  // writeFileSync's `mode` only applies on file create; chmod again to handle
  // the overwrite case (file already existed with looser perms).
  chmodSync(p, 0o600);
}
