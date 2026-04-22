import chalk from "chalk";
import { Buffer } from "node:buffer";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getPassphrase, type Config } from "../config.js";
import { readConfigWithMigration } from "./sync.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
import { loadIndex } from "../index-store.js";
import { loadBookIndex, saveBookIndex } from "../digest/book-index.js";
import { createRunner, type LlmRunner } from "../digest/runner.js";
import { runDigestRedo, type RedoReport } from "../digest/redo.js";
import { runDigest, type DigestReport } from "../digest/orchestrator.js";
import { consoleReporter } from "../digest/reporter.js";
import { deriveKey } from "../crypto.js";
import { migrateLegacyDataDir } from "../migrate.js";
import { BOOK_INDEX_REL, bookIndexAbs } from "../repo-data-dir.js";

export interface DigestOptions {
  /** When true, run the --redo recovery pipeline. */
  redo?: boolean;
  /** When true, wipe book/ + .vibebook/index.book.json then run digest fresh. */
  reset?: boolean;
}

/**
 * `vibebook digest` entrypoints:
 *
 *   - no flag        run digest pipeline (phases 3-7) over existing index.json
 *                    + book index, then push. CI uses this — local extract is
 *                    skipped because raw_sessions/ + index.json are already in
 *                    the checkout.
 *   - --redo         rerun failed articles + force-rewrite every chapter.
 *   - --reset        DESTRUCTIVE wipe of book/ + index.book.json, then run
 *                    digest from scratch.
 *
 * `vibebook sync` is what users run locally — it does extract first, then
 * delegates to the same digest pipeline.
 */
export async function digestCmd(opts: DigestOptions): Promise<void> {
  if (opts.reset && opts.redo) {
    console.log(chalk.red("Cannot use --reset and --redo together. Pick one."));
    return;
  }
  if (opts.reset) {
    return runDigestResetCmd();
  }
  if (!opts.redo) {
    return runDigestNoFlagCmd();
  }

  const cfg = readConfigWithMigration();
  // One-shot data-dir rename `.memvc/` → `.vibebook/` if needed, before any path-load.
  await migrateLegacyDataDir(cfg.repoPath);
  const key = cfg.encrypt
    ? deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"))
    : null;

  console.log(chalk.gray("Running digest --redo..."));
  const report = await runDigestRedoFromRepo({
    repoPath: cfg.repoPath,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
    key,
  });
  console.log(chalk.bold(
    `\n--redo: ${report.threadsRecovered} recovered / ${report.threadsNewlySkipped} newly-skipped / ${report.threadsStillFailed} still failed / ${report.threadsUnresolvable} unresolvable; ${report.chaptersRewritten.length} chapters rewritten`,
  ));
  if (report.articleFailures.length > 0) {
    for (const f of report.articleFailures) {
      console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.replace(/\s+/g, " ").slice(0, 200)}`));
    }
  }
  if (report.chaptersFailed.length > 0) {
    for (const f of report.chaptersFailed) {
      console.log(chalk.red(`  ! chapter ${f.project} failed: ${f.error}`));
    }
  }

  // git push
  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* may be offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = existingPaths(cfg.repoPath, [
      BOOK_INDEX_REL,
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      // Stage every project's articles dir so any newly-written article files
      // get added (analogous to sync.ts's collectDigestPaths).
      ...uniqueProjectsFromReport(report).map((p) => `book/${p}/articles`),
    ]);
    const r = await commitAndPush(
      git,
      `vibebook digest --redo: ${report.threadsRecovered} recovered, ${report.chaptersRewritten.length} chapters`,
      paths,
      cfg.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    if (r.committed) {
      console.log(chalk.cyan(r.pushed ? "Pushed (book)." : "Committed book (push failed)."));
    } else {
      console.log(chalk.gray("Nothing to commit."));
    }
  }
}

/**
 * Loads from-disk inputs and runs runDigestRedo. Test-injectable via `runner`
 * (when omitted, we build one from `runnerConfig`).
 */
export async function runDigestRedoFromRepo(args: {
  repoPath: string;
  runnerConfig: Pick<Config, "runner" | "runnerModel">;
  /** Test-only override for createRunner. */
  runner?: LlmRunner;
  /** AES key (when raw is encrypted); null otherwise. */
  key: Buffer | null;
}): Promise<RedoReport> {
  const idx = loadIndex(args.repoPath);
  const book = loadBookIndex(args.repoPath);
  const runner = args.runner ?? createRunner(args.runnerConfig);
  const report = await runDigestRedo(runner, args.repoPath, idx, book, args.key, consoleReporter());
  saveBookIndex(args.repoPath, book);
  return report;
}

export function uniqueProjectsFromReport(
  report: { chaptersRewritten: string[]; tocFilesWritten: string[] },
): string[] {
  const out = new Set<string>(report.chaptersRewritten);
  // Pull project names from per-chapter timeline paths in tocFilesWritten.
  // Skip `_meta` — it's the global-timeline pseudo-project (book/_meta/timeline.md),
  // not a real project, and has no articles dir.
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1] && m[1] !== "_meta") out.add(m[1]);
  }
  return [...out];
}

/**
 * Drop paths that don't exist on disk. `git add` is strict about pathspec
 * matches and aborts the whole add when any path is missing. Both --redo and
 * --reset assemble paths optimistically (e.g. articles dirs that may not
 * have been created yet); filter here before handing to commitAndPush.
 */
function existingPaths(repoRoot: string, paths: string[]): string[] {
  return paths.filter((p) => existsSync(join(repoRoot, p)));
}

/**
 * `vibebook digest` (no flag) entrypoint: runs the full digest pipeline
 * (phases 3-7) over the existing index.json + book index, then commits/pushes.
 *
 * Used by CI: the GH Action checks out the device branch (which already has
 * raw_sessions/ + index.json from the latest local sync), then needs to turn
 * those into articles using the configured runner. There's no local
 * ~/.claude/ to extract from in CI, so the extract phase is skipped.
 */
async function runDigestNoFlagCmd(): Promise<void> {
  const cfg = readConfigWithMigration();
  await migrateLegacyDataDir(cfg.repoPath);
  const key = cfg.encrypt
    ? deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"))
    : null;

  console.log(chalk.gray("Running digest pipeline (phases 3-7)..."));
  const idx = loadIndex(cfg.repoPath);
  const book = loadBookIndex(cfg.repoPath);
  const runner = createRunner({ runner: cfg.runner, runnerModel: cfg.runnerModel });
  const report = await runDigest(
    runner, cfg.repoPath, idx, book, key,
    cfg.threadingConcurrency, cfg.threadingMaxAttempts, consoleReporter(),
  );
  saveBookIndex(cfg.repoPath, book);
  console.log(chalk.bold(
    `\ndigest: +${report.articlesOk} articles, ${report.threadsSkipped} skip, ${report.articlesFailed} fail; chapters [${report.chaptersRewritten.join(", ")}]`,
  ));
  if (report.articleFailures.length > 0) {
    for (const f of report.articleFailures) {
      console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.replace(/\s+/g, " ").slice(0, 200)}`));
    }
  }

  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* ok if offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = existingPaths(cfg.repoPath, [
      BOOK_INDEX_REL,
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      ...uniqueProjectsFromReport(report).map((p) => `book/${p}/articles`),
    ]);
    const r = await commitAndPush(
      git,
      `vibebook digest: +${report.articlesOk} articles, ${report.chaptersRewritten.length} chapters`,
      paths,
      cfg.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    if (r.committed) {
      console.log(chalk.cyan(r.pushed ? "Pushed (book)." : "Committed book (push failed)."));
    } else {
      console.log(chalk.gray("Nothing to commit."));
    }
  }
}

