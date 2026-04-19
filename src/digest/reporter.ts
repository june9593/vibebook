import chalk from "chalk";

/**
 * Tiny progress reporter passed into runDigest / runDigestRedo / runDigestReset.
 * Each method is called as the named phase makes observable progress, so the
 * user can see "the thing isn't frozen" during 20+ minute digest runs.
 *
 * Implementations MUST be cheap and synchronous — they're called from inside
 * tight loops in the orchestrator and downstream modules.
 */
export interface Reporter {
  /** Called once at the start of the threading phase with the batch count. */
  threadingStart(batchCount: number): void;
  /** Called when a single threading batch completes (success or soft-fail). */
  threadingBatchDone(batchIndex: number, batchCount: number, durationMs: number, ok: boolean): void;
  /** Called once at the start of the article phase with the count to process. */
  articleStart(threadCount: number): void;
  /** Called when a single article completes (ok / skipped / failed). */
  articleDone(threadId: string, status: "ok" | "skipped" | "failed", durationMs: number): void;
  /** Called once at the start of the chapter phase with the count of projects. */
  chapterStart(projectCount: number): void;
  /** Called when a single chapter rewrite completes. */
  chapterDone(project: string, status: "ok" | "no-articles" | "failed", durationMs: number): void;
  /** Called once at the start of the toc phase. */
  tocStart(): void;
  /** Called when toc completes with the count of files written. */
  tocDone(filesWritten: number): void;
}

/**
 * Default reporter: prints `chalk.gray(...)` lines to stdout, terse but
 * informative. Used by every CLI entrypoint (sync, digest --redo, digest --reset).
 */
export function consoleReporter(): Reporter {
  return {
    threadingStart(n) {
      console.log(chalk.gray(`  threading: ${n} batch(es) to process...`));
    },
    threadingBatchDone(i, n, ms, ok) {
      const tag = ok ? chalk.gray("ok") : chalk.yellow("FAILED");
      console.log(chalk.gray(`  threading: batch ${i + 1}/${n} ${tag} (${ms}ms)`));
    },
    articleStart(n) {
      console.log(chalk.gray(`  articles: ${n} thread(s) to write...`));
    },
    articleDone(threadId, status, ms) {
      const tag =
        status === "ok" ? chalk.gray("ok")
        : status === "skipped" ? chalk.gray("skip")
        : chalk.yellow("FAILED");
      console.log(chalk.gray(`  article ${threadId}: ${tag} (${ms}ms)`));
    },
    chapterStart(n) {
      console.log(chalk.gray(`  chapters: ${n} project(s) eligible...`));
    },
    chapterDone(project, status, ms) {
      const tag =
        status === "ok" ? chalk.gray("ok")
        : status === "no-articles" ? chalk.gray("(none)")
        : chalk.yellow("FAILED");
      console.log(chalk.gray(`  chapter ${project}: ${tag} (${ms}ms)`));
    },
    tocStart() {
      console.log(chalk.gray(`  toc: writing...`));
    },
    tocDone(n) {
      console.log(chalk.gray(`  toc: ${n} file(s) written`));
    },
  };
}

/**
 * No-op reporter for tests that don't care about progress lines.
 * Use silentReporter() rather than passing consoleReporter() in tests
 * to avoid polluting test output.
 */
export function silentReporter(): Reporter {
  return {
    threadingStart() {},
    threadingBatchDone() {},
    articleStart() {},
    articleDone() {},
    chapterStart() {},
    chapterDone() {},
    tocStart() {},
    tocDone() {},
  };
}
