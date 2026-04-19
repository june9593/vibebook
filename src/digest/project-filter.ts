/**
 * Heuristic: a path is a "real project" if it's a developer working directory,
 * not a worktree, electron data dir, or transient workspace path.
 *
 * Rejects:
 *   - paths containing /.worktrees-*
 *   - paths ending in *.code-workspace, *-workspace.json (workspace fragments)
 *   - paths ending in -workspaceStorage (VSCode workspaceStorage hash dirs)
 *   - empty / "root" / "home"
 *   - long-numeric-prefixed slugs (10+ digit run, e.g. workspaceStorage timestamps)
 *   - 20+ pure-hex strings (workspaceStorage hashes)
 *
 * This is a heuristic — it's allowed to be wrong in edge cases. Goal: clean
 * the obviously-junk projects out of book/ TOC.
 */
export function isRealProjectPath(slugOrPath: string): boolean {
  if (!slugOrPath || slugOrPath === "root" || slugOrPath === "home") return false;
  const lower = slugOrPath.toLowerCase();
  if (lower.includes(".worktrees-")) return false;
  if (lower.endsWith(".code-workspace") || lower.endsWith("-workspacestorage")) return false;
  if (lower.endsWith("-workspace.json")) return false;
  // Reject pure-numeric / 32-hex-like pseudo-IDs masquerading as project names
  if (/^\d{10,}/.test(slugOrPath)) return false;
  if (/^[a-f0-9]{20,}$/.test(slugOrPath)) return false;
  return true;
}