/**
 * `vibebook digest --reset` entrypoint: wipes book/ + .vibebook/index.book.json,
 * then runs runDigest from scratch and (when configured) commits/pushes.
 */
async function runDigestResetCmd(): Promise<void> {
  const cfg = readConfigWithMigration();
  console.log(chalk.yellow(
    `vibebook digest --reset: wiping book/ and ${BOOK_INDEX_REL} under ${cfg.repoPath}`,
  ));
  const key = cfg.encrypt
    ? deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"))
    : null;

  const report = await runDigestResetFromRepo({
    repoPath: cfg.repoPath,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
    key,
    threadingConcurrency: cfg.threadingConcurrency,
    threadingMaxAttempts: cfg.threadingMaxAttempts,
  });

  console.log(chalk.bold(
    `\n--reset complete: +${report.articlesOk} articles, ${report.threadsSkipped} skip, ${report.articlesFailed} failed; ${report.chaptersRewritten.length} chapters`,
  ));
  if (report.articleFailures.length > 0) {
    for (const f of report.articleFailures) {
      console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.replace(/\s+/g, " ").slice(0, 200)}`));
    }
  }

  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* ok if offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = existingPaths(cfg.repoPath, [
      BOOK_INDEX_REL,
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      ...uniqueProjectsFromReport(report).map((p) => `book/${p}/articles`),
    ]);
    const r = await commitAndPush(
      git,
      `vibebook digest --reset: ${report.articlesOk} articles, ${report.chaptersRewritten.length} chapters`,
      paths,
      cfg.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    if (r.committed) {
      console.log(chalk.cyan(r.pushed ? "Pushed (book)." : "Committed book (push failed)."));
    } else {
      console.log(chalk.gray("Nothing to commit."));
    }
  }
}

/**
 * Wipe book/ + .vibebook/index.book.json under repoPath, then load index, build
 * a fresh empty BookIndex, run runDigest, and persist. Test-injectable via
 * `runner` (when omitted, built from runnerConfig).
 */
export async function runDigestResetFromRepo(args: {
  repoPath: string;
  runnerConfig: Pick<Config, "runner" | "runnerModel">;
  /** Test-only override for createRunner. */
  runner?: LlmRunner;
  /** AES key (when raw is encrypted); null otherwise. */
  key: Buffer | null;
  threadingConcurrency?: number;
  threadingMaxAttempts?: number;
}): Promise<DigestReport> {
  // Run data-dir migration before path resolution so wiping picks up the new path.
  await migrateLegacyDataDir(args.repoPath);
  const bookDir = join(args.repoPath, "book");
  const bookIndexPath = bookIndexAbs(args.repoPath);
  if (existsSync(bookDir)) rmSync(bookDir, { recursive: true, force: true });
  if (existsSync(bookIndexPath)) rmSync(bookIndexPath, { force: true });

  const idx = loadIndex(args.repoPath);
  const book = loadBookIndex(args.repoPath); // empty after wipe
  const runner = args.runner ?? createRunner(args.runnerConfig);
  const report = await runDigest(
    runner, args.repoPath, idx, book, args.key,
    args.threadingConcurrency, args.threadingMaxAttempts, consoleReporter(),
  );
  saveBookIndex(args.repoPath, book);
  return report;
}
