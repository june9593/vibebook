import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedSession } from "./types.js";

export interface WriteSessionOptions {
  /** Render the assistant's reasoning/thinking as a `> 💭` blockquote in md.
   *  When false, reasoning is dropped from md (still preserved in raw.json).
   *  Default: true. */
  includeReasoning?: boolean;
}

export interface WrittenPaths { raw: string; md: string; }

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

  return { raw: rawRel, md: mdRel };
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
