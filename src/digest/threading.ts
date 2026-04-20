import type { LlmRunner } from "./runner.js";
import type { ThreadCandidate, EnrichedSessionForBatching } from "./types.js";
import type { Reporter } from "./reporter.js";
import { loadPromptAsset } from "./prompt-loader.js";
import { mapWithConcurrency } from "./concurrency.js";
import { DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS } from "../config.js";

/** Cache the prompt at module load — file is static for the process lifetime. */
const THREAD_PROMPT = loadPromptAsset(import.meta.url, "thread");

/**
 * Normalize a thread slug for cross-batch identity comparison.
 * Rules (spec §threading.merge):
 *   - lowercase
 *   - collapse runs of '-' into a single '-'
 *   - strip trailing '-NNN' numeric suffix
 *   - trim leading/trailing '-'
 */
export function normalizeSlug(slug: string): string {
  let s = slug.toLowerCase();
  s = s.replace(/-+/g, "-");
  s = s.replace(/-\d+$/, "");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

/**
 * Merge ThreadCandidate[][] (one per batch) into a single ThreadCandidate[]
 * via the deterministic algorithm in the spec:
 *
 *   1. Flatten all candidates, recording first-appearance index.
 *   2. Group by exact threadId; union sessionIds (preserving first-appearance order),
 *      `skip` is sticky (true if any candidate is skip).
 *   3. Collapse normalize-equivalent or prefix-equivalent groups onto a canonical
 *      group: pick the LONGEST raw threadId; tie-break by earliest first-appearance.
 *   4. Re-merge sessionIds + skip on the canonical group.
 */
export function mergeCandidates(perBatch: ThreadCandidate[][]): ThreadCandidate[] {
  // Step 1+2: group by exact threadId.
  interface Group {
    threadId: string;
    title: string;
    sessionIds: string[];   // ordered, deduped
    skip: boolean;
    reason?: string;
    firstSeen: number;      // index across the flattened stream
  }
  const groups = new Map<string, Group>();
  let idx = 0;
  for (const batch of perBatch) {
    for (const c of batch) {
      let g = groups.get(c.threadId);
      if (!g) {
        g = {
          threadId: c.threadId,
          title: c.title,
          sessionIds: [],
          skip: false,
          firstSeen: idx,
        };
        groups.set(c.threadId, g);
      }
      for (const sid of c.sessionIds) {
        if (!g.sessionIds.includes(sid)) g.sessionIds.push(sid);
      }
      if (c.skip) {
        g.skip = true;
        if (c.reason && !g.reason) g.reason = c.reason;
      }
      idx++;
    }
  }

  // Step 3: build collapse map. For each group, decide its canonical threadId.
  const groupList = Array.from(groups.values());
  const canonicalOf = new Map<string, string>(); // threadId → canonical threadId

  for (const g of groupList) {
    let canonical = g;
    for (const other of groupList) {
      if (other === g) continue;
      if (areEquivalent(g.threadId, other.threadId)) {
        // Pick longer raw; tie-break by earlier firstSeen.
        if (
          other.threadId.length > canonical.threadId.length ||
          (other.threadId.length === canonical.threadId.length &&
            other.firstSeen < canonical.firstSeen)
        ) {
          canonical = other;
        }
      }
    }
    canonicalOf.set(g.threadId, canonical.threadId);
  }

  // Step 4: re-merge into canonical groups.
  const finalGroups = new Map<string, Group>();
  for (const g of groupList) {
    const canonId = canonicalOf.get(g.threadId)!;
    let cg = finalGroups.get(canonId);
    if (!cg) {
      // Seed from the canonical group itself (so title comes from canonical).
      const seed = groups.get(canonId)!;
      cg = {
        threadId: seed.threadId,
        title: seed.title,
        sessionIds: [],
        skip: false,
        firstSeen: seed.firstSeen,
      };
      finalGroups.set(canonId, cg);
    }
    for (const sid of g.sessionIds) {
      if (!cg.sessionIds.includes(sid)) cg.sessionIds.push(sid);
    }
    if (g.skip) {
      cg.skip = true;
      if (g.reason && !cg.reason) cg.reason = g.reason;
    }
  }

  // Emit in firstSeen order for deterministic output.
  const out: ThreadCandidate[] = Array.from(finalGroups.values())
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((g) => {
      const tc: ThreadCandidate = {
        threadId: g.threadId,
        title: g.title,
        sessionIds: g.sessionIds,
      };
      if (g.skip) tc.skip = true;
      if (g.reason) tc.reason = g.reason;
      return tc;
    });
  return out;
}

/**
 * Two raw slugs are equivalent if their normalized forms are equal OR one is
 * a hyphen-segment prefix of the other. The "+ '-'" guard prevents
 * `"fix"` from matching `"fixture"` (raw startsWith would say true; segment
 * prefix says false).
 */
function areEquivalent(a: string, b: string): boolean {
  const na = normalizeSlug(a);
  const nb = normalizeSlug(b);
  if (na === nb) return true;
  if (na.length > 0 && nb.length > 0 && (na.startsWith(nb + "-") || nb.startsWith(na + "-"))) return true;
  return false;
}

/**
 * Validate that `data` is a ThreadCandidate[]. Throws otherwise.
 * Permissive: only checks shape of fields we rely on.
 */
function asThreadCandidates(data: unknown, batchIndex: number): ThreadCandidate[] {
  if (!Array.isArray(data)) {
    throw new Error(`threading batch ${batchIndex}: bad shape — expected JSON array`);
  }
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as Record<string, unknown>;
    if (typeof c?.threadId !== "string" || typeof c?.title !== "string" || !Array.isArray(c?.sessionIds)) {
      throw new Error(
        `threading batch ${batchIndex}: bad shape — element ${i} missing threadId/title/sessionIds`,
      );
    }
    for (const sid of c.sessionIds) {
      if (typeof sid !== "string") {
        throw new Error(`threading batch ${batchIndex}: bad shape — sessionIds must be string[]`);
      }
    }
    if (c.worthWriting !== undefined && typeof c.worthWriting !== "boolean") {
      throw new Error(
        `threading batch ${batchIndex}: bad shape — element ${i} worthWriting must be boolean if present`,
      );
    }
  }
  return data as ThreadCandidate[];
}

