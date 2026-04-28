import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";
import { loadBookIndexV2 } from "../digest/book-index-v2.js";
import { extractSessionSignals, isVibebookMetaSession } from "../digest/session-signal.js";
import { isRealProjectPath } from "../digest/project-filter.js";
import { projectSlugFromPath } from "../slug.js";
import { resolveProjectFromCwdWithIndex } from "../project-resolve.js";
import type { IndexEntry } from "../types.js";

export interface PreparePayload {
  /** Project filter applied (or null for all). */
  project: string | null;
  /** Sessions in the raw index that aren't yet referenced by any chronicle
   *  AND survive isRealProjectPath. Sorted by endedAt ascending. */
  newSessions: PreparedSession[];
  /** Existing topic slugs grouped by project, so the skill can dedup. */
  existingTopics: Record<string, string[]>;
  /** Existing card slugs grouped by project (incl. "_global"). */
  existingCards: Record<string, string[]>;
  /** Aggregate counts for the skill's user-facing summary table. */
  meta: {
    totalSessionsInIndex: number;
    sessionsAlreadyChronicled: number;
    sessionsFilteredByProject: number;
    sessionsFilteredAsPseudoProject: number;
    sessionsFilteredAsVibebookMeta: number;
    newSessionsCount: number;
  };
}

export interface PreparedSession {
  sessionId: string;
  shortId: string;
  tool: "claude" | "copilot";
  project: string;
  startedAt: string;
  endedAt: string;
  /** First user message, slugified (from the raw extract step). */
  nameSlug: string;
  /** Display title from the raw extract. */
  displayName: string;
  /** Repo-relative path to the synced .md (already decrypted-on-demand;
   *  the skill should `Read` this path directly). */
  mdPath: string;
  /** First-300-char preview of joined user messages. */
  preview: string;
  /** 0..1 keyword-bucket signal (debug/architecture/discovery/reasoning/evaluation). */
  insightScore: number;
}

export interface PrepareOptions {
  /** Project slug filter; "" / undefined = all projects. */
  project?: string;
  /** Resolve project from this absolute cwd (via projectSlugFromPath +
   *  index lookup). Mutually exclusive with `project`; the skill uses this
   *  to support "auto-detect from where Claude was launched". */
  cwd?: string;
}

/**
 * Build the JSON payload that the in-session Claude reads via the
 * `/vibebook` skill. Pure I/O over the user's already-synced raw_sessions.
 *
 * Algorithm:
 *   1. Load raw index (.vibebook/index.json) — every synced session.
 *   2. Load book index v2 (.vibebook/index.book.json) — every chronicle's
 *      sessionIds, every existing topic + card slug.
 *   3. Build the set of "consumed" session ids (union of all chronicle
 *      sessionIds, including skipped ones — we don't want to re-evaluate
 *      a SKIP'd session every run).
 *   4. For each unconsumed session:
 *        - apply isRealProjectPath filter
 *        - apply --project filter if given
 *        - read the .md (decrypt if encrypted), compute signals
 *   5. Sort by endedAt ASC, return.
 *
 * The skill's "Step 1 — Plan" calls this and prints the count + summary.
 */
export function buildPreparePayload(opts: PrepareOptions = {}): PreparePayload {
  const cfg = readConfig();
  const indexFile = loadIndex(cfg.repoPath);
  const bookIndex = loadBookIndexV2(cfg.repoPath);

  // Resolve --cwd → project slug. Try the path-derived slug first (matches
  // how the adapters compute `project`); if no session exists for it, fall
  // back to scanning index entries whose projectRaw === cwd. If still
  // nothing, throw — no point pretending the user is in a known project.
  let projectFilter = opts.project?.trim() || null;
  if (!projectFilter && opts.cwd) {
    projectFilter = resolveProjectFromCwdWithIndex(opts.cwd, indexFile.entries);
    if (!projectFilter) {
      throw new Error(
        `no synced sessions found for cwd '${opts.cwd}' (derived slug '${projectSlugFromPath(opts.cwd)}'). Run \`vibebook sync\` first or pass --project explicitly.`,
      );
    }
  }

  // 3. consumed session ids
  const consumed = new Set<string>();
  for (const c of Object.values(bookIndex.chronicles)) {
    for (const sid of c.sessionIds) consumed.add(sid);
  }

  // 4. filter + read
  const meta = {
    totalSessionsInIndex: 0,
    sessionsAlreadyChronicled: 0,
    sessionsFilteredByProject: 0,
    sessionsFilteredAsPseudoProject: 0,
    sessionsFilteredAsVibebookMeta: 0,
    newSessionsCount: 0,
  };
  const newSessions: PreparedSession[] = [];
  for (const entry of Object.values(indexFile.entries)) {
    meta.totalSessionsInIndex++;
    if (consumed.has(entry.sessionId)) {
      meta.sessionsAlreadyChronicled++;
      continue;
    }
    if (!isRealProjectPath(entry.project)) {
      meta.sessionsFilteredAsPseudoProject++;
      continue;
    }
    if (projectFilter && entry.project !== projectFilter) {
      meta.sessionsFilteredByProject++;
      continue;
    }
    const mdRel = mdPathFor(entry);
    const mdAbs = join(cfg.repoPath, mdRel);
    if (!existsSync(mdAbs)) {
      // The .md is missing — could be a sync gap. Skip silently; user can
      // re-sync to recover.
      continue;
    }
    const mdBody = readFileSync(mdAbs, "utf8");
    if (isVibebookMetaSession(mdBody)) {
      // User's own /vibebook invocation. Self-referential noise — exclude
      // before the LLM ever sees it. (See SessionSignals docs for the
      // detection heuristics.)
      meta.sessionsFilteredAsVibebookMeta++;
      continue;
    }
    const signals = extractSessionSignals(mdBody);
    newSessions.push({
      sessionId: entry.sessionId,
      shortId: entry.shortId,
      tool: entry.tool,
      project: entry.project,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      nameSlug: entry.nameSlug,
      displayName: entry.displayName,
      mdPath: mdRel,
      preview: signals.preview,
      insightScore: signals.insightScore,
    });
  }
  newSessions.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  meta.newSessionsCount = newSessions.length;

  // 5. existing topics + cards grouped by project
  const existingTopics: Record<string, string[]> = {};
  for (const t of Object.values(bookIndex.topics)) {
    (existingTopics[t.project] ??= []).push(t.topicSlug);
  }
  for (const list of Object.values(existingTopics)) list.sort();
  const existingCards: Record<string, string[]> = {};
  for (const c of Object.values(bookIndex.cards)) {
    (existingCards[c.project] ??= []).push(c.cardSlug);
  }
  for (const list of Object.values(existingCards)) list.sort();

  return {
    project: projectFilter,
    newSessions,
    existingTopics,
    existingCards,
    meta,
  };
}

/** The IndexEntry stores the raw_sessions path. We want the human-readable
 *  .md path. Working tree is always plaintext now (encryption happens via
 *  git filter on push) so no .enc handling needed. */
function mdPathFor(entry: IndexEntry): string {
  // entry.relativePath is the .raw.json path. Swap suffix.
  return entry.relativePath.replace(/\.raw\.json(\.enc)?$/, `.md`);
}

/** CLI entry: print payload as JSON to stdout. */
export async function prepareCmd(opts: PrepareOptions): Promise<void> {
  const payload = buildPreparePayload(opts);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
