import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import chalk from "chalk";
import { readConfig, getPassphrase } from "../config.js";
import { loadIndex } from "../index-store.js";
import { decrypt, deriveKey } from "../crypto.js";
import type { IndexEntry } from "../types.js";

export async function showCmd(ref: string): Promise<void> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);
  const entries: IndexEntry[] = Object.values(idx.entries);
  const hit = entries.find((e) =>
    e.sessionId === ref ||
    e.shortId === ref ||
    e.nameSlug === ref ||
    e.displayName === ref
  );
  if (!hit) {
    console.log(chalk.red(`no session matching "${ref}"`));
    return;
  }
  const mdRel = hit.relativePath.replace(/\.raw\.json(\.enc)?$/, (m) =>
    m.endsWith(".enc") ? ".md.enc" : ".md");
  const abs = join(cfg.repoPath, mdRel);
  const data = readFileSync(abs);
  if (mdRel.endsWith(".enc")) {
    const key = deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"));
    process.stdout.write(decrypt(data, key).toString("utf8"));
  } else {
    process.stdout.write(data.toString("utf8"));
  }
}
