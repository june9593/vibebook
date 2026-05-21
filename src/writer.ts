import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedSession, ContentBlock } from "./types.js";

export interface WriteSessionOptions {
  /** Render the assistant's reasoning/thinking as `> 💭` blockquotes in md.
   *  Default true. Set false for smaller context models that don't benefit
   *  from reasoning context. */
  includeReasoning?: boolean;
  /** Skip truncation of large tool_result / tool_use.input blocks.
   *  Default false. Override via VIBEBOOK_FULL_TOOL_RESULTS=1. */
  fullToolResults?: boolean;
}

export interface WrittenPaths {
  md: string;
}

/** Threshold above which tool_result.content / tool_use.input gets truncated.
 *  Empirical: a 20 KB code-fence in markdown is already large; tool outputs
 *  bigger than this usually mean Claude Read a long file or Bash dumped a
 *  build log — neither is high-value context for resume. The truncation
 *  preserves first 30 + last 10 lines + a footer noting the original size. */
export const TRUNCATE_THRESHOLD_BYTES = 20 * 1024;

export function writeSession(
  repoRoot: string,
  s: NormalizedSession,
  opts: WriteSessionOptions = {},
): WrittenPaths {
  const date = s.startedAt.slice(0, 10); // YYYY-MM-DD
  const dirRel = join("raw_sessions", s.tool, s.project, date);
  const absDir = join(repoRoot, dirRel);
  mkdirSync(absDir, { recursive: true });

  const base = `${s.nameSlug}__${s.shortId}`;
  const mdRel = join(dirRel, `${base}.md`);

  const includeReasoning = opts.includeReasoning ?? true;
  const fullToolResults =
    opts.fullToolResults ?? process.env.VIBEBOOK_FULL_TOOL_RESULTS === "1";

  writeFileSync(
    join(repoRoot, mdRel),
    renderMarkdown(s, { includeReasoning, fullToolResults }),
  );

  return { md: mdRel };
}

interface RenderCtx {
  includeReasoning: boolean;
  fullToolResults: boolean;
}

function renderMarkdown(s: NormalizedSession, ctx: RenderCtx): string {
  return renderFrontmatter(s) + "\n\n" + renderBody(s, ctx);
}

function renderFrontmatter(s: NormalizedSession): string {
  // YAML frontmatter — keep values simple strings to avoid quoting hazards.
  // (project / displayName already get slugified upstream so they're safe.)
  const lines = [
    "---",
    `sessionId: ${s.sessionId}`,
    `tool: ${s.tool}`,
    `project: ${s.project}`,
    `projectRaw: ${s.projectRaw}`,
    `startedAt: ${s.startedAt}`,
    `endedAt: ${s.endedAt}`,
    `displayName: ${yamlSafeString(s.displayName)}`,
    "---",
  ];
  return lines.join("\n");
}

/** YAML-safe one-line string. If the value contains anything quoting-hostile
 *  (colons, hash, special chars), wrap in single quotes and escape internal
 *  single quotes by doubling them (YAML 1.2 spec). */
function yamlSafeString(s: string): string {
  if (/^[A-Za-z0-9_一-鿿　-〿 -]+$/.test(s)) return s;
  const escaped = s.replace(/'/g, "''");
  return `'${escaped}'`;
}

function renderBody(s: NormalizedSession, ctx: RenderCtx): string {
  const parts: string[] = [];
  for (const m of s.messages) {
    const heading =
      m.role === "user" ? "## User" :
      m.role === "assistant" ? "## Assistant" :
      `## ${m.role}`;
    const ts = m.timestamp ? ` _(${m.timestamp})_` : "";

    const rendered = renderMessageContent(m.contentBlocks, m.text, m.reasoning, ctx);
    if (!rendered.trim()) continue; // drop empty messages

    parts.push(`${heading}${ts}\n\n${rendered}`);
  }
  return parts.join("\n\n");
}

function renderMessageContent(
  blocks: ContentBlock[] | undefined,
  fallbackText: string,
  fallbackReasoning: string | undefined,
  ctx: RenderCtx,
): string {
  // Path 1: rich content blocks available (Claude source, post-Task 2)
  if (blocks && blocks.length > 0) {
    const out: string[] = [];
    for (const b of blocks) {
      if (b.type === "thinking") {
        if (!ctx.includeReasoning) continue;
        out.push(renderThinking(b.thinking));
      } else if (b.type === "text") {
        if (b.text.trim()) out.push(b.text);
      } else if (b.type === "tool_use") {
        out.push(renderToolUse(b, ctx));
      } else if (b.type === "tool_result") {
        out.push(renderToolResult(b, ctx));
      }
    }
    return out.join("\n\n");
  }
  // Path 2: legacy text-only message (Copilot source, or pre-Task 2 callers)
  const out: string[] = [];
  if (ctx.includeReasoning && fallbackReasoning) {
    out.push(renderThinking(fallbackReasoning));
  }
  if (fallbackText) out.push(fallbackText);
  return out.join("\n\n");
}

function renderThinking(text: string): string {
  const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
  return `> 💭 _thinking_\n${quoted}`;
}

function renderToolUse(b: Extract<ContentBlock, { type: "tool_use" }>, ctx: RenderCtx): string {
  const inputStr = JSON.stringify(b.input, null, 2);
  const truncated = ctx.fullToolResults
    ? inputStr
    : maybeTruncate(inputStr, "input");
  return `### 🔧 tool_use: ${b.name}\n\n\`\`\`json\n${truncated}\n\`\`\``;
}

function renderToolResult(b: Extract<ContentBlock, { type: "tool_result" }>, ctx: RenderCtx): string {
  const truncated = ctx.fullToolResults
    ? b.content
    : maybeTruncate(b.content, "output");
  return `### ✅ tool_result\n\n\`\`\`\n${truncated}\n\`\`\``;
}

/** Truncate strings above TRUNCATE_THRESHOLD_BYTES. Preserves first 30 lines
 *  + last 10 lines so the LLM still gets enough signal about what was read /
 *  output, without dragging multi-MB file dumps into the context.
 *
 *  Returns the original string unchanged if under threshold. */
function maybeTruncate(s: string, kind: "input" | "output"): string {
  if (Buffer.byteLength(s, "utf8") <= TRUNCATE_THRESHOLD_BYTES) return s;
  const lines = s.split("\n");
  if (lines.length <= 50) {
    // Single long line — truncate by character count
    const head = s.slice(0, 4000);
    const tail = s.slice(-1000);
    return `${head}\n\n[... truncated: ${(Buffer.byteLength(s, "utf8") / 1024).toFixed(1)} KB total, showing first 4000 + last 1000 chars ...]\n\n${tail}`;
  }
  const head = lines.slice(0, 30).join("\n");
  const tail = lines.slice(-10).join("\n");
  const omitted = lines.length - 40;
  const sizeKb = (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
  return `${head}\n\n[... truncated: ${sizeKb} KB ${kind}, omitting ${omitted} middle lines ...]\n\n${tail}`;
}
