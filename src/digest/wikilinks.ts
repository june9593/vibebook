import { posix, relative, dirname as nodeDirname } from "node:path";
import type { BookIndexV2, ChronicleEntry, CardEntry } from "../digest/book-index-v2.js";

/**
 * Resolve `[[wikilinks]]` in chronicle/topic/card bodies to real markdown
 * links. The skill writes nice human-friendly placeholders; we mechanically
 * rewrite them to actual relative paths so they work in any markdown viewer.
 *
 * Supported shapes:
 *   [[chronicle/<threadId>]]            → [<title>](../chronicle/<file>.md)
 *   [[<cardSlug>]]                      → [<cardSlug>](<relpath>.md)
 *   [[chronicle/<threadId>|alt text]]   → [alt text](...)  (alias form)
 *   [[<cardSlug>|alt text]]             → [alt text](...)
 *
 * Lookup rules:
 *   - threadId: must match a non-skip ChronicleEntry by `threadId`. Skipped
 *     chronicles have no path so they can't be linked to.
 *   - cardSlug: prefer same-project, then `_global`, then any other project.
 *     Cards are project-scoped but `_global` is the fallback pool.
 *
 * Unresolvable links are left as-is and reported back in `unresolved[]`. The
 * caller (publish.ts) prints them as a warning but doesn't fail.
 */

export interface ResolveContext {
  /** Repo-relative path of the file we're rewriting. Needed to compute
   *  relative paths to link targets. e.g. `book/edge-src/topics/foo.md`. */
  fromPath: string;
  /** Project slug of the file we're rewriting. Used as the "preferred"
   *  project when resolving bare card slugs. */
  fromProject: string;
  /** Book index after the current batch's chronicles + cards have been
   *  inserted, so newly-written artifacts are linkable. */
  bookIndex: BookIndexV2;
}

export interface ResolveResult {
  body: string;
  /** Links we couldn't resolve. Format: `chronicle/<threadId>` or `<cardSlug>`. */
  unresolved: string[];
}

const WIKILINK_RE = /\[\[([^\[\]\|]+?)(?:\|([^\[\]]+?))?\]\]/g;

export function resolveWikiLinks(body: string, ctx: ResolveContext): ResolveResult {
  const unresolved: string[] = [];
  const fromDir = nodeDirname(ctx.fromPath);

  const out = body.replace(WIKILINK_RE, (whole, target: string, alt?: string) => {
    const t = target.trim();
    const altText = alt?.trim();

    // Case 1: chronicle/<threadId>
    if (t.startsWith("chronicle/")) {
      const threadId = t.slice("chronicle/".length);
      const entry = findChronicleByThreadId(ctx.bookIndex, threadId);
      if (entry && entry.path) {
        const rel = posix.relative(fromDir, entry.path);
        const text = altText ?? entry.title ?? threadId;
        return `[${text}](${rel})`;
      }
      unresolved.push(t);
      return whole;
    }

    // Case 2: cards/<slug> (explicit prefix) or bare slug → card lookup,
    // prefer same project then _global.
    const cardSlug = t.startsWith("cards/") ? t.slice("cards/".length) : t;
    const card = findCardBySlug(ctx.bookIndex, cardSlug, ctx.fromProject);
    if (card && card.path) {
      const rel = posix.relative(fromDir, card.path);
      const text = altText ?? cardSlug;
      return `[${text}](${rel})`;
    }
    unresolved.push(t);
    return whole;
  });

  return { body: out, unresolved };
}

function findChronicleByThreadId(
  bookIndex: BookIndexV2,
  threadId: string,
): ChronicleEntry | undefined {
  // ChronicleEntries are keyed by threadId in `chronicles`, but we tolerate
  // a future schema change by walking values too.
  const direct = bookIndex.chronicles[threadId];
  if (direct && !direct.skip && direct.path) return direct;
  for (const c of Object.values(bookIndex.chronicles)) {
    if (c.threadId === threadId && !c.skip && c.path) return c;
  }
  return undefined;
}

function findCardBySlug(
  bookIndex: BookIndexV2,
  cardSlug: string,
  preferredProject: string,
): CardEntry | undefined {
  // Try same-project first, then _global, then any project.
  const candidates = Object.values(bookIndex.cards).filter((c) => c.cardSlug === cardSlug);
  if (candidates.length === 0) return undefined;
  return (
    candidates.find((c) => c.project === preferredProject) ??
    candidates.find((c) => c.project === "_global") ??
    candidates[0]
  );
}

// Suppress an unused-import warning; we keep `relative` alongside `posix.relative`
// in case future logic needs platform-aware path math (book/ is always posix on disk).
void relative;
