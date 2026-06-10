import { readdirSync, statSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadIndex, saveIndex, keyFor } from "../index-store.js";
import type { Tool } from "../types.js";
import { ClaudeCodeAdapter } from "../sources/claude-code.js";
import { VSCodeCopilotAdapter } from "../sources/vscode-copilot.js";
import { CodexAdapter } from "../sources/codex.js";

export interface PruneOptions {
  /** When true, actually delete orphan files. Default false = dry-run. */
  apply?: boolean;
  /** Override repo path for tests. */
  repoPath?: string;
  /** When true, re-run discovery and remove stale index entries. */
  rescan?: boolean;
  /** Override claude root for tests (used with rescan). */
  claudeRoot?: string;
  /** Override vscode root for tests (used with rescan). */
  vscodeRoot?: string;
  /** Override codex root for tests (used with rescan). */
  codexRoot?: string;
}

export interface PruneResult {
  scanned: number;
  indexed: number;
  orphans: string[];
  deleted: string[];
  /** (rescan mode only) Keys of stale index entries found. */
  staleEntries?: string[];
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
 *
 * `--rescan` runs the INVERSE operation: re-discovers all source adapters
 * and removes index entries that are no longer produced (deduped /
 * empty-shell sessions). Only tools that were SUCCESSFULLY scanned are
 * eligible for pruning — a missing/erroring source never deletes entries.
 */
export async function pruneCmd(opts: PruneOptions = {}): Promise<PruneResult> {
  const cfg = readConfig();
  const repoPath = opts.repoPath ?? cfg.repoPath;
  const apply = opts.apply ?? false;

  if (opts.rescan) {
    return runRescan(repoPath, apply, opts);
  }

  // --- Original orphan-file mode ---
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
  sweepEmptyDirs(dirsTouched, join(repoPath, "raw_sessions"));

  console.log(chalk.green(`✓ deleted ${deleted.length} orphan(s)`));
  return { scanned: onDisk.length, indexed: indexed.size, orphans, deleted };
}

/**
 * Rescan mode: re-run discovery across all adapters, collect the set of
 * sessions that still produce non-empty results (validKeys), then find
 * index entries whose tool was successfully scanned but whose key is no
 * longer produced → stale entries to remove.
 *
 * Safety guarantee: if an adapter throws (missing root, permission error,
 * etc.), that tool's entries are NEVER flagged as stale. Only entries for
 * tools in `scannedTools` are eligible.
 */
async function runRescan(
  repoPath: string,
  apply: boolean,
  opts: PruneOptions,
): Promise<PruneResult> {
  const idx = loadIndex(repoPath);

  const adapters = [
    new ClaudeCodeAdapter(opts.claudeRoot),
    new VSCodeCopilotAdapter(opts.vscodeRoot),
    new CodexAdapter(opts.codexRoot),
  ] as const;

  const validKeys = new Set<string>();
  const scannedTools = new Set<Tool>();

  for (const adapter of adapters) {
    const tool = adapter.name as Tool;
    try {
      for await (const d of adapter.discover()) {
        let session;
        try {
          session = await d.load();
        } catch {
          // Unloadable session — skip; don't add to validKeys
          continue;
        }
        if (session.messages.length > 0) {
          validKeys.add(keyFor(tool, session.sessionId));
        }
      }
      // Mark as successfully scanned even if it yielded zero sessions
      scannedTools.add(tool);
    } catch (err) {
      console.log(chalk.yellow(`! ${tool} adapter error — skipping (won't prune ${tool} entries): ${(err as Error).message}`));
    }
  }

  // Stale = in index, tool was scanned, but key no longer produced
  const staleEntries: string[] = [];
  for (const [key, entry] of Object.entries(idx.entries)) {
    if (scannedTools.has(entry.tool) && !validKeys.has(key)) {
      staleEntries.push(key);
    }
  }

  if (staleEntries.length === 0) {
    console.log(chalk.green(`✓ no stale index entries found`));
    console.log(chalk.gray(`  scanned tools: ${[...scannedTools].join(", ") || "(none)"}`));
    return { scanned: 0, indexed: Object.keys(idx.entries).length, orphans: [], deleted: [], staleEntries: [] };
  }

  console.log(chalk.yellow(`found ${staleEntries.length} stale index entr${staleEntries.length === 1 ? "y" : "ies"}:`));
  for (const key of staleEntries) {
    const entry = idx.entries[key];
    console.log(`  ${key}  →  ${entry.relativePath}`);
  }
  console.log();

  if (!apply) {
    console.log(chalk.cyan(`dry-run — pass --apply to remove`));
    return { scanned: 0, indexed: Object.keys(idx.entries).length, orphans: [], deleted: [], staleEntries };
  }

  // Apply: collect the set of relativePaths still claimed by valid entries
  // (so we don't delete a file that's shared with a surviving entry — rare,
  // but defensive).
  const survivingPaths = new Set<string>();
  for (const [key, entry] of Object.entries(idx.entries)) {
    if (!staleEntries.includes(key)) {
      survivingPaths.add(entry.relativePath);
    }
  }

  const deleted: string[] = [];
  const dirsTouched = new Set<string>();

  for (const key of staleEntries) {
    const entry = idx.entries[key];
    // Remove from index
    delete idx.entries[key];
    // Delete .md only if no surviving entry still claims this path
    if (!survivingPaths.has(entry.relativePath)) {
      const abs = join(repoPath, entry.relativePath);
      if (existsSync(abs)) {
        try {
          unlinkSync(abs);
          deleted.push(entry.relativePath);
          dirsTouched.add(dirname(abs));
        } catch (err) {
          console.log(chalk.red(`! could not delete ${entry.relativePath}: ${(err as Error).message}`));
        }
      }
    }
  }

  saveIndex(repoPath, idx);
  sweepEmptyDirs(dirsTouched, join(repoPath, "raw_sessions"));

  console.log(chalk.green(`✓ removed ${staleEntries.length} stale entr${staleEntries.length === 1 ? "y" : "ies"}, deleted ${deleted.length} .md file(s)`));
  return { scanned: 0, indexed: Object.keys(idx.entries).length, orphans: [], deleted, staleEntries };
}

function sweepEmptyDirs(dirsTouched: Set<string>, rawRoot: string): void {
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
