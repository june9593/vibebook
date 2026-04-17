import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedSession } from "./types.js";

export interface WrittenPaths { raw: string; md: string; }

export function writeSession(repoRoot: string, s: NormalizedSession): WrittenPaths {
  const date = s.startedAt.slice(0, 10); // YYYY-MM-DD
  const dirRel = join("raw_sessions", s.tool, s.project, date);
  const absDir = join(repoRoot, dirRel);
  mkdirSync(absDir, { recursive: true });

  const base = `${s.nameSlug}__${s.shortId}`;
  const rawRel = join(dirRel, `${base}.raw.json`);
  const mdRel = join(dirRel, `${base}.md`);

  writeFileSync(join(repoRoot, rawRel), JSON.stringify(s, null, 2) + "\n");
  writeFileSync(join(repoRoot, mdRel), renderMarkdown(s));

  return { raw: rawRel, md: mdRel };
}

function renderMarkdown(s: NormalizedSession): string {
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
    return `${heading}${ts}\n\n${m.text}\n`;
  }).join("\n");
  return header + body;
}
