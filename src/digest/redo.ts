import type { LlmRunner } from "./runner.js";
import type { IndexFile } from "../types.js";
import { Buffer } from "node:buffer";
import type { BookIndex } from "./book-index.js";
import { generateArticle } from "./article.js";
import { generateChapter } from "./chapter.js";
import { generateToc } from "./toc.js";
import { buildArticleInputForThread } from "./pipeline.js";

export interface RedoReport {
  threadsAttempted: number;
  threadsRecovered: number;
  threadsStillFailed: number;
  /** Threads whose retry returned a SKIP sentinel (now skip:true in BookIndex). */
  threadsNewlySkipped: number;
  threadsUnresolvable: number;
  chaptersRewritten: string[];
  chaptersFailed: { project: string; error: string }[];
  tocFilesWritten: string[];
}

/**
 * Re-run failed threads and force-rewrite every chapter.
 *
 * Phase 1: for every BookEntry with articleStatus === "failed" (and !skip),
 *   build an ArticleInput from its recorded sessionIds (looked up in indexFile)
 *   and call generateArticle. Track recovered / still-failed / unresolvable.
 *
 * Phase 2: for every project that has ≥1 publishable article, call
 *   generateChapter unconditionally (skip the chapterNeedsRewrite gate, since
 *   `--redo` is exactly for force-rewriting). Chapter failures are isolated.
 *
 * Phase 3: generateToc runs always.
 *
 * Mutates `bookIndex` in place. Caller persists with saveBookIndex.
 */
export async function runDigestRedo(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null = null,
): Promise<RedoReport> {
  const report: RedoReport = {
    threadsAttempted: 0,
    threadsRecovered: 0,
    threadsStillFailed: 0,
    threadsNewlySkipped: 0,
    threadsUnresolvable: 0,
    chaptersRewritten: [],
    chaptersFailed: [],
    tocFilesWritten: [],
  };

  // ----------------------------------------------------- Phase 1: retry failed
  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus !== "failed") continue;

    const input = buildArticleInputForThread(
      be.threadId,
      be.title,
      be.sessionIds,
      indexFile,
      repoRoot,
      "redo.ts",
      key,
    );
    if (input === null) {
      // sessionIds couldn't be resolved (pipeline.ts already warned) — leave as failed.
      report.threadsUnresolvable++;
      continue;
    }

    report.threadsAttempted++;
    const res = await generateArticle(runner, repoRoot, input, bookIndex);
    if (res.status === "ok") {
      report.threadsRecovered++;
    } else if (res.status === "skipped") {
      report.threadsNewlySkipped++;
    } else {
      report.threadsStillFailed++;
    }
  }

  // ----------------------------------- Phase 2: force-rewrite ALL chapters
  const projects = collectProjectsWithArticles(bookIndex);
  for (const project of Array.from(projects).sort()) {
    const res = await generateChapter(runner, repoRoot, project, bookIndex);
    if (res.status === "ok") report.chaptersRewritten.push(project);
    else if (res.status === "failed") report.chaptersFailed.push({ project, error: res.error });
    // "no-articles" → silent skip.
  }

  // ----------------------------------------------------- Phase 3: toc
  const tocResult = generateToc(repoRoot, bookIndex);
  report.tocFilesWritten = tocResult.written;

  return report;
}

/**
 * Projects appearing in any non-skip, non-failed BookEntry. Each gets
 * force-rewritten. (Failed-and-still-failed projects with no other articles
 * yield "no-articles" from generateChapter, which is silently skipped.)
 */
function collectProjectsWithArticles(bookIndex: BookIndex): Set<string> {
  const out = new Set<string>();
  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus === "failed") continue;
    out.add(be.project);
  }
  return out;
}
