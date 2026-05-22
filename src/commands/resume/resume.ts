import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { readConfig } from "../../config.js";
import { loadIndex } from "../../index-store.js";
import { findEntries } from "./fuzzy-match.js";
import {
  renderResumePrompt,
  renderResumePromptChunked,
  extractMdHeader,
  chooseInvocation,
} from "./render-prompt.js";

export interface ResumeOptions {
  /** Session id, shortId, or any UUID prefix (case-insensitive). */
  idOrPrefix: string;
  /** When true: don't spawn claude, print the invocation instead. */
  print?: boolean;
  /** Override the cwd used for project-match validation. Defaults to process.cwd(). */
  cwd?: string;
}

/** Result returned by resumeCmd. Mostly for unit tests; the human-facing
 *  output goes to stdout/stderr directly. */
export interface ResumeResult {
  matchedSessionId: string;
  expectedCwd: string;
  mdPath: string;
  invocation: string[];
  spawned: boolean;
}

/**
 * `vibebook resume <id>` — find the source session's markdown, build a prompt
 * with the conversation history, and launch a fresh `claude` session with
 * that prompt as the first user turn. The new Claude reads the prior context
 * and asks the user what to continue with.
 *
 * Does NOT touch ~/.claude/projects/, does NOT call `claude --resume`, does
 * NOT update any Claude internal state. Uses only the public `claude [prompt]`
 * CLI interface.
 */
export async function resumeCmd(opts: ResumeOptions): Promise<ResumeResult> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);

  // 1. Fuzzy match by id / prefix / full UUID
  const matches = findEntries(idx, opts.idOrPrefix);
  if (matches.length === 0) {
    throw new Error(
      `No session matches '${opts.idOrPrefix}'. ` +
      `Run 'vibebook list-sessions' to see what's available.`,
    );
  }
  if (matches.length > 1) {
    const lines = [
      `Multiple matches for '${opts.idOrPrefix}':`,
      ...matches.map(
        (m) => `  ${m.shortId}  ${m.displayName.slice(0, 50)}  (${m.startedAt.slice(0, 10)})`,
      ),
      ``,
      `Pass a longer id prefix to disambiguate.`,
    ];
    throw new Error(lines.join("\n"));
  }
  const entry = matches[0]!;

  // 2. Validate cwd (after pathMap translation)
  const pathMap = cfg.pathMap ?? {};
  const expectedCwd = applyPathMap(entry.projectRaw, pathMap);
  const actualCwd = resolve(opts.cwd ?? process.cwd());
  if (actualCwd !== expectedCwd) {
    throw new Error(
      `This session was for ${expectedCwd}\n` +
      `cd there first:  cd ${expectedCwd}`,
    );
  }

  // 3. Locate context md (handle legacy .raw.json relativePath by falling back to .md)
  const mdRelative = entry.relativePath.replace(/\.raw\.json$/, ".md");
  const mdPath = join(cfg.repoPath, mdRelative);
  if (!existsSync(mdPath)) {
    throw new Error(
      `Context md missing: ${mdPath}. ` +
      `The source device may not have synced this session yet, or you're ` +
      `on a 0.5.x spool that hasn't been re-synced under 0.6.`,
    );
  }
  const contextMd = readFileSync(mdPath, "utf8");
  const mdBytes = statSync(mdPath).size;

  // 4. Build prompt. Prefer the chunked path on 0.7+ md so very large
  //    sessions don't blow the resuming Claude's context window — the
  //    header (frontmatter + manifest + TOC) goes inline, the body stays
  //    on disk for targeted Read access via the TOC's line offsets. Falls
  //    back to embedding the full md when extractMdHeader returns null
  //    (older 0.6 sessions without manifest_version:1).
  const headerMd = extractMdHeader(contextMd);
  const prompt = headerMd !== null
    ? renderResumePromptChunked(entry, mdPath, headerMd, mdBytes)
    : renderResumePrompt(entry, contextMd);
  const argv = chooseInvocation(prompt, entry.shortId);

  // 5. Print or spawn
  if (opts.print) {
    console.log(`To continue, run:`);
    console.log(`  cd ${expectedCwd}`);
    console.log(`  ${argv.map(shellQuote).join(" ")}`);
    return { matchedSessionId: entry.sessionId, expectedCwd, mdPath, invocation: argv, spawned: false };
  }

  console.log(chalk.green(`\n✓ Matched: "${entry.displayName}"`));
  console.log(chalk.gray(`  Session id:  ${entry.sessionId}`));
  console.log(chalk.gray(`  Started:     ${entry.startedAt}`));
  console.log(chalk.gray(`  Context:     ${(mdBytes / 1024).toFixed(1)} KB ${headerMd !== null ? "(chunked — header inline, body on disk)" : "(full embed)"}`));
  console.log(chalk.cyan(`\nLaunching claude with context as first prompt...\n`));

  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: expectedCwd,
    stdio: "inherit",
  });
  if (r.error) {
    throw new Error(
      `Failed to spawn 'claude': ${r.error.message}. ` +
      `Make sure Claude Code is installed and on your PATH.`,
    );
  }
  return { matchedSessionId: entry.sessionId, expectedCwd, mdPath, invocation: argv, spawned: true };
}

/** Apply longest-prefix-wins path translation to a single path string. */
function applyPathMap(path: string, pathMap: Record<string, string>): string {
  const entries = Object.entries(pathMap).sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of entries) {
    if (path === from) return to;
    if (path.startsWith(from + "/")) return to + path.slice(from.length);
  }
  return path;
}

/** Minimal shell-quoting for the --print output. Wraps in single quotes
 *  and escapes embedded single quotes via the standard close-quote dance. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_/.,@:=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
