import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexEntry } from "../../types.js";

/** macOS default ARG_MAX is 1 MB total args; Linux often higher. We use a
 *  conservative cap matching the smaller platform, leaving 10% headroom.
 *  The full prompt body + framing must fit under this; otherwise we fall
 *  back to writing the prompt to /tmp and asking Claude to Read it. */
export const ARG_MAX_BYTES = 256 * 1024;

export interface PromptCtx {
  device?: string;
}

/** Extract the header section of a 0.7+ manifest_version:1 md — the
 *  YAML frontmatter (with the manifest fields) plus the `# Table of
 *  Contents` block. Returns null when the md predates manifest_version:1
 *  (no `manifest_version: 1` line in the first 200 lines), so the caller
 *  can fall back to the full-embed path.
 *
 *  The split point is the first `## User` or `## Assistant` heading at
 *  the start of a line, which always appears immediately after the TOC.
 */
export function extractMdHeader(contextMd: string): string | null {
  const lookahead = contextMd.slice(0, 50 * 1024);
  if (!/^manifest_version:\s*1\b/m.test(lookahead)) return null;
  const m = contextMd.match(/\n## (User|Assistant)/);
  if (!m) return null;
  return contextMd.slice(0, m.index!);
}

/** Build the user-prompt text we'll feed Claude as the first turn. Used
 *  for legacy (0.6) md without manifest_version:1, or as a fallback when
 *  the header extractor can't locate the split point. */
export function renderResumePrompt(
  entry: IndexEntry,
  contextMd: string,
  ctx: PromptCtx = {},
): string {
  return [
    `I had a coding session on another machine that I'd like to continue.`,
    `Below is the full conversation history. Read it carefully — pay`,
    `attention to what files were touched, what was decided, and any open`,
    `questions or TODOs at the end. Then summarize back to me what state`,
    `we're in, and ask me what I'd like to do next.`,
    ``,
    `---`,
    `Session: ${entry.displayName}`,
    `Source device: ${ctx.device ?? "(unknown)"}`,
    `Started: ${entry.startedAt}`,
    `Ended: ${entry.endedAt}`,
    `---`,
    ``,
    contextMd,
    ``,
    `---`,
    `End of prior session. What's our next step?`,
  ].join("\n");
}

/** Chunked-resume prompt for 0.7+ manifest_version:1 md. Embeds only the
 *  header (frontmatter + manifest + TOC) inline and points Claude at the
 *  on-disk md for body access. The resuming Claude orients via the
 *  manifest, then `Read offset:` jumps via the TOC's →L<line> column to
 *  pull only the segments it needs — letting us resume 100MB sessions
 *  without blowing the context window. */
export function renderResumePromptChunked(
  entry: IndexEntry,
  mdPath: string,
  headerMd: string,
  fullMdBytes: number,
  ctx: PromptCtx = {},
): string {
  const sizeStr = formatSize(fullMdBytes);
  return [
    `I had a coding session on another machine that I'd like to continue.`,
    `The full transcript lives on disk at:`,
    ``,
    `  ${mdPath}`,
    ``,
    `It is ${sizeStr} — large enough that you should NOT Read the whole`,
    `file at once. The header below has a manifest (mechanical facts about`,
    `what was worked on) and a Table of Contents. Use them to navigate:`,
    ``,
    `1. Skim the manifest fields (commits / files_touched / candidate_decisions)`,
    `   to understand the session's shape.`,
    `2. Pick 3–5 TOC rows most relevant to where the work left off (commits`,
    `   near the end, decisions, last few user turns).`,
    `3. The TOC's "→L<number>" column is the absolute line number in the`,
    `   file. Use the Read tool with offset:<number> and limit:200 to pull`,
    `   just that turn.`,
    `4. Summarize back to me what state we're in (last decisions, open`,
    `   questions, next_steps), then ask what to do next.`,
    ``,
    `---`,
    `Session: ${entry.displayName}`,
    `Source device: ${ctx.device ?? "(unknown)"}`,
    `Started: ${entry.startedAt}`,
    `Ended: ${entry.endedAt}`,
    `---`,
    ``,
    headerMd,
    ``,
    `---`,
    `End of header. Body continues in the on-disk file above (line ~${headerMd.split("\n").length + 2} onward).`,
    `What's our next step?`,
  ].join("\n");
}

/** Decide how to pass the prompt to claude. Short prompts go via argv
 *  (`claude "prompt"`); long ones get spilled to /tmp and Claude reads
 *  them with its Read tool. The threshold leaves 10% headroom under
 *  ARG_MAX_BYTES so other argv components have room. */
export function chooseInvocation(prompt: string, shortId: string): string[] {
  if (Buffer.byteLength(prompt, "utf8") < ARG_MAX_BYTES * 0.9) {
    return ["claude", prompt];
  }
  const tmpPath = join(tmpdir(), `.vibebook-resume-${shortId}.md`);
  writeFileSync(tmpPath, prompt, "utf8");
  return ["claude", `Read ${tmpPath} and act on the instructions there.`];
}

/** 0.8.5: below this, resume uses full-embed mode (the whole md goes
 *  inline). Above it, chunked mode (header inline + on-disk Read).
 *  5000 tokens-ish — fits comfortably even in 200K context models,
 *  and saves Claude 1-2 round-trips on small sessions where chunked
 *  navigation buys nothing. */
export const CHUNKED_THRESHOLD_BYTES = 50 * 1024;

/** Adaptive byte → human size. Sub-MB shows KB; otherwise MB with one
 *  decimal. Pre-0.8.5 we always printed MB.toFixed(1), which rendered
 *  33 KB as `"0.0 MB"` — technically true, totally misleading next to
 *  "large enough that you should NOT Read the whole file at once". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
