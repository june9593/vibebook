import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadBookIndexV2 } from "../digest/book-index-v2.js";
import { generateBookCatalog } from "../digest/book-catalog.js";
import { ensureRepo, ensureDeviceBranch, fastForwardBranch, commitAndPush } from "../git-ops.js";

export interface CatalogRegenOptions {
  /** Skip the git commit + push step. */
  noCommit?: boolean;
}

export interface CatalogRegenReport {
  /** Repo-rooted paths the catalog renderer wrote. */
  written: string[];
  committed: boolean;
  pushed: boolean;
}

/**
 * Regenerate every catalog file from the existing BookIndex on disk. The
 * global-mode `/vibebook` skill runs this once after subagent fan-out has
 * published into each project — that way the project subagents never thrash
 * the catalog and we get one consistent regen + one commit at the end.
 *
 * No book-index mutation; no chronicle/topic/card writes; the index is the
 * source of truth.
 */
export async function catalogRegenCmd(opts: CatalogRegenOptions): Promise<CatalogRegenReport> {
  const cfg = readConfig();
  const bookIndex = loadBookIndexV2(cfg.repoPath);
  const catalog = generateBookCatalog(cfg.repoPath, bookIndex);

  const report: CatalogRegenReport = {
    written: catalog.written,
    committed: false,
    pushed: false,
  };

  if (opts.noCommit || !cfg.repoUrl || !cfg.deviceBranch) return report;

  const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
  try { await git.fetch(); } catch { /* offline / empty */ }
  await ensureDeviceBranch(git, cfg.deviceBranch);
  try {
    await fastForwardBranch(git, cfg.deviceBranch, (s) => console.log(chalk.gray(`  ${s}`)));
  } catch (err) {
    console.log(chalk.red(`! could not sync with origin: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.cyan(`  Catalog regenerated locally; push skipped.`));
    return report;
  }
  const r = await commitAndPush(
    git,
    "vibebook: regen catalog",
    catalog.written,
    cfg.deviceBranch,
    (stage) => console.log(chalk.gray(`  ${stage}`)),
  );
  report.committed = r.committed;
  report.pushed = r.pushed;
  return report;
}
