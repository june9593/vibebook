import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRunner } from "./runner.js";
import type { ThreadCandidate, SessionForBatching } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve repo-rooted assets/prompts/thread.md from this module's compiled location. */
function loadThreadPrompt(): string {
  // src/digest/threading.ts → ../../assets/prompts/thread.md when running ts-node;
  // dist/digest/threading.js → ../../assets/prompts/thread.md when built.
  // Both layouts produce the same relative path.
  const p = join(__dirname, "..", "..", "assets", "prompts", "thread.md");
  return readFileSync(p, "utf8");
}

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

/** Two raw slugs are equivalent if their normalized forms are equal OR one is a prefix of the other. */
function areEquivalent(a: string, b: string): boolean {
  const na = normalizeSlug(a);
  const nb = normalizeSlug(b);
  if (na === nb) return true;
  if (na.length > 0 && nb.length > 0 && (na.startsWith(nb) || nb.startsWith(na))) return true;
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
  }
  return data as ThreadCandidate[];
}

/**
 * Drive threading end-to-end:
 *   - render thread prompt with sessionList = JSON of batch's sessions
 *   - call runner per batch in parallel (outputFormat: json)
 *   - parse + validate each batch's result
 *   - cross-batch merge via mergeCandidates
 *
 * Throws on the first sign of trouble (any batch ok:false, parse error, or
 * shape error). Errors include the batch index for diagnosis.
 */
export async function runThreading(
  runner: LlmRunner,
  batches: SessionForBatching[][],
): Promise<ThreadCandidate[]> {
  const prompt = loadThreadPrompt();

  const results = await Promise.all(
    batches.map((batch) =>
      runner.run(
        prompt,
        { sessionList: JSON.stringify(batch.map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          endedAt: s.endedAt,
        }))) },
        { outputFormat: "json" },
      ),
    ),
  );

  const perBatchCandidates: ThreadCandidate[][] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      errors.push(`batch ${i}: ${r.error}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.text);
    } catch (e) {
      throw new Error(`threading batch ${i}: parse error — ${(e as Error).message}`);
    }
    perBatchCandidates.push(asThreadCandidates(parsed, i));
  }
  if (errors.length > 0) {
    throw new Error(`threading runner failed: ${errors.join("; ")}`);
  }

  return mergeCandidates(perBatchCandidates);
}
