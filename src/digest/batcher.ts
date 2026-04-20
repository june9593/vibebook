import type { SessionForBatching } from "./types.js";

export interface BatcherOptions {
  /** Soft cap per batch. A single session larger than this still becomes its own batch. Default 100_000. */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 100_000;

/**
 * Pack sessions into batches respecting two locality rules and one budget rule:
 *
 * 1. Group sessions by project (alphabetical project order for determinism).
 * 2. Within a project, order by endedAt ascending.
 * 3. Greedy pack: a session larger than maxTokens becomes its own single-element batch.
 *    Remaining sessions are packed in project+endedAt order; a new batch is opened only
 *    when adding the next session would exceed maxTokens.
 * 4. All batches (normal + oversized) are sorted by the endedAt of their first session.
 *
 * Rationale (spec §Batcher): same-project + time-adjacent sessions must see
 * each other so the threading LLM can spot cross-session continuity.
 */
export function makeBatches<T extends SessionForBatching>(
  sessions: T[],
  opts: BatcherOptions = {},
): T[][] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (sessions.length === 0) return [];

  // Separate oversized sessions from normal ones.
  const oversized: T[] = [];
  const normal: T[] = [];
  for (const s of sessions) {
    if (s.tokenEstimate > maxTokens) {
      oversized.push(s);
    } else {
      normal.push(s);
    }
  }

  // Sort normal sessions: project alphabetically, then endedAt ascending.
  normal.sort((a, b) => {
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    return a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0;
  });

  // Greedy pack normal sessions.
  const normalBatches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  for (const s of normal) {
    if (currentTokens + s.tokenEstimate > maxTokens) {
      normalBatches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(s);
    currentTokens += s.tokenEstimate;
  }
  if (current.length > 0) normalBatches.push(current);

  // Each oversized session is its own batch.
  const oversizedBatches = oversized.map((s) => [s]);

  // Combine and sort by the endedAt of the first session in each batch.
  const all = [...normalBatches, ...oversizedBatches];
  all.sort((a, b) => {
    const ea = a[0].endedAt;
    const eb = b[0].endedAt;
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });

  return all;
}
