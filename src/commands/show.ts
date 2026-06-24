import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";
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
  const mdRel = hit.relativePath.replace(/\.raw\.json$/, ".md");
  const abs = join(cfg.repoPath, mdRel);
  process.stdout.write(readFileSync(abs).toString("utf8"));
}
