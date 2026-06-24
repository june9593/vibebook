import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { simpleGit } from "simple-git";
import type { IndexFile, IndexEntry } from "./types.js";

/** Per-clone read-only mirror of `origin/main` mounted as a separate git
 *  worktree. Holds the union of every device's raw_sessions/ plus
 *  `.vibebook/index.aggregated.json` (written by CI's merge-books.mjs).
 *
 *  P7 (0.8.0): without this, `vibebook resume <id>` could only find sessions
 *  recorded by THIS device — sessions captured on a sibling device were
 *  unreachable until you manually checked out the other device branch.
 *
 *  Layout: `<HOME>/.vibebook/aggregated/` — sibling to `session-repo/`.
 *  Both worktrees share the same `.git` database. */
export function aggregatedPath(): string {
  return join(homedir(), ".vibebook", "aggregated");
}

/** Path inside aggregated worktree where merge-books.mjs writes the union
 *  index. Absent when CI hasn't run yet or no device had spool data. */
export function aggregatedIndexAbs(): string {
  return join(aggregatedPath(), ".vibebook", "index.aggregated.json");
}

/**
 * Ensure the aggregated worktree exists and points at the latest origin/main.
 * Best-effort — returns true on success, false otherwise (caller logs and
 * proceeds; aggregation is opt-in eye candy, not a hard requirement).
 *
 * First call: `git worktree add <aggPath> main` from the session-repo.
 * Subsequent calls: `git -C <aggPath> fetch + reset --hard origin/main`.
 * (Use reset instead of pull --ff-only because CI rewrites raw_sessions/
 * with every aggregate commit; a pure ff is the common case but reset
 * keeps the worktree clean even when the user accidentally edits files
 * inside it.)
 */
export async function refreshAggregatedWorktree(sessionRepoPath: string): Promise<boolean> {
  const aggPath = aggregatedPath();
  try {
    if (!existsSync(join(aggPath, ".git"))) {
      // First-time setup. `git worktree add` from the session repo, pointing
      // at the local-tracking `main` ref. If `main` doesn't exist locally yet
      // (very fresh clone), fall back to creating it from origin/main.
      mkdirSync(dirname(aggPath), { recursive: true });
      const repoGit = simpleGit(sessionRepoPath);
      // Make sure we have origin/main locally first.
      await repoGit.fetch("origin", "main").catch(() => {});
      // Ensure a local `main` ref tracks origin/main so worktree add can
      // point at a name (worktrees can't share a HEAD with another worktree,
      // and the session-repo is usually on a device branch already).
      const localMain = await repoGit.raw(["branch", "--list", "main"]).catch(() => "");
      if (!localMain.trim()) {
        await repoGit.raw(["branch", "main", "origin/main"]).catch(() => {});
      }
      await repoGit.raw(["worktree", "add", aggPath, "main"]);
      return true;
    }
    // Refresh path. Worktree exists; fetch + reset --hard to origin/main.
    const aggGit = simpleGit(aggPath);
    await aggGit.fetch("origin", "main");
    await aggGit.raw(["reset", "--hard", "origin/main"]);
    return true;
  } catch {
    return false;
  }
}

/** Read the aggregated index from the worktree. Returns null when:
 *   - the worktree doesn't exist (first sync hasn't called refresh)
 *   - main has never received an aggregate commit (no devices ran sync yet)
 *   - the file is malformed.
 * Callers should treat null as "no cross-device sessions known" and proceed
 * with own-only data. */
export function loadAggregatedIndex(): IndexFile | null {
  const p = aggregatedIndexAbs();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as IndexFile;
    if (parsed.version !== 1 || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Resolve the absolute path of a session's md file. Sessions captured by
 *  THIS device live under the session-repo working tree; sessions from
 *  sibling devices (= entries with originDevice set, only present in the
 *  aggregated index) live under the aggregated worktree. The IndexEntry's
 *  `relativePath` is the same in both cases — just resolved against a
 *  different root. */
export function resolveSessionMdPath(
  sessionRepoPath: string,
  entry: IndexEntry,
  isAggregated: boolean,
): string {
  const root = isAggregated ? aggregatedPath() : sessionRepoPath;
  return join(root, entry.relativePath);
}
