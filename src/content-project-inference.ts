import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "./types.js";
import { projectSlugFromPath } from "./slug.js";
import { cachedProjectSlug } from "./project-identity.js";

/**
 * Content-based project inference.
 *
 * Claude Code groups jsonl files by cwd at session-start. When the user
 * `cd`s into a different project mid-session, or runs `claude` in the wrong
 * directory by accident (e.g. opens it in `chromium-src` but spends the
 * whole session editing files in `edge-vibebook`), the session is filed
 * under the wrong project. The user's intent — "this conversation is about
 * vibebook" — disagrees with the cwd label.
 *
 * We recover intent by scanning the session's tool-use blocks for absolute
 * file paths the assistant actually touched (Read / Write / Edit / Bash),
 * mapping each path to a project root, and picking the dominant one. If
 * one project owns ≥ MIN_CONFIDENCE of all path mentions, we override the
 * cwd-derived project with the inferred one.
 *
 * We DO NOT scan message text for paths — that produces too many false
 * positives (e.g. "the chromium codebase has a similar pattern in
 * /chromium/src/foo.cc" mentioned as reference, not as work). Tool-use
 * inputs reflect actual edits/reads, which is the signal we want.
 */

export const MIN_CONFIDENCE = 0.7;
export const MIN_PATH_HITS = 5;

export interface InferenceResult {
  /** Inferred project slug; null if confidence < threshold or too few hits. */
  inferredProject: string | null;
  /** Top project's share of all path mentions, in [0, 1]. */
  confidence: number;
  /** Total path mentions counted. */
  totalHits: number;
  /** Per-project counts, for diagnostics. */
  perProject: Record<string, number>;
}

/**
 * Decode a Claude project-dir name back to its filesystem path prefix.
 *
 *   "-Users-me-edge-memvc"  →  "/Users/me/edge/memvc"
 *
 * Note this is one-way and lossy — Claude itself uses the same encoding so
 * actual hyphens in path components become indistinguishable from `/`.
 * That ambiguity is fine for our use: we only need the prefix to match the
 * common case `/Users/<u>/<dir>/...`, where hyphens-in-names are rare.
 */
function decodeProjectDirName(name: string): string {
  if (!name.startsWith("-")) return name;
  return "/" + name.slice(1).replace(/-/g, "/");
}

/**
 * Build the list of "known project roots" by listing `~/.claude/projects/`.
 * Each entry is `{ path, slug }`. Sorted longest-prefix-first so a path
 * like `/Users/u/edge/memvc/.claude/worktrees/foo` matches the worktree
 * subdir before falling back to the parent project.
 */
export function listKnownProjectRoots(
  projectsDir: string = join(homedir(), ".claude", "projects"),
): { path: string; slug: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out = entries.map((name) => {
    const path = decodeProjectDirName(name);
    // Stable (remote-based) slug per known project root; falls back to the path
    // slug for non-git roots. The unknown-path fallback below stays path-based.
    return { path, slug: cachedProjectSlug(path) };
  });
  out.sort((a, b) => b.path.length - a.path.length);
  return out;
}

/**
 * Match an absolute path to a known project root, or fall back to
 * deriving a slug from the path's parent component.
 *
 *   "/Users/me/edge/memvc/src/foo.ts"  →  "edge-memvc"  (matched)
 *   "/Users/me/edge/random/file.ts"    →  "edge-random" (no match, slug from parent)
 *   "/etc/hosts"                       →  "etc-hosts"   (still slug; caller can ignore)
 */
export function pathToProjectSlug(
  absPath: string,
  roots: { path: string; slug: string }[],
): string | null {
  if (!absPath || !absPath.startsWith("/")) return null;
  for (const r of roots) {
    if (absPath === r.path || absPath.startsWith(r.path + "/")) return r.slug;
  }
  // Fallback: derive slug from the directory two levels up (matching the
  // `parent-basename` rule in projectSlugFromPath). Treat the immediate
  // file as the leaf and chop it off so we get a directory-ish slug.
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const dir = absPath.slice(0, lastSlash);
  const slug = projectSlugFromPath(dir);
  // Reject obvious non-project paths so they don't drown out real signal.
  if (
    slug === "home" || slug === "root" ||
    dir.startsWith("/tmp/") || dir.startsWith("/private/tmp/") ||
    dir.startsWith("/etc") || dir.startsWith("/usr") || dir.startsWith("/var") ||
    dir.startsWith("/System") || dir.startsWith("/opt")
  ) return null;
  return slug;
}

/**
 * Pull every plausible absolute path out of the message's raw tool-use
 * blocks. Returns deduplicated paths per message — repeated reads of the
 * same file count once per message, not N times — to avoid a single noisy
 * Read loop dominating the tally.
 */
export function extractPathsFromMessages(messages: SessionMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const raw = m.raw as { message?: { content?: unknown } } | undefined;
    const content = raw?.message?.content;
    if (!Array.isArray(content)) continue;
    const seen = new Set<string>();
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== "tool_use") continue;
      const inp = b.input ?? {};
      const name = b.name ?? "";
      if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") {
        const fp = inp.file_path ?? inp.notebook_path;
        if (typeof fp === "string" && fp.startsWith("/")) seen.add(fp);
      } else if (name === "Bash") {
        const cmd = inp.command;
        if (typeof cmd === "string") {
          // Greedy match for absolute-path-looking tokens. Stops at whitespace
          // or shell metacharacters; tolerates dots/dashes/underscores.
          for (const m2 of cmd.matchAll(/\/[A-Za-z0-9._\-/]+(?:\.[A-Za-z0-9]+)?/g)) {
            const p = m2[0];
            // Skip very short hits (likely "/" or "/x") and obvious URL paths.
            if (p.length < 6) continue;
            if (cmd.includes("http://" + p) || cmd.includes("https://" + p)) continue;
            seen.add(p);
          }
        }
      } else if (name === "Glob" || name === "Grep") {
        const pat = inp.path ?? inp.pattern;
        if (typeof pat === "string" && pat.startsWith("/")) seen.add(pat);
      }
    }
    for (const p of seen) out.push(p);
  }
  return out;
}

/**
 * Run inference on a session's messages. Returns the inferred project slug
 * and confidence. Caller decides whether to override based on the policy
 * (e.g. inferred != cwd-project AND confidence >= MIN_CONFIDENCE).
 */
export function inferProjectFromContent(
  messages: SessionMessage[],
  roots: { path: string; slug: string }[] = listKnownProjectRoots(),
): InferenceResult {
  const paths = extractPathsFromMessages(messages);
  const counts: Record<string, number> = {};
  let totalHits = 0;
  for (const p of paths) {
    const slug = pathToProjectSlug(p, roots);
    if (!slug) continue;
    counts[slug] = (counts[slug] ?? 0) + 1;
    totalHits++;
  }
  if (totalHits < MIN_PATH_HITS) {
    return { inferredProject: null, confidence: 0, totalHits, perProject: counts };
  }
  let topSlug = "";
  let topCount = 0;
  for (const [slug, c] of Object.entries(counts)) {
    if (c > topCount) { topCount = c; topSlug = slug; }
  }
  const confidence = topCount / totalHits;
  return {
    inferredProject: confidence >= MIN_CONFIDENCE ? topSlug : null,
    confidence,
    totalHits,
    perProject: counts,
  };
}
