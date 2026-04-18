import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { IndexFile, IndexEntry } from "../types.js";
import {
  type BookIndex,
  type BookEntry,
  upsertThread,
} from "./book-index.js";
import type { SessionForBatching, ThreadCandidate } from "./types.js";
import { ARTICLE_VERSION, type ArticleInput } from "./article.js";
import { decrypt } from "../crypto.js";

/**
 * Read a session body from disk, decrypting if its path ends with .enc.
 * Throws when path is .enc but no key is provided (this preserves the previous
 * "encryption not supported in digest" failure mode for callers that haven't
 * yet been updated to thread the key).
 */
function readSessionBody(
  repoRoot: string,
  relativePath: string,
  key: Buffer | null,
  contextLabel: string,
): string {
  const abs = join(repoRoot, relativePath);
  let raw: Buffer;
  try {
    raw = readFileSync(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${contextLabel}: cannot read session ${relativePath}: ${msg}`);
  }
  if (relativePath.endsWith(".enc")) {
    if (!key) {
      throw new Error(
        `${contextLabel}: encrypted session ${relativePath} but no key provided`,
      );
    }
    try {
      return decrypt(raw, key).toString("utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${contextLabel}: failed to decrypt ${relativePath}: ${msg}`);
    }
  }
  return raw.toString("utf8");
}

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
 * Read each entry's session body from disk and produce SessionForBatching[].
 * Tokens estimated as ceil(chars / 3.5).
 *
 * When `key` is provided, `.enc` paths are decrypted in memory; when null,
 * `.enc` paths throw (preserves previous "encryption not supported" failure
 * mode for legacy callers).
 *
 * Throws on a missing/unreadable session (upstream extract is broken — fail loud).
 */
export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
  key: Buffer | null = null,
): SessionForBatching[] {
  const out: SessionForBatching[] = [];
  for (const e of entries) {
    const body = readSessionBody(repoRoot, e.relativePath, key, "pipeline.ts");
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
 *
 * If a candidate has no sessionIds, or its first sessionId isn't found in
 * indexFile, the entry is still recorded with project="unknown" and a
 * console.warn is emitted (don't drop — we still want the skip persisted).
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
    if (firstSid === undefined || ie === undefined) {
      console.warn(
        `pipeline.ts: skip candidate ${c.threadId} has no resolvable session — recording with project="unknown"`,
      );
    }
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
  key: Buffer | null = null,
): ArticleInput[] {
  const out: ArticleInput[] = [];
  for (const c of candidates) {
    if (c.skip) continue;
    const input = buildArticleInputForThread(
      c.threadId, c.title, c.sessionIds, indexFile, repoRoot, "pipeline.ts", key,
    );
    if (input !== null) out.push(input);
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

/**
 * Materialize one ArticleInput from a thread's recorded sessionIds. Returns
 * null when any sessionId can't be resolved in indexFile (with console.warn);
 * throws on IO failure or on `.enc` paths when no `key` is provided.
 *
 * When `key` is provided, `.enc` session bodies are decrypted in memory; when
 * null, `.enc` paths throw (preserves the previous "encryption out of scope"
 * failure mode).
 *
 * Used by both `buildArticleInputs` (fresh threading candidates) and the
 * orchestrator's stale-thread regeneration path. Keeps the separator format,
 * endedAt-ASC ordering, and decryption policy in ONE place.
 */
export function buildArticleInputForThread(
  threadId: string,
  title: string,
  sessionIds: string[],
  indexFile: IndexFile,
  repoRoot: string,
  contextLabel: string,
  key: Buffer | null = null,
): ArticleInput | null {
  const lookup = sessionLookupBySid(indexFile);
  const entries: IndexEntry[] = [];
  for (const sid of sessionIds) {
    const ie = lookup.get(sid);
    if (!ie) {
      console.warn(
        `${contextLabel}: thread ${threadId} references unknown sessionId ${sid} — skipping`,
      );
      return null;
    }
    entries.push(ie);
  }

  const projects = new Set(entries.map((e) => e.project));
  if (projects.size > 1) {
    throw new Error(
      `${contextLabel}: thread ${threadId} spans multiple projects (${[...projects].join(", ")})`,
    );
  }
  const project = entries[0]!.project;

  entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

  const bodies: string[] = [];
  for (const e of entries) {
    const body = readSessionBody(repoRoot, e.relativePath, key, contextLabel);
    bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
  }

  return {
    threadId,
    project,
    title,
    sessionIds: entries.map((e) => e.sessionId),
    sessionShas: entries.map((e) => e.sourceSha256),
    sessionsMd: bodies.join("\n\n"),
    endedAt: entries[entries.length - 1]!.endedAt,
  };
}
