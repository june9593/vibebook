import { loadIndex } from "./index-store.js";
import { projectSlugFromPath } from "./slug.js";
import { resolveProjectIdSync } from "./project-identity.js";
import type { IndexEntry } from "./types.js";

/**
 * Reverse-lookup a project slug from an absolute cwd.
 *
 *   1. Resolve the stable project identity (git remote → slug; path slug when
 *      no remote — `resolveProjectIdSync`) and check the index has a session
 *      for it. The sync adapters compute the project the same way, so this is
 *      authoritative.
 *   2. Also try the legacy path slug, so a repo whose data was written before
 *      the remote-identity switch (or a non-git project) still resolves.
 *   3. Fall back to scanning index entries for one whose `projectRaw` === cwd.
 *
 * Returns null if none match — caller decides how to error.
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
  // Prefer the stable (remote-based) slug; fall back to the legacy path slug so
  // un-migrated / non-git projects still resolve during the transition.
  const candidates: string[] = [];
  const remoteSlug = resolveProjectIdSync(cwd).slug;
  candidates.push(remoteSlug);
  const pathSlug = projectSlugFromPath(cwd);
  if (pathSlug !== remoteSlug) candidates.push(pathSlug);

  for (const cand of candidates) {
    for (const e of Object.values(entries)) {
      if (e.project === cand) return cand;
    }
  }
  for (const e of Object.values(entries)) {
    if (e.projectRaw === cwd) return e.project;
  }
  return null;
}
