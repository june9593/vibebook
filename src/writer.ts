import { mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedSession } from "./types.js";

export interface WriteSessionOptions {
  /** Render the assistant's reasoning/thinking as a `> 💭` blockquote in md.
   *  When false, reasoning is dropped from md (still preserved in raw.json).
   *  Default: true. */
  includeReasoning?: boolean;
}

export interface WrittenPaths {
  raw: string;
  md: string;
  /** Original jsonl copied alongside the .md/.raw.json. Undefined when the
   *  source exceeds JSONL_MAX_BYTES (GitHub rejects pushes >100 MB and
   *  warns >50 MB). Skipped jsonls cannot be `vibebook resume`d but the
   *  .md/.raw.json digest still ships. */
  jsonl?: string;
}

/** Hard cap on jsonl size we'll copy into the spool. GitHub's hard reject
 *  is 100 MB; we leave a 5 MB margin so combined commits don't push us over.
 *  Sessions above this still get .md + .raw.json. */
export const JSONL_MAX_BYTES = 95 * 1024 * 1024;

/** Soft warning threshold — GitHub starts complaining at 50 MB even though
 *  it accepts the push. We log a one-liner so users notice before the spool
 *  bloats. */
export const JSONL_WARN_BYTES = 50 * 1024 * 1024;

export function writeSession(repoRoot: string, s: NormalizedSession, opts: WriteSessionOptions = {}): WrittenPaths {
  const date = s.startedAt.slice(0, 10); // YYYY-MM-DD
  const dirRel = join("raw_sessions", s.tool, s.project, date);
  const absDir = join(repoRoot, dirRel);
  mkdirSync(absDir, { recursive: true });

  const base = `${s.nameSlug}__${s.shortId}`;
  const rawRel = join(dirRel, `${base}.raw.json`);
  const mdRel = join(dirRel, `${base}.md`);

  writeFileSync(join(repoRoot, rawRel), JSON.stringify(s, null, 2) + "\n");
  writeFileSync(join(repoRoot, mdRel), renderMarkdown(s, opts.includeReasoning ?? true));

  const jsonlRel = maybeCopyJsonl(repoRoot, dirRel, base, s.sourcePath);

  return jsonlRel ? { raw: rawRel, md: mdRel, jsonl: jsonlRel } : { raw: rawRel, md: mdRel };
}

/** Copy the original jsonl into the spool unless it exceeds the GitHub-push
 *  size cap. Returns the relative path on success, undefined on skip. */
function maybeCopyJsonl(repoRoot: string, dirRel: string, base: string, sourcePath: string): string | undefined {
  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    // Source file gone — nothing we can do; skip silently. The .md/.raw.json
    // we already wrote captures the session content.
    return undefined;
  }
  if (size > JSONL_MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    console.warn(
      `! oversized jsonl skipped (${mb} MB > 95 MB GitHub limit): ${sourcePath}\n` +
      `  .md + .raw.json still written; this session can't be 'vibebook resume'd.`,
    );
    return undefined;
  }
  if (size > JSONL_WARN_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    console.warn(`! large jsonl (${mb} MB > 50 MB): ${sourcePath} — git push may warn.`);
  }
  const jsonlRel = join(dirRel, `${base}.jsonl`);
  copyFileSync(sourcePath, join(repoRoot, jsonlRel));
  return jsonlRel;
}

function renderMarkdown(s: NormalizedSession, includeReasoning: boolean): string {
  const header = [
    `# ${s.displayName}`,
    "",
    `**Tool:** ${s.tool}  `,
    `**Project:** ${s.project} (\`${s.projectRaw}\`)  `,
    `**Session ID:** \`${s.sessionId}\`  `,
    `**Started:** ${s.startedAt}  `,
    `**Ended:** ${s.endedAt}  `,
    "",
    "---",
    "",
  ].join("\n");
  const body = s.messages.map((m) => {
    const heading = m.role === "user" ? "## User" : m.role === "assistant" ? "## Assistant" : `## ${m.role}`;
    const ts = m.timestamp ? ` _(${m.timestamp})_` : "";
    // When the assistant exposed reasoning/thinking content, render it as a
    // blockquote prefixed with 💭 so the summarizing LLM can distinguish it
    // from the actual reply. We put it BEFORE the text because reasoning is
    // chronologically what came first.
    const parts: string[] = [];
    if (includeReasoning && m.reasoning) {
      const quoted = m.reasoning.split("\n").map((l) => `> ${l}`).join("\n");
      parts.push(`> 💭 _reasoning_\n${quoted}`);
    }
    if (m.text) parts.push(m.text);
    // If neither text nor (rendered) reasoning, drop the empty turn.
    if (parts.length === 0) return "";
    return `${heading}${ts}\n\n${parts.join("\n\n")}\n`;
  }).filter(Boolean).join("\n");
  return header + body;
}
