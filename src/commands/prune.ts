import { readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";

export interface PruneOptions {
  /** When true, actually delete orphan files. Default false = dry-run. */
  apply?: boolean;
  /** Override repo path for tests. */
  repoPath?: string;
}

export interface PruneResult {
  scanned: number;
  indexed: number;
  orphans: string[];
  deleted: string[];
}

/**
 * `vibebook prune` — find raw_sessions/*.md files on disk that are NOT
 * referenced by `.vibebook/index.json` and (optionally) delete them.
 *
 * Why this exists: pre-0.7.1 the Copilot adapter could write the same
 * sessionId to two different .md paths (chatSessions/ + transcripts/ both
 * extracted as separate sources, different nameSlug/date, only one wins
 * in the index). The losing write left an orphan .md on disk. 0.7.1 dedupes
 * at discover time so new orphans stop accruing — `prune` cleans up the
 * pre-existing ones.
 *
 * Dry-run by default. Pass `--apply` to actually delete. Empty parent
 * directories are removed after their last file goes away.
 */
export async function pruneCmd(opts: PruneOptions = {}): Promise<PruneResult> {
  const cfg = readConfig();
  const repoPath = opts.repoPath ?? cfg.repoPath;
  const apply = opts.apply ?? false;

  const idx = loadIndex(repoPath);
  const indexed = new Set<string>();
  for (const e of Object.values(idx.entries)) indexed.add(e.relativePath);

  const rawRoot = join(repoPath, "raw_sessions");
  const onDisk = walkMd(rawRoot, repoPath);

  const orphans = onDisk.filter((rel) => !indexed.has(rel));
  const deleted: string[] = [];

  if (orphans.length === 0) {
    console.log(chalk.green(`✓ no orphan .md files in ${rawRoot}`));
    console.log(chalk.gray(`  scanned ${onDisk.length}, indexed ${indexed.size}`));
    return { scanned: onDisk.length, indexed: indexed.size, orphans, deleted };
  }

  console.log(chalk.yellow(`found ${orphans.length} orphan .md file(s) (on disk but not in index):`));
  for (const o of orphans) console.log(`  ${o}`);
  console.log();

  if (!apply) {
    console.log(chalk.cyan(`dry-run — pass --apply to delete`));
    return { scanned: onDisk.length, indexed: indexed.size, orphans, deleted };
  }

  // Apply: delete each orphan + sweep its parent dir if empty
  const dirsTouched = new Set<string>();
  for (const o of orphans) {
    const abs = join(repoPath, o);
    try {
      unlinkSync(abs);
      deleted.push(o);
      dirsTouched.add(dirname(abs));
    } catch (err) {
      console.log(chalk.red(`! could not delete ${o}: ${(err as Error).message}`));
    }
  }
  // Sweep empty dirs upward from each touched dir until we hit a non-empty
  // ancestor or escape rawRoot. We stop short of rawRoot itself.
  for (const d of dirsTouched) {
    let cur = d;
    while (cur.startsWith(rawRoot) && cur !== rawRoot) {
      let entries: string[] = [];
      try { entries = readdirSync(cur); } catch { break; }
      if (entries.length > 0) break;
      try { rmdirSync(cur); } catch { break; }
      cur = dirname(cur);
    }
  }

  console.log(chalk.green(`✓ deleted ${deleted.length} orphan(s)`));
  return { scanned: onDisk.length, indexed: indexed.size, orphans, deleted };
}

function walkMd(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(relative(repoRoot, p));
      }
    }
  }
  // Sanity: skip empty if rawRoot doesn't exist
  void statSync;
  return out;
}
