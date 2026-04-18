import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { LlmRunner } from "./runner.js";
import {
  type BookIndex,
  type BookEntry,
  upsertThread,
  latestSourceShaFor,
} from "./book-index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bump this when the article prompt or output format changes in a way that
 * makes older articles need regeneration. Stamped onto every BookEntry; the
 * pipeline glue (Sprint 2.8) compares against current to decide what to redo.
 */
export const ARTICLE_VERSION = 1;

function loadArticlePrompt(): string {
  // src/digest/article.ts → ../../assets/prompts/article.md  (and same from dist/)
  const p = join(__dirname, "..", "..", "assets", "prompts", "article.md");
  return readFileSync(p, "utf8");
}

const ARTICLE_PROMPT = loadArticlePrompt();

export interface ArticleInput {
  /** Stable thread id (slug, lowercase-hyphenated). Used as BookIndex key + filename. */
  threadId: string;
  /** Project slug — becomes a directory under book/. */
  project: string;
  /** Human title (Chinese, ≤ 20 chars). Stored on the BookEntry. */
  title: string;
  /** Session ids that belong to this thread. */
  sessionIds: string[];
  /** Source shas for the same sessions, in the same order — used to compute latestSourceSha. */
  sessionShas: string[];
  /** Pre-concatenated markdown of all sessions (caller-loaded; we don't read raw_sessions). */
  sessionsMd: string;
  /** ISO timestamp of the thread's most recent session — drives the YYYY-MM-DD filename prefix. */
  endedAt: string;
}

export type GenerateArticleResult =
  | { status: "ok"; articlePath: string }
  | { status: "skipped"; skipReason: string }
  | { status: "failed"; error: string };

/**
 * Build the relative path the article will be written to.
 * Format: book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md
 */
export function articleFilename(input: ArticleInput): string {
  const date = input.endedAt.slice(0, 10);
  const tid8 = input.threadId.slice(0, 8);
  return join("book", input.project, "articles", `${date}__${input.threadId}__${tid8}.md`);
}

/**
 * Generate one article for one thread.
 *
 * - Calls the runner in text mode (the response IS the markdown body).
 * - Detects the LLM's "SKIP: <reason>" sentinel at the start (after trim) and
 *   marks the BookEntry skip=true without writing a file.
 * - On any runner or IO failure, marks the BookEntry articleStatus="failed"
 *   and returns; never throws (per-thread failure isolation, spec §失败处理).
 *
 * Always upserts a BookEntry into `bookIndex` so the caller can persist with
 * a single saveBookIndex() at the end.
 */
export async function generateArticle(
  runner: LlmRunner,
  repoRoot: string,
  input: ArticleInput,
  bookIndex: BookIndex,
): Promise<GenerateArticleResult> {
  const nowIso = new Date().toISOString();
  const sourceSha = latestSourceShaFor(input.sessionShas);

  let res;
  try {
    res = await runner.run(
      ARTICLE_PROMPT,
      { title: input.title, sessionsMd: input.sessionsMd },
      { outputFormat: "text" },
    );
  } catch (e) {
    // Defensive: a well-behaved runner returns ok:false rather than throwing,
    // but we treat a thrown error the same way to preserve isolation.
    const error = e instanceof Error ? e.message : String(e);
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, error));
    return { status: "failed", error };
  }

  if (!res.ok) {
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, res.error));
    return { status: "failed", error: res.error };
  }

  const trimmed = res.text.trimStart();
  if (trimmed.startsWith("SKIP:")) {
    const skipReason = trimmed.slice("SKIP:".length).split(/\r?\n/, 1)[0]!.trim();
    const entry: BookEntry = {
      threadId: input.threadId,
      project: input.project,
      title: input.title,
      sessionIds: input.sessionIds,
      articlePath: "",
      articleVersion: ARTICLE_VERSION,
      latestSourceSha: sourceSha,
      articleStatus: "ok",
      skip: true,
      skipReason,
      updatedAt: nowIso,
    };
    upsertThread(bookIndex, entry);
    return { status: "skipped", skipReason };
  }

  const articlePath = articleFilename(input);
  try {
    const abs = join(repoRoot, articlePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.text);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, error));
    return { status: "failed", error };
  }

  const entry: BookEntry = {
    threadId: input.threadId,
    project: input.project,
    title: input.title,
    sessionIds: input.sessionIds,
    articlePath,
    articleVersion: ARTICLE_VERSION,
    latestSourceSha: sourceSha,
    articleStatus: "ok",
    updatedAt: nowIso,
  };
  upsertThread(bookIndex, entry);
  return { status: "ok", articlePath };
}

function failedEntry(
  input: ArticleInput,
  sourceSha: string,
  nowIso: string,
  error: string,
): BookEntry {
  return {
    threadId: input.threadId,
    project: input.project,
    title: input.title,
    sessionIds: input.sessionIds,
    articlePath: "",
    articleVersion: ARTICLE_VERSION,
    latestSourceSha: sourceSha,
    articleStatus: "failed",
    articleError: error,
    updatedAt: nowIso,
  };
}
