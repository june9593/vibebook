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

export interface DigestOptions {
  /** When true, run the --redo recovery pipeline. */
  redo?: boolean;
  /** When true, wipe book/ + .memvc/index.book.json then run digest fresh. */
  reset?: boolean;
}

/**
 * `memvc digest --redo` entrypoint: reads config, loads indexes from disk,
 * runs the redo pipeline, persists, and (when push is configured) commits +
 * pushes the book changes onto the device branch.
 *
 * Without `--redo` we currently print a help message — `memvc sync` is the
 * canonical way to drive the pipeline for new content.
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
    console.log(chalk.yellow(
      "Nothing to do without --redo. Use `memvc sync` for the regular pipeline,\n" +
      "or `memvc digest --redo` to retry failed articles + force-rewrite all chapters.",
    ));
    return;
  }

  const cfg = readConfigWithMigration();
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
      console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.slice(0, 200)}`));
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
    const paths = [
      ".memvc/index.book.json",
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      // Stage every project's articles dir so any newly-written article files
      // get added (analogous to sync.ts's collectDigestPaths).
      ...uniqueProjectsFromReport(report).map((p) => `book/${p}/articles`),
    ];
    const r = await commitAndPush(
      git,
      `memvc digest --redo: ${report.threadsRecovered} recovered, ${report.chaptersRewritten.length} chapters`,
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
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * `memvc digest --reset` entrypoint: wipes book/ + .memvc/index.book.json,
 * then runs runDigest from scratch and (when configured) commits/pushes.
 */
async function runDigestResetCmd(): Promise<void> {
  const cfg = readConfigWithMigration();
  console.log(chalk.yellow(
    `memvc digest --reset: wiping book/ and .memvc/index.book.json under ${cfg.repoPath}`,
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
      console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.slice(0, 200)}`));
    }
  }

  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* ok if offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = [
      ".memvc/index.book.json",
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      ...uniqueProjectsFromReport(report).map((p) => `book/${p}/articles`),
    ];
    const r = await commitAndPush(
      git,
      `memvc digest --reset: ${report.articlesOk} articles, ${report.chaptersRewritten.length} chapters`,
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
 * Wipe book/ + .memvc/index.book.json under repoPath, then load index, build
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
  const bookDir = join(args.repoPath, "book");
  const bookIndexPath = join(args.repoPath, ".memvc", "index.book.json");
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
