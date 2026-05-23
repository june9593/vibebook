import { readConfig } from "../../config.js";
import { loadIndex } from "../../index-store.js";
import { loadAggregatedIndex } from "../../aggregated-store.js";
import type { IndexEntry } from "../../types.js";

export interface ListSessionsOptions {
  /** Project slug filter; "" / undefined = all */
  project?: string;
  /** "1d" | "7d" | "30d" — only sessions whose endedAt is within this window */
  since?: string;
  /** Device branch filter — matches the entry's `originDevice` (aggregated
   *  sessions only). Own sessions are excluded when this filter is set
   *  unless device === config.deviceBranch. */
  device?: string;
}

/** Same shape as IndexEntry but with a derived `isOwn` flag so callers know
 *  whether to look at sessionRepo/ or ~/.vibebook/aggregated/ for the .md. */
export type ListedSession = IndexEntry & { isOwn: boolean };

/**
 * Returns sessions from BOTH the device's own spool index AND the union
 * `.vibebook/index.aggregated.json` written by CI to main. Dedupes by
 * `tool:sessionId` — when the same session appears in both, the own copy
 * wins (it carries the latest local sourceSha256 / mtime).
 *
 * Filtered + sorted newest-first. Caller (CLI handler) prints as a table.
 */
export async function listSessionsCmd(opts: ListSessionsOptions): Promise<ListedSession[]> {
  const cfg = readConfig();
  const ownIdx = loadIndex(cfg.repoPath);
  const aggIdx = loadAggregatedIndex();

  const merged = new Map<string, ListedSession>();
  for (const e of Object.values(ownIdx.entries)) {
    merged.set(`${e.tool}:${e.sessionId}`, { ...e, isOwn: true });
  }
  for (const e of Object.values(aggIdx?.entries ?? {})) {
    const k = `${e.tool}:${e.sessionId}`;
    if (!merged.has(k)) merged.set(k, { ...e, isOwn: false });
  }

  const cutoffMs = parseSince(opts.since);
  const result: ListedSession[] = [];

  for (const entry of merged.values()) {
    if (opts.project && entry.project !== opts.project) continue;
    if (cutoffMs !== null && Date.parse(entry.endedAt) < cutoffMs) continue;
    if (opts.device) {
      const entryDevice = (entry as IndexEntry & { originDevice?: string }).originDevice;
      const isOwnFromThisDevice = entry.isOwn && cfg.deviceBranch === opts.device;
      if (!isOwnFromThisDevice && entryDevice !== opts.device) continue;
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