/**
 * Drive threading end-to-end with per-batch retry + soft-fail:
 *   - render thread prompt with sessionList = JSON of batch's sessions
 *   - run via mapWithConcurrency with the cap
 *   - per batch: try up to `maxAttempts` times; on each attempt, call runner →
 *     parse → validate. If any of these fail, retry. If all attempts fail,
 *     soft-fail (record + warn + skip).
 *   - cross-batch merge via mergeCandidates over the succeeded subset
 *
 * Returns BOTH the merged candidates AND the per-batch failures so the caller
 * can surface them in its report. Sessions in failed batches will reappear in
 * findNewSessionEntries on the next sync (they were never written to BookIndex).
 */
export interface ThreadingResult {
  /** Merged ThreadCandidate[] from all batches that succeeded. */
  candidates: ThreadCandidate[];
  /** Per-batch failures after all retry attempts. Their sessions remain
   *  unaccounted-for in BookIndex and will be re-batched on the next sync. */
  failedBatches: { batchIndex: number; error: string }[];
}

export async function runThreading(
  runner: LlmRunner,
  batches: EnrichedSessionForBatching[][],
  concurrency = DEFAULT_THREADING_CONCURRENCY,
  maxAttempts = DEFAULT_THREADING_MAX_ATTEMPTS,
  reporter: Reporter,
): Promise<ThreadingResult> {
  type BatchOutcome =
    | { ok: true; candidates: ThreadCandidate[] }
    | { ok: false; error: string };

  reporter.threadingStart(batches.length);
  const outcomes = await mapWithConcurrency(batches, concurrency, async (batch, i) => {
    const started = Date.now();
    const outcome = await processBatch(runner, batch, i, maxAttempts);
    reporter.threadingBatchDone(i, batches.length, Date.now() - started, outcome.ok);
    return outcome;
  });

  const perBatchCandidates: ThreadCandidate[][] = [];
  const failedBatches: { batchIndex: number; error: string }[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]!;
    if (o.ok) {
      perBatchCandidates.push(o.candidates);
    } else {
      failedBatches.push({ batchIndex: i, error: o.error });
      console.warn(`threading batch ${i} failed after ${maxAttempts} attempts: ${o.error}`);
    }
  }

  return {
    candidates: mergeCandidates(perBatchCandidates),
    failedBatches,
  };

  /** Per-batch helper: run + parse + validate, with retry. Returns an outcome
   *  discriminated union; never throws. */
  async function processBatch(
    runner: LlmRunner,
    batch: EnrichedSessionForBatching[],
    batchIndex: number,
    maxAttempts: number,
  ): Promise<BatchOutcome> {
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = await runner.run(
        THREAD_PROMPT,
        { sessionList: JSON.stringify(batch.map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          endedAt: s.endedAt,
          title: s.title,
          preview: s.preview,
          insightScore: Number(s.insightScore.toFixed(2)),
        }))) },
        { outputFormat: "json" },
      );
      if (!r.ok) {
        lastError = r.error;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.text);
      } catch (e) {
        lastError = `parse error — ${(e as Error).message}`;
        continue;
      }
      try {
        const candidates = asThreadCandidates(parsed, batchIndex);
        return { ok: true, candidates };
      } catch (e) {
        lastError = (e as Error).message;
        continue;
      }
    }
    return { ok: false, error: lastError };
  }
}
