import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexFile, IndexEntry } from "../types.js";
import {
  type BookIndex,
  type BookEntry,
  upsertThread,
} from "./book-index.js";
import type { SessionForBatching, ThreadCandidate } from "./types.js";
import { ARTICLE_VERSION, type ArticleInput } from "./article.js";

/**
 * IndexEntries that the BookIndex hasn't accounted for yet. An entry is
 * "covered" iff its sessionId appears in some BookEntry.sessionIds.
 *
 * Result is sorted by endedAt ASC — the order downstream batching/article
 * generation expects.
 */
export function findNewSessionEntries(
  indexFile: IndexFile,
  bookIndex: BookIndex,
): IndexEntry[] {
  const covered = new Set<string>();
  for (const be of Object.values(bookIndex.threads)) {
    for (const sid of be.sessionIds) covered.add(sid);
  }
  const out: IndexEntry[] = [];
  for (const e of Object.values(indexFile.entries)) {
    if (!covered.has(e.sessionId)) out.push(e);
  }
  out.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  return out;
}

/**
 * Read each entry's session .md from disk and produce SessionForBatching[].
 * Tokens estimated as ceil(chars / 3.5).
 *
 * Throws on a missing/unreadable .md (upstream extract is broken — fail loud)
 * and on .enc paths (encryption + digest pipeline isn't supported in 2.8.x).
 */
export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
): SessionForBatching[] {
  const out: SessionForBatching[] = [];
  for (const e of entries) {
    if (e.relativePath.endsWith(".enc")) {
      throw new Error(
        `pipeline.ts: encrypted sessions not supported in digest pipeline (got ${e.relativePath})`,
      );
    }
    let body: string;
    try {
      body = readFileSync(join(repoRoot, e.relativePath), "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pipeline.ts: cannot read session ${e.relativePath}: ${msg}`);
    }
    out.push({
      sessionId: e.sessionId,
      project: e.project,
      endedAt: e.endedAt,
      tokenEstimate: Math.ceil(body.length / 3.5),
    });
  }
  return out;
}

/**
 * Persist skip:true BookEntries for each skip candidate so future syncs
 * don't reconsider them. Returns the list of skipped threadIds.
 */
export function recordSkippedThreadCandidates(
  bookIndex: BookIndex,
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
): string[] {
  const skipped: string[] = [];
  const nowIso = new Date().toISOString();
  const sessionLookup = sessionLookupBySid(indexFile);
  for (const c of candidates) {
    if (!c.skip) continue;
    const firstSid = c.sessionIds[0];
    const ie = firstSid ? sessionLookup.get(firstSid) : undefined;
    const project = ie?.project ?? "unknown";
    const entry: BookEntry = {
      threadId: c.threadId,
      project,
      title: c.title,
      sessionIds: c.sessionIds,
      articlePath: "",
      articleVersion: ARTICLE_VERSION,
      latestSourceSha: "",
      articleStatus: "ok",
      skip: true,
      skipReason: c.reason ?? "",
      updatedAt: nowIso,
    };
    upsertThread(bookIndex, entry);
    skipped.push(c.threadId);
  }
  return skipped;
}

/**
 * For each non-skip candidate, gather the session bodies and emit an ArticleInput.
 *
 * - Sessions inside one candidate are reordered to endedAt ASC (the article
 *   prompt expects 由旧到新). sessionShas is reordered to match.
 * - Joined sessionsMd uses "--- SESSION <shortId> (<endedAt>) ---" separators.
 * - Asserts all sessions in a candidate share one project; throws otherwise.
 * - Drops candidates whose sessionIds aren't all in indexFile and console.warns.
 */
export function buildArticleInputs(
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
  repoRoot: string,
): ArticleInput[] {
  const sessionLookup = sessionLookupBySid(indexFile);
  const out: ArticleInput[] = [];
  for (const c of candidates) {
    if (c.skip) continue;
    const entries: IndexEntry[] = [];
    let missing = false;
    for (const sid of c.sessionIds) {
      const ie = sessionLookup.get(sid);
      if (!ie) {
        console.warn(
          `pipeline.ts: candidate ${c.threadId} references unknown sessionId ${sid} — dropping candidate`,
        );
        missing = true;
        break;
      }
      entries.push(ie);
    }
    if (missing) continue;

    const projects = new Set(entries.map((e) => e.project));
    if (projects.size > 1) {
      throw new Error(
        `pipeline.ts: candidate ${c.threadId} spans multiple projects (${[...projects].join(", ")})`,
      );
    }
    const project = entries[0]!.project;

    entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

    const bodies: string[] = [];
    for (const e of entries) {
      if (e.relativePath.endsWith(".enc")) {
        throw new Error(
          `pipeline.ts: encrypted sessions not supported in digest pipeline (got ${e.relativePath})`,
        );
      }
      let body: string;
      try {
        body = readFileSync(join(repoRoot, e.relativePath), "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`pipeline.ts: cannot read session ${e.relativePath}: ${msg}`);
      }
      bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
    }

    out.push({
      threadId: c.threadId,
      project,
      title: c.title,
      sessionIds: entries.map((e) => e.sessionId),
      sessionShas: entries.map((e) => e.sourceSha256),
      sessionsMd: bodies.join("\n\n"),
      endedAt: entries[entries.length - 1]!.endedAt,
    });
  }
  return out;
}

/** Build a sessionId → IndexEntry map. We do NOT key by tool because
 *  threading candidates carry only sessionId (no tool). In practice
 *  sessionIds are source-native UUIDs and don't collide. */
function sessionLookupBySid(indexFile: IndexFile): Map<string, IndexEntry> {
  const m = new Map<string, IndexEntry>();
  for (const e of Object.values(indexFile.entries)) m.set(e.sessionId, e);
  return m;
}
