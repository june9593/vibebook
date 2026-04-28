import { loadIndex } from "./index-store.js";
import { projectSlugFromPath } from "./slug.js";
import type { IndexEntry } from "./types.js";

/**
 * Reverse-lookup a project slug from an absolute cwd.
 *
 *   1. Try the path-derived slug (`projectSlugFromPath`) and check the index
 *      has at least one synced session for it. This is the authoritative
 *      path because the sync adapters compute project slugs the same way.
 *   2. Fall back to scanning index entries for one whose `projectRaw` ===
 *      cwd. Handles cases where the user's cwd was reached through a
 *      symlink that has a different basename than the recorded session cwd.
 *
 * Returns null if neither matches — caller decides how to error.
 */
export function resolveProjectFromCwd(cwd: string, repoPath: string): string | null {
  const indexFile = loadIndex(repoPath);
  return resolveProjectFromCwdWithIndex(cwd, indexFile.entries);
}

/** Variant for when the caller already has the index loaded (avoid double-read). */
export function resolveProjectFromCwdWithIndex(
  cwd: string,
  entries: Record<string, IndexEntry>,
): string | null {
  const slug = projectSlugFromPath(cwd);
  for (const e of Object.values(entries)) {
    if (e.project === slug) return slug;
  }
  for (const e of Object.values(entries)) {
    if (e.projectRaw === cwd) return e.project;
  }
  return null;
}
