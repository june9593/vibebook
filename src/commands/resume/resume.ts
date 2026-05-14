import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readConfig } from "../../config.js";
import { loadIndex } from "../../index-store.js";
import { rewriteJsonlPaths, type PathMap } from "./path-rewrite.js";

export interface ResumeOptions {
  sessionId: string;
}

export interface ResumeResult {
  /** Where the jsonl was written on this machine. */
  dest: string;
  /** This machine's local cwd for the project (after pathMap translation). */
  localCwd: string;
  /** A one-line hint for the user, e.g. `cd /path && claude --resume <id>`. */
  hint: string;
}

export async function resumeCmd(opts: ResumeOptions): Promise<ResumeResult> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);

  // Find the entry. Try both tool prefixes since callers may not know which.
  const candidates = [`claude:${opts.sessionId}`, `copilot:${opts.sessionId}`];
  const entry = candidates.map((k) => idx.entries[k]).find(Boolean);
  if (!entry) {
    throw new Error(
      `Session ${opts.sessionId} not found in spool index at ${cfg.repoPath}/.vibebook/index.json. ` +
      `Did you run 'vibebook sync' to pull from the device that holds it?`,
    );
  }

  const pathMap: PathMap = cfg.pathMap ?? {};

  // Translate the source's cwd to this machine's
  const localCwd = applyPathMap(entry.projectRaw, pathMap);

  // Source jsonl: same path as relativePath but .jsonl extension instead of .raw.json
  const srcAbs = join(cfg.repoPath, entry.relativePath.replace(/\.raw\.json$/, ".jsonl"));
  if (!existsSync(srcAbs)) {
    throw new Error(
      `Source jsonl missing on disk: ${srcAbs}. ` +
      `This session predates v0.5.0 spool format. ` +
      `Re-sync after upgrade: rm -rf ~/.vibebook/session-repo/raw_sessions && vibebook sync`,
    );
  }
  const sourceJsonl = readFileSync(srcAbs, "utf8");
  const rewrittenJsonl = rewriteJsonlPaths(sourceJsonl, pathMap);

  // Write to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  const encodedCwd = encodeCwdForClaude(localCwd);
  const dest = join(homedir(), ".claude", "projects", encodedCwd, `${entry.sessionId}.jsonl`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, rewrittenJsonl);

  const hint = `cd ${localCwd} && claude --resume ${entry.sessionId}`;
  return { dest, localCwd, hint };
}

/** Apply the longest-prefix-wins path translation to a single path string. */
function applyPathMap(path: string, pathMap: PathMap): string {
  const entries = Object.entries(pathMap).sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of entries) {
    if (path === from) return to;
    if (path.startsWith(from + "/")) return to + path.slice(from.length);
  }
  return path;
}

/** Claude Code encodes a cwd into a directory name by replacing every `/`
 *  with `-`. So `/Users/me/code/my-app` becomes `-Users-me-code-my-app`. */
function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/\//g, "-");
}
