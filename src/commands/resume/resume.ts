import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { readConfig } from "../../config.js";
import { loadIndex } from "../../index-store.js";
import { loadAggregatedIndex, aggregatedPath } from "../../aggregated-store.js";
import { findEntries } from "./fuzzy-match.js";
import {
  renderResumePrompt,
  renderResumePromptChunked,
  extractMdHeader,
  chooseInvocation,
  CHUNKED_THRESHOLD_BYTES,
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
  const ownIdx = loadIndex(cfg.repoPath);
  const aggIdx = loadAggregatedIndex();

  // 1. Fuzzy match across BOTH own and aggregated indices. Each match
  //    carries a flag identifying which index it came from — that
  //    determines whether the md lives in session-repo or in the
  //    aggregated worktree (P7 cross-device support).
  type Hit = { entry: import("../../types.js").IndexEntry; isOwn: boolean };
  const ownMatches: Hit[] = findEntries(ownIdx, opts.idOrPrefix).map((entry) => ({ entry, isOwn: true }));
  const aggMatches: Hit[] = aggIdx
    ? findEntries(aggIdx, opts.idOrPrefix)
        .filter((e) => !ownIdx.entries[`${e.tool}:${e.sessionId}`]) // dedupe — own wins
        .map((entry) => ({ entry, isOwn: false }))
    : [];
  const matches: Hit[] = [...ownMatches, ...aggMatches];
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
        ({ entry: m, isOwn }) =>
          `  ${m.shortId}  ${m.displayName.slice(0, 50)}  (${m.startedAt.slice(0, 10)})${isOwn ? "" : " [from another device]"}`,
      ),
      ``,
      `Pass a longer id prefix to disambiguate.`,
    ];
    throw new Error(lines.join("\n"));
  }
  const { entry, isOwn } = matches[0]!;

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
  const baseRoot = isOwn ? cfg.repoPath : aggregatedPath();
  const mdPath = join(baseRoot, mdRelative);
  if (!existsSync(mdPath)) {
    throw new Error(
      `Context md missing: ${mdPath}. ` +
      (isOwn
        ? `The source device may not have synced this session yet, or you're on a 0.5.x spool that hasn't been re-synced under 0.6.`
        : `This is a sibling-device session — run \`vibebook sync\` to refresh the aggregated worktree.`),
    );
  }
  const contextMd = readFileSync(mdPath, "utf8");
  const mdBytes = statSync(mdPath).size;

  // 4. Build prompt. Chunked mode (header inline + on-disk Read) only
  //    when BOTH conditions hold:
  //      (a) md has `manifest_version: 1` (0.7.0+ schema), so the TOC
  //          is available for Claude to navigate, AND
  //      (b) file is bigger than CHUNKED_THRESHOLD_BYTES (50 KB). Below
  //          that, chunked navigation is overhead — full embed is faster
  //          and gives Claude the whole conversation in one prompt. 0.8.5
  //          dogfood caught a 33 KB cross-device session getting chunked
  //          unnecessarily.
  //    Otherwise (no manifest, or small file) fall back to embedding the
  //    full md.
  const headerMd = extractMdHeader(contextMd);
  const useChunked = headerMd !== null && mdBytes >= CHUNKED_THRESHOLD_BYTES;
  const prompt = useChunked
    ? renderResumePromptChunked(entry, mdPath, headerMd!, mdBytes)
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
  console.log(chalk.gray(`  Context:     ${(mdBytes / 1024).toFixed(1)} KB ${useChunked ? "(chunked — header inline, body on disk)" : "(full embed)"}`));
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
