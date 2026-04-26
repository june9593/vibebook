import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";
import { loadBookIndexV2 } from "../digest/book-index-v2.js";
import { isRealProjectPath } from "../digest/project-filter.js";

export interface ProjectStats {
  /** Project slug as derived by the sync adapters. */
  project: string;
  /** Total sessions synced for this project (including those already
   *  digested into chronicles). */
  totalSessions: number;
  /** Sessions whose `sessionId` is already referenced by some chronicle
   *  entry in BookIndex (skip-marked counts too — once "decided", we don't
   *  reconsider). */
  consumedSessions: number;
  /** = totalSessions - consumedSessions. Drives the global-mode subagent
   *  fan-out: only project-mode loops over projects with `pendingSessions > 0`. */
  pendingSessions: number;
  /** Number of chronicle entries currently registered for this project. */
  chronicles: number;
  /** Number of topic pages currently registered for this project. */
  topics: number;
  /** Number of cards currently registered for this project. */
  cards: number;
  /** Most recent updatedAt across this project's chronicles+topics+cards
   *  (`null` if nothing exists yet). Helpful for users skimming the list. */
  lastTouchedAt: string | null;
}

export interface ListProjectsPayload {
  projects: ProjectStats[];
  meta: {
    /** True if the user's cwd equals the configured repoPath. The skill
     *  uses this to decide between global-mode (fan-out) and project-mode. */
    isInSessionRepo: boolean;
    /** Configured repoPath, so the skill can show the user where to `cd`
     *  if they're not already there. */
    sessionRepoPath: string;
  };
}

/**
 * List every real project that has at least one synced session, with
 * per-project counts of pending vs already-digested sessions and existing
 * book artifacts. Pseudo-projects (those failing isRealProjectPath) are
 * excluded — they can't be digested anyway.
 *
 * The global-mode `/vibebook` skill calls this to:
 *   1. show the user a table of "what's left",
 *   2. decide which projects to spawn subagents for (pendingSessions > 0),
 *   3. avoid re-digesting projects the user already handled in project-mode.
 */
export function buildListProjectsPayload(cwd: string = process.cwd()): ListProjectsPayload {
  const cfg = readConfig();
  const indexFile = loadIndex(cfg.repoPath);
  const bookIndex = loadBookIndexV2(cfg.repoPath);

  const consumed = new Set<string>();
  for (const c of Object.values(bookIndex.chronicles)) {
    for (const sid of c.sessionIds) consumed.add(sid);
  }

  const stats = new Map<string, ProjectStats>();
  const ensure = (project: string): ProjectStats => {
    let s = stats.get(project);
    if (!s) {
      s = {
        project,
        totalSessions: 0, consumedSessions: 0, pendingSessions: 0,
        chronicles: 0, topics: 0, cards: 0, lastTouchedAt: null,
      };
      stats.set(project, s);
    }
    return s;
  };

  for (const e of Object.values(indexFile.entries)) {
    if (!isRealProjectPath(e.project)) continue;
    const s = ensure(e.project);
    s.totalSessions++;
    if (consumed.has(e.sessionId)) s.consumedSessions++;
  }
  for (const c of Object.values(bookIndex.chronicles)) {
    if (!isRealProjectPath(c.project)) continue;
    const s = ensure(c.project);
    if (!c.skip) s.chronicles++;
    s.lastTouchedAt = laterOf(s.lastTouchedAt, c.updatedAt);
  }
  for (const t of Object.values(bookIndex.topics)) {
    const s = ensure(t.project);
    s.topics++;
    s.lastTouchedAt = laterOf(s.lastTouchedAt, t.updatedAt);
  }
  for (const c of Object.values(bookIndex.cards)) {
    const s = ensure(c.project);
    s.cards++;
    s.lastTouchedAt = laterOf(s.lastTouchedAt, c.updatedAt);
  }

  for (const s of stats.values()) {
    s.pendingSessions = s.totalSessions - s.consumedSessions;
  }

  // Sort: most pending first; tie-break by project slug. Empty-pending at the
  // end so global-mode skill can early-cut after the first zero-pending row.
  const projects = [...stats.values()].sort((a, b) => {
    if (a.pendingSessions !== b.pendingSessions) return b.pendingSessions - a.pendingSessions;
    return a.project.localeCompare(b.project);
  });

  return {
    projects,
    meta: {
      isInSessionRepo: pathsEqual(cwd, cfg.repoPath),
      sessionRepoPath: cfg.repoPath,
    },
  };
}

function laterOf(a: string | null, b: string): string {
  if (!a) return b;
  return a > b ? a : b;
}

function pathsEqual(a: string, b: string): boolean {
  // Case-sensitive on macOS APFS by default; we deliberately don't
  // normalize symlinks (cwd through a symlink is a different "place" for
  // the skill's purposes — the user explicitly cd'd via that path).
  const trim = (p: string) => p.replace(/\/+$/, "");
  return trim(a) === trim(b);
}

/** CLI entry: print payload as JSON to stdout. */
export async function listProjectsCmd(): Promise<void> {
  const payload = buildListProjectsPayload();
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
