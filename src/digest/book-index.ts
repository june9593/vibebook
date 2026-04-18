import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const REL = ".memvc/index.book.json";

export interface BookEntry {
  threadId: string;
  project: string;
  title: string;
  sessionIds: string[];
  articlePath: string;
  articleVersion: number;
  latestSourceSha: string;
  articleStatus: "ok" | "failed";
  articleError?: string;
  skip?: boolean;
  skipReason?: string;
  updatedAt: string; // ISO
}

export interface ChapterEntry {
  chapterVersion: number;
  lastFullRewrite: string; // ISO
  latestArticleHash: string;
}

export interface BookIndex {
  version: 1;
  threads: Record<string, BookEntry>;
  chapters: Record<string, ChapterEntry>;
}

export function loadBookIndex(repoRoot: string): BookIndex {
  const p = join(repoRoot, REL);
  if (!existsSync(p)) return { version: 1, threads: {}, chapters: {} };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as BookIndex;
  if (parsed.version !== 1) throw new Error(`unsupported book index version: ${parsed.version}`);
  if (!parsed.threads || typeof parsed.threads !== "object") {
    throw new Error("index.book.json malformed: missing or invalid 'threads'");
  }
  if (!parsed.chapters || typeof parsed.chapters !== "object") {
    throw new Error("index.book.json malformed: missing or invalid 'chapters'");
  }
  return parsed;
}

export function saveBookIndex(repoRoot: string, idx: BookIndex): void {
  const dir = join(repoRoot, ".memvc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, REL), JSON.stringify(idx, null, 2) + "\n");
}

export function upsertThread(idx: BookIndex, entry: BookEntry): void {
  idx.threads[entry.threadId] = entry;
}

export function upsertChapter(idx: BookIndex, project: string, entry: ChapterEntry): void {
  idx.chapters[project] = entry;
}

/**
 * Stable hash over the ordered concatenation of per-session source shas.
 * Used by Article generation to detect when a thread's underlying sessions
 * have changed and the article must be regenerated.
 *
 * Order matters — caller is expected to pass shas in a stable session order
 * (e.g. by endedAt ascending).
 */
export function latestSourceShaFor(sessionShas: string[]): string {
  const h = createHash("sha256");
  h.update("memvc:book:thread:v1");
  for (const s of sessionShas) {
    h.update("\0");
    h.update(s);
  }
  return h.digest("hex");
}
