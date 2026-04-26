import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { BOOK_INDEX_REL, dataDirAbs } from "../repo-data-dir.js";

/**
 * v2 BookIndex schema.
 *
 * Three independent product types live in `book/<project>/`:
 *   - chronicle/ — thread-grain diary entries (insert-only)
 *   - topics/    — mid-grain knowledge pages (cross-session, full-rewritten)
 *   - cards/     — atomic insight cards (per-project + _global)
 *
 * The index tracks every artifact's path + provenance so the publish step can
 * dedup (chronicle threadId, topic slug, card slug) and the TOC generator can
 * render a catalog without globbing the filesystem.
 */

export interface ChronicleEntry {
  /** Stable slug; filename derives from this. Insert-only. */
  threadId: string;
  /** Project the thread belongs to. */
  project: string;
  /** Human title (≤30 chars, frontmatter title). */
  title: string;
  /** Source session ids consumed to write this chronicle. */
  sessionIds: string[];
  /** Repo-relative path: book/<project>/chronicle/<filename>.md */
  path: string;
  /** ISO date — first ever write. */
  createdAt: string;
  /** ISO date — last regen (chronicles are typically write-once but
   *  /vibebook regenerate may overwrite later). */
  updatedAt: string;
  /** Tags from frontmatter (lowercase, ≤5). */
  tags: string[];
  /** True iff the LLM SKIP'd this thread; we still record it so re-runs
   *  don't keep re-considering the same sessions. */
  skip?: boolean;
  skipReason?: string;
}

export interface TopicEntry {
  /** Slug, kebab-case. */
  topicSlug: string;
  /** Project this topic page belongs to. */
  project: string;
  /** Repo-relative path: book/<project>/topics/<slug>.md */
  path: string;
  /** ISO date — first write. */
  createdAt: string;
  /** ISO date — last full-rewrite. */
  updatedAt: string;
  /** Threads that have contributed to this topic so far (chronicle threadIds). */
  contributingThreads: string[];
}

export interface CardEntry {
  /** Slug, kebab-case with type prefix (gotcha-/pattern-/decision-/howto-/tool-). */
  cardSlug: string;
  /** Per-project or "_global". */
  project: string;
  /** Card type (matches slug prefix). */
  type: "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other";
  /** Repo-relative path: book/<project>/cards/<slug>.md  OR
   *  book/_global/cards/<slug>.md */
  path: string;
  /** ISO date — first write. */
  createdAt: string;
  /** ISO date — last update. */
  updatedAt: string;
  /** Tags from frontmatter. */
  tags: string[];
}

export interface BookIndexV2 {
  version: 2;
  /** Keyed by threadId. */
  chronicles: Record<string, ChronicleEntry>;
  /** Keyed by `${project}/${topicSlug}` — same slug can recur across projects. */
  topics: Record<string, TopicEntry>;
  /** Keyed by `${project}/${cardSlug}` — same slug can recur (rare; usually
   *  per-project + a wikilink in _global). */
  cards: Record<string, CardEntry>;
}

/** Composite key helpers (kept here so callers don't free-form join with the wrong separator). */
export function topicKey(project: string, topicSlug: string): string {
  return `${project}/${topicSlug}`;
}
export function cardKey(project: string, cardSlug: string): string {
  return `${project}/${cardSlug}`;
}

/** Pre-existing v1 schema (read-only stub, used only by migration). */
interface BookIndexV1 {
  version: 1;
  threads: Record<string, {
    threadId: string;
    project: string;
    title: string;
    sessionIds: string[];
    articlePath: string;
    skip?: boolean;
    skipReason?: string;
    updatedAt: string;
  }>;
  chapters: Record<string, unknown>;
}

