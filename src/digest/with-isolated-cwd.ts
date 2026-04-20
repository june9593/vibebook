import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner } from "./runner.js";

/**
 * Run `callback` with an LlmRunner that injects a per-digest-run isolated cwd
 * into every spawn. Cleans up both:
 *   - the tmp cwd dir itself (always)
 *   - the Claude CLI's `~/.claude/projects/<hash>/` directory it created
 *     (best-effort; only when the user has the Claude CLI installed and it
 *     stamped session files there)
 *
 * The hash Claude uses for the projects directory is deterministic from the
 * cwd path: the absolute path with `/` replaced by `-`. We mirror that here
 * so we can find and delete the right directory.
 */
export async function withIsolatedCwd<T>(
  runner: LlmRunner,
  callback: (wrappedRunner: LlmRunner) => Promise<T>,
): Promise<T> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), "memvc-claude-"));
  const wrappedRunner: LlmRunner = {
    run: (prompt, vars, opts = {}) => runner.run(prompt, vars, { ...opts, cwd: isolatedCwd }),
  };
  try {
    return await callback(wrappedRunner);
  } finally {
    // First, resolve the cwd path so we can derive Claude CLI's hash. Must be
    // BEFORE we rm the tmpdir (since realpath needs the dir to exist).
    let resolvedCwd = isolatedCwd;
    try {
      resolvedCwd = realpathSync(isolatedCwd);
    } catch {
      // Defensive: if it was already gone, fall back to manual /private prefix
      // for macOS /var paths (the only platform where realpath matters here).
      if (isolatedCwd.startsWith("/var/")) {
        resolvedCwd = "/private" + isolatedCwd;
      }
    }
    // Best-effort #1: clean the tmp cwd dir.
    try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* swallow */ }
    // Best-effort #2: clean Claude CLI's session-history dir under
    // ~/.claude/projects/<hash>/ — we may have one or both of (resolved, unresolved)
    // hash names depending on Claude CLI's exact behavior. Try both.
    for (const candidatePath of new Set([resolvedCwd, isolatedCwd])) {
      const claudeProjectsDir = join(homedir(), ".claude", "projects", claudeProjectHash(candidatePath));
      if (existsSync(claudeProjectsDir)) {
        try { rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch { /* swallow */ }
      }
    }
  }
}

/**
 * Mirrors Claude CLI's directory-naming scheme for ~/.claude/projects/<X>/.
 *
 * From observation, Claude CLI uses the absolute cwd path with `/` replaced
 * by `-` (so `/var/folders/.../T/memvc-claude-AbCdEf` becomes
 * `-var-folders-...-T-memvc-claude-AbCdEf`). If this turns out to be wrong on
 * a future Claude CLI version, the cleanup just no-ops (existsSync returns
 * false), which is the safe failure mode.
 *
 * NOTE: if Claude switches to a hash-based naming, update this function.
 */
function claudeProjectHash(absPath: string): string {
  return absPath.split("/").join("-");
}

// Exported for tests.
export { claudeProjectHash as _claudeProjectHashForTests };
