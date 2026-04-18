import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { LlmRunner } from "./runner.js";
import {
  type BookIndex,
  type BookEntry,
  type ChapterEntry,
  upsertChapter,
} from "./book-index.js";
import { loadPromptAsset } from "./prompt-loader.js";

/**
 * Bump when the chapter prompt or output format changes in a way that should
 * force regeneration of every chapter.md. A bump forces regeneration via
 * chapterNeedsRewrite (existing entries with an older chapterVersion are stale).
 */
export const CHAPTER_VERSION = 1;

const CHAPTER_PROMPT = loadPromptAsset(import.meta.url, "chapter");

export interface ChapterArticleSummary {
  threadId: string;
  articleVersion: number;
  latestSourceSha: string;
}

export type GenerateChapterResult =
  | { status: "ok"; chapterPath: string }
  | { status: "no-articles" }
  | { status: "failed"; error: string };

/**
 * SHA-256 over the project's publishable articles, sorted by threadId ASC.
 * Per entry: threadId + "\0" + articleVersion + "\0" + latestSourceSha + "\0".
 * Domain prefix prevents collisions with other hashes in the codebase.
 */
export function computeChapterArticleHash(articles: ChapterArticleSummary[]): string {
  const sorted = articles.slice().sort((a, b) =>
    a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0,
  );
  const h = createHash("sha256");
  h.update("memvc:book:chapter:v1");
  for (const a of sorted) {
    h.update("\0");
    h.update(a.threadId);
    h.update("\0");
    h.update(String(a.articleVersion));
    h.update("\0");
    h.update(a.latestSourceSha);
  }
  return h.digest("hex");
}

/** Filter the BookIndex to publishable BookEntries for one project. */
function publishableArticlesFor(bookIndex: BookIndex, project: string): BookEntry[] {
  const out: BookEntry[] = [];
  for (const e of Object.values(bookIndex.threads)) {
    if (e.project !== project) continue;
    if (e.articleStatus === "failed") continue;
    if (e.skip) continue;
    if (!e.articlePath) continue;
    out.push(e);
  }
  return out;
}

function summaryFor(e: BookEntry): ChapterArticleSummary {
  return {
    threadId: e.threadId,
    articleVersion: e.articleVersion,
    latestSourceSha: e.latestSourceSha,
  };
}

export function chapterNeedsRewrite(bookIndex: BookIndex, project: string): boolean {
  const articles = publishableArticlesFor(bookIndex, project);
  const existing = bookIndex.chapters[project];
  if (articles.length === 0) {
    // No publishable articles: preserve any prior chapter.md and ChapterEntry
    // unchanged (don't tear down a chapter just because every thread became
    // skip/failed). A future spec change can revisit this.
    return false;
  }
  if (!existing) return true;
  if (existing.chapterVersion !== CHAPTER_VERSION) return true;
  const currentHash = computeChapterArticleHash(articles.map(summaryFor));
  return currentHash !== existing.latestArticleHash;
}

/**
 * Render the {{articles}} variable: each publishable article's body, newest
 * first, separated by a header line so the LLM can tell them apart.
 */
function renderArticlesVar(repoRoot: string, articles: BookEntry[]): string {
  const sorted = articles.slice().sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
  });
  const parts: string[] = [];
  for (const e of sorted) {
    const body = readFileSync(join(repoRoot, e.articlePath), "utf8");
    parts.push(`--- ARTICLE ${e.threadId} (${e.updatedAt}) ---\n${body}`);
  }
  return parts.join("\n\n");
}

export async function generateChapter(
  runner: LlmRunner,
  repoRoot: string,
  project: string,
  bookIndex: BookIndex,
): Promise<GenerateChapterResult> {
  const articles = publishableArticlesFor(bookIndex, project);
  if (articles.length === 0) return { status: "no-articles" };

  let articlesVar: string;
  try {
    articlesVar = renderArticlesVar(repoRoot, articles);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  let res;
  try {
    res = await runner.run(
      CHAPTER_PROMPT,
      { articles: articlesVar },
      { outputFormat: "text" },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  if (!res.ok) return { status: "failed", error: res.error };

  const chapterPath = join("book", project, "chapter.md");
  try {
    const abs = join(repoRoot, chapterPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.text);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  const entry: ChapterEntry = {
    chapterVersion: CHAPTER_VERSION,
    lastFullRewrite: new Date().toISOString(),
    latestArticleHash: computeChapterArticleHash(articles.map(summaryFor)),
  };
  upsertChapter(bookIndex, project, entry);
  return { status: "ok", chapterPath };
}
