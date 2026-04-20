import type { SessionSignals } from "./session-signal.js";

/**
 * Minimal shape the batcher needs from a session. Built from a
 * NormalizedSession or IndexEntry by the caller (Sprint 2.8 pipeline glue).
 *
 * - `tokenEstimate` is char-count / 3.5 rounded up; the batcher trusts this
 *   and does not re-derive it. Caller computes once, batcher reads.
 * - `endedAt` is ISO 8601; sort key for time-locality grouping.
 */
export interface SessionForBatching {
  sessionId: string;
  project: string;
  endedAt: string;
  tokenEstimate: number;
}

/**
 * SessionForBatching enriched with extracted signals for the threading
 * LLM prompt. Built by pipeline.buildBatchingInput; consumed by threading.
 * Batcher only reads SessionForBatching fields, so this is a strict superset.
 */
export interface EnrichedSessionForBatching extends SessionForBatching, SessionSignals {}

/**
 * What the LLM returns per batch (one element per discovered thread).
 *
 * - `threadId` is a slug (lowercase, hyphenated). Identity across batches
 *   is decided by normalizeSlug + prefix-collapse, not raw equality.
 * - `skip: true` means the LLM judged the thread as having no real content
 *   (greetings, trivia). `reason` is human-readable Chinese.
 * - `sessionIds` is the subset of the input batch's sessions that belong
 *   to this thread. Sessions not mentioned by any candidate are dropped
 *   by the merger (warning logged at the call site, not here).
 */
export interface ThreadCandidate {
  threadId: string;
  /** Project this thread belongs to. Populated by threading.ts from input
   *  batch context (LLM doesn't see this field). Required for cross-batch
   *  identity in mergeCandidates so two projects' identical slugs stay
   *  distinct (e.g. misc-empty-session in proj-a vs proj-b). */
  project: string;
  sessionIds: string[];
  title: string;
  skip?: boolean;
  reason?: string;
}
