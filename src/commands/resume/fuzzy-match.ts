import type { IndexFile, IndexEntry } from "../../types.js";

/**
 * Match index entries by any of: full sessionId UUID, 8-char shortId, or any
 * UUID prefix. Case-insensitive. Returns all matches (could be 0, 1, or many).
 *
 * The caller (resume.ts) decides whether to:
 *  - 0 matches → throw "no session found"
 *  - 1 match → proceed
 *  - >1 matches → throw with candidate list, ask user for more specificity
 */
export function findEntries(idx: IndexFile, idOrPrefix: string): IndexEntry[] {
  const needle = idOrPrefix.toLowerCase();
  return Object.values(idx.entries).filter((e) =>
    e.sessionId.toLowerCase().startsWith(needle),
  );
}
