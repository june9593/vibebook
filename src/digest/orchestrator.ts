import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { LlmRunner } from "./runner.js";
import type { IndexFile, IndexEntry } from "../types.js";
import {
  type BookIndex,
  type BookEntry,
  loadBookIndex as _unused1, // import side-effect-free anchor; actual load is caller's job
} from "./book-index.js";
import { makeBatches } from "./batcher.js";
import { runThreading } from "./threading.js";
import {
  ARTICLE_VERSION,
  generateArticle,
  type ArticleInput,
} from "./article.js";
import {
  chapterNeedsRewrite,
  generateChapter,
} from "./chapter.js";
import { generateToc } from "./toc.js";
import {
  findNewSessionEntries,
  buildBatchingInput,
  recordSkippedThreadCandidates,
  buildArticleInputs,
} from "./pipeline.js";

// Marker so the unused import doesn't get tree-shaken or linted away.
void _unused1;

export interface DigestReport {
  newSessions: number;
  threadCandidates: number;
  threadsSkipped: number;
  articlesOk: number;
  articlesSkipped: number;
  articlesFailed: number;
  chaptersRewritten: string[];
  chaptersFailed: { project: string; error: string }[];
  tocFilesWritten: string[];
}

/**
 * Run digest pipeline phases 3-7 (plan / thread / article / chapter / toc).
 * Mutates `bookIndex` in place; caller persists.
 *
 * Failure isolation: thread phase throws → propagates (toc skipped). Article
 * single-thread failure → counted, isolated by generateArticle's contract.
 * Chapter single-project failure → counted, prior chapter preserved by
 * generateChapter's contract.
 */
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
): Promise<DigestReport> {
  // -------------------------------------------------------------- plan
  const newEntries = findNewSessionEntries(indexFile, bookIndex);
  const report: DigestReport = {
    newSessions: newEntries.length,
    threadCandidates: 0,
    threadsSkipped: 0,
    articlesOk: 0,
    articlesSkipped: 0,
    articlesFailed: 0,
    chaptersRewritten: [],
    chaptersFailed: [],
    tocFilesWritten: [],
  };

  // -------------------------------------------------------------- thread
  let articleInputs: ArticleInput[] = [];
  if (newEntries.length > 0) {
    const sessionsForBatching = buildBatchingInput(newEntries, repoRoot);
    const batches = makeBatches(sessionsForBatching);
    const candidates = await runThreading(runner, batches);
    report.threadCandidates = candidates.length;
    report.threadsSkipped = recordSkippedThreadCandidates(bookIndex, candidates, indexFile).length;
    articleInputs = buildArticleInputs(candidates, indexFile, repoRoot);
  }

  // ------------------------------ stale-thread re-generation (article-version drift)
  // Spec line 99: BookEntries whose articleVersion is below current need rewrite.
  // We don't include failed (those are 2.9 --redo) or skip threads.
  const staleInputs = buildStaleArticleInputs(bookIndex, indexFile, repoRoot);
  const allArticleInputs = articleInputs.concat(staleInputs);

  // Track which projects had any article touched, so chapter phase only
  // considers them (in addition to chapterNeedsRewrite's own gate).
  const touchedProjects = new Set<string>();
  for (const input of allArticleInputs) touchedProjects.add(input.project);

  // -------------------------------------------------------------- article
  for (const input of allArticleInputs) {
    const res = await generateArticle(runner, repoRoot, input, bookIndex);
    if (res.status === "ok") report.articlesOk++;
    else if (res.status === "skipped") report.articlesSkipped++;
    else report.articlesFailed++;
  }

  // -------------------------------------------------------------- chapter
  // Consider any project with a touched article OR an existing entry whose hash
  // would change. We only call chapterNeedsRewrite for the touched set — we
  // assume untouched projects' hashes can't have shifted.
  for (const project of Array.from(touchedProjects).sort()) {
    if (!chapterNeedsRewrite(bookIndex, project)) continue;
    const res = await generateChapter(runner, repoRoot, project, bookIndex);
    if (res.status === "ok") report.chaptersRewritten.push(project);
    else if (res.status === "failed") report.chaptersFailed.push({ project, error: res.error });
    // "no-articles" → silent: nothing to do.
  }

  // -------------------------------------------------------------- toc
  const tocResult = generateToc(repoRoot, bookIndex);
  report.tocFilesWritten = tocResult.written;

  return report;
}

/**
 * Find BookEntries that need a stale-version regeneration:
 *   - articleStatus === "ok"
 *   - !skip
 *   - articleVersion !== ARTICLE_VERSION
 *
 * For each, build an ArticleInput from the recorded sessionIds (looked up in
 * indexFile). If any sessionId is missing from indexFile, log + skip the
 * regeneration (the underlying raw is gone; nothing we can do here).
 */
function buildStaleArticleInputs(
  bookIndex: BookIndex,
  indexFile: IndexFile,
  repoRoot: string,
): ArticleInput[] {
  const out: ArticleInput[] = [];
  const lookup = new Map<string, IndexEntry>();
  for (const e of Object.values(indexFile.entries)) lookup.set(e.sessionId, e);

  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus === "failed") continue;
    if (be.articleVersion === ARTICLE_VERSION) continue;

    const entries: IndexEntry[] = [];
    let missing = false;
    for (const sid of be.sessionIds) {
      const ie = lookup.get(sid);
      if (!ie) {
        console.warn(`orchestrator.ts: stale thread ${be.threadId} references unknown sessionId ${sid} — skipping rewrite`);
        missing = true;
        break;
      }
      entries.push(ie);
    }
    if (missing) continue;

    entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

    const bodies: string[] = [];
    for (const e of entries) {
      if (e.relativePath.endsWith(".enc")) {
        throw new Error(`orchestrator.ts: encrypted sessions not supported (got ${e.relativePath})`);
      }
      const body = readFileSync(join(repoRoot, e.relativePath), "utf8");
      bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
    }

    out.push({
      threadId: be.threadId,
      project: be.project,
      title: be.title,
      sessionIds: entries.map((e) => e.sessionId),
      sessionShas: entries.map((e) => e.sourceSha256),
      sessionsMd: bodies.join("\n\n"),
      endedAt: entries[entries.length - 1]!.endedAt,
    });
  }
  return out;
}
