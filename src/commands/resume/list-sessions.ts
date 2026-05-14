import { readConfig } from "../../config.js";
import { loadIndex } from "../../index-store.js";
import type { IndexEntry } from "../../types.js";

export interface ListSessionsOptions {
  /** Project slug filter; "" / undefined = all */
  project?: string;
  /** "1d" | "7d" | "30d" — only sessions whose endedAt is within this window */
  since?: string;
  /** Device branch filter; matches IndexEntry's device when present.
   *  IndexEntry doesn't have device field directly in v0.5.0 — accepted
   *  but doesn't filter (placeholder for v0.6 device-tagging). */
  device?: string;
}

/**
 * Returns sessions from the spool's index.json, filtered + sorted newest-first.
 * Caller (CLI handler) is responsible for printing as a table.
 */
export async function listSessionsCmd(opts: ListSessionsOptions): Promise<IndexEntry[]> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);

  const cutoffMs = parseSince(opts.since);
  const result: IndexEntry[] = [];

  for (const entry of Object.values(idx.entries)) {
    if (opts.project && entry.project !== opts.project) continue;
    if (cutoffMs !== null && Date.parse(entry.endedAt) < cutoffMs) continue;
    if (opts.device) {
      // IndexEntry doesn't have device field directly; accepted but not
      // filtered. Marker for v0.6.0 follow-up.
    }
    result.push(entry);
  }

  result.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  return result;
}

/** Parse "7d" / "1d" / "30d" / "24h" / "4w" → cutoff timestamp in ms; null if no --since set. */
function parseSince(since: string | undefined): number | null {
  if (!since) return null;
  const m = since.match(/^(\d+)([dhw])$/);
  if (!m) throw new Error(`Invalid --since '${since}'. Use NdHw form: 1d, 24h, 4w.`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === "d" ? 86400_000 : unit === "h" ? 3600_000 : 7 * 86400_000;
  return Date.now() - n * ms;
}