/**
 * Load `.vibebook/index.book.json`. Migrates v1 → v2 in-place on disk if
 * the file is still v1.
 *
 * v1 → v2 migration mapping:
 *   - threads → chronicles (path = articlePath; skipped entries are kept)
 *   - chapters → DROPPED (the chapter.md product is replaced by topics + cards)
 *   - createdAt/updatedAt: copied from v1.updatedAt as best-effort starting point
 *   - tags: empty (v1 didn't track them)
 *
 * The migration is destructive in the sense that v1 chapters are not preserved,
 * but the chapter.md files themselves remain on disk untouched (just orphaned
 * from the index). Users on v0.2 can `rm -rf book/<project>/chapter.md` if they
 * want them gone.
 */
export function loadBookIndexV2(repoRoot: string): BookIndexV2 {
  const p = join(repoRoot, BOOK_INDEX_REL);
  if (!existsSync(p)) {
    return { version: 2, chronicles: {}, topics: {}, cards: {} };
  }
  const parsed = JSON.parse(readFileSync(p, "utf8")) as { version: number };
  if (parsed.version === 2) return validateV2(parsed as unknown as BookIndexV2);
  if (parsed.version === 1) {
    const v1 = parsed as unknown as BookIndexV1;
    const migrated = migrateV1ToV2(v1);
    // Backup the v1 file before writing v2 so the user can recover.
    try {
      copyFileSync(p, p + ".v1.bak");
    } catch { /* best-effort */ }
    saveBookIndexV2(repoRoot, migrated);
    return migrated;
  }
  throw new Error(`unsupported book index version: ${parsed.version}`);
}

export function saveBookIndexV2(repoRoot: string, idx: BookIndexV2): void {
  mkdirSync(dataDirAbs(repoRoot), { recursive: true });
  writeFileSync(join(repoRoot, BOOK_INDEX_REL), JSON.stringify(idx, null, 2) + "\n");
}

function validateV2(idx: BookIndexV2): BookIndexV2 {
  if (idx.version !== 2) throw new Error(`expected v2, got ${(idx as { version: number }).version}`);
  if (!idx.chronicles || typeof idx.chronicles !== "object") {
    throw new Error("index.book.json v2 malformed: missing 'chronicles'");
  }
  if (!idx.topics || typeof idx.topics !== "object") {
    throw new Error("index.book.json v2 malformed: missing 'topics'");
  }
  if (!idx.cards || typeof idx.cards !== "object") {
    throw new Error("index.book.json v2 malformed: missing 'cards'");
  }
  return idx;
}

function migrateV1ToV2(v1: BookIndexV1): BookIndexV2 {
  const chronicles: Record<string, ChronicleEntry> = {};
  for (const [threadId, t] of Object.entries(v1.threads)) {
    chronicles[threadId] = {
      threadId,
      project: t.project,
      title: t.title,
      sessionIds: t.sessionIds,
      // v1 articlePath was book/<proj>/articles/<file>.md; we keep that path
      // verbatim — `vibebook publish` won't touch it because v2 chronicles
      // live under book/<proj>/chronicle/, so the old article files just
      // become orphaned data on disk. User can delete manually.
      path: t.articlePath,
      createdAt: t.updatedAt,
      updatedAt: t.updatedAt,
      tags: [],
      ...(t.skip ? { skip: true, skipReason: t.skipReason } : {}),
    };
  }
  return { version: 2, chronicles, topics: {}, cards: {} };
}

/** Insert a chronicle. Throws on threadId collision (chronicles are insert-only). */
export function insertChronicle(idx: BookIndexV2, entry: ChronicleEntry): void {
  if (idx.chronicles[entry.threadId]) {
    throw new Error(
      `chronicle threadId '${entry.threadId}' already exists ` +
      `(at ${idx.chronicles[entry.threadId].path}). Refusing to insert.`,
    );
  }
  idx.chronicles[entry.threadId] = entry;
}

/** Upsert a topic by composite (project, slug). Insert if new; update otherwise. */
export function upsertTopic(idx: BookIndexV2, entry: TopicEntry): void {
  idx.topics[topicKey(entry.project, entry.topicSlug)] = entry;
}

/** Upsert a card by composite (project, slug). */
export function upsertCard(idx: BookIndexV2, entry: CardEntry): void {
  idx.cards[cardKey(entry.project, entry.cardSlug)] = entry;
}
