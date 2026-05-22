import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedSession, ContentBlock, SessionManifest, TocEntry } from "./types.js";
import { extractManifest } from "./digest/manifest.js";
import { buildTocEntries, renderTocMarkdown } from "./digest/toc.js";

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

/**
 * Two-pass renderer:
 *   Pass 1 — render each message to its own string, track per-message line
 *     offsets RELATIVE TO body start.
 *   Pass 2 — build the manifest (mechanical facts) and importance-based TOC
 *     using those relative offsets. Compute the line count of the
 *     `frontmatter + TOC + separator` prefix. Patch every `line:` field in
 *     manifest + TOC by adding the prefix length so consumers can
 *     `Read offset:line` into the final file and land on the right turn.
 *   Emit: `<frontmatter incl. manifest>` → `<TOC block>` → `<body>`.
 */
function renderMarkdown(s: NormalizedSession, ctx: RenderCtx): string {
  // Filter out messages that render to empty (keeps body indices aligned
  // with what the consumer will actually see).
  const renderedPerMessage: { md: string; src: NormalizedSession["messages"][number] }[] = [];
  for (const m of s.messages) {
    const md = renderMessageBlock(m, ctx);
    if (!md) continue;
    renderedPerMessage.push({ md, src: m });
  }

  // Body assembly + per-message line offsets relative to body start (1-based,
  // matching how the `Read` tool reports line numbers).
  //
  // Math: a rendered message of `numLines` (split by `\n`) lines does NOT
  // end with a trailing newline. After writing it the cursor sits at the
  // end of line (currentLine + numLines - 1). Joining the next message with
  // "\n\n" advances by 2 newlines: cursor → start of (currentLine + numLines)
  // → empty line + start of (currentLine + numLines + 1). So the next
  // message begins at currentLine + numLines + 1.
  const bodyParts: string[] = [];
  const messageLineOffsetsRelative: number[] = [];
  let currentLine = 1;
  for (let i = 0; i < renderedPerMessage.length; i++) {
    messageLineOffsetsRelative.push(currentLine);
    const md = renderedPerMessage[i]!.md;
    bodyParts.push(md);
    if (i < renderedPerMessage.length - 1) {
      currentLine += md.split("\n").length + 1;
    }
  }
  const body = bodyParts.join("\n\n");

  // Build manifest + TOC against relative offsets.
  const renderedMessages = renderedPerMessage.map((r) => r.src);
  const manifestRel = extractManifest(renderedMessages, messageLineOffsetsRelative);
  const tocRel = buildTocEntries(renderedMessages, messageLineOffsetsRelative);

  // Render the prefix (frontmatter + TOC) with RELATIVE line numbers first so
  // we can measure its true line count. Then re-render with offset-patched
  // line numbers and emit.
  const tocMdRel = renderTocMarkdown(tocRel);
  const frontmatterRel = renderFrontmatter(s, manifestRel);
  const tocSection = tocMdRel ? `\n\n${tocMdRel}` : "";
  const prefixRel = frontmatterRel + tocSection + "\n\n";
  const prefixLineCount = prefixRel.split("\n").length - 1;
  // -1 because the trailing "\n\n" puts the body's first line at the line
  // *after* the empty separator line; the body's "line 1" sits at exactly
  // `prefixLineCount + 1` in the final file.

  const manifest: SessionManifest = patchManifestLines(manifestRel, prefixLineCount);
  const toc: TocEntry[] = tocRel.map((e) => ({ ...e, line: e.line + prefixLineCount }));

  const frontmatter = renderFrontmatter(s, manifest);
  const tocMd = renderTocMarkdown(toc);
  return [frontmatter, tocMd, body].filter(Boolean).join("\n\n");
}

function patchManifestLines(m: SessionManifest, offset: number): SessionManifest {
  return {
    ...m,
    commits: m.commits.map((c) => ({ ...c, line: c.line + offset })),
    candidate_decisions: m.candidate_decisions.map((d) => ({ ...d, line: d.line + offset })),
  };
}

function renderFrontmatter(s: NormalizedSession, m: SessionManifest): string {
  const lines = [
    "---",
    `sessionId: ${s.sessionId}`,
    `tool: ${s.tool}`,
    `project: ${s.project}`,
    `projectRaw: ${s.projectRaw}`,
    `startedAt: ${s.startedAt}`,
    `endedAt: ${s.endedAt}`,
    `displayName: ${yamlSafeString(s.displayName)}`,
    `manifest_version: 1`,
    `user_turns: ${m.user_turns}`,
    `assistant_turns: ${m.assistant_turns}`,
    ...renderToolsUsed(m.tools_used),
    ...renderCommits(m.commits),
    ...renderFilesTouched(m.files_touched),
    ...renderCandidateDecisions(m.candidate_decisions),
    "---",
  ];
  return lines.join("\n");
}

function renderToolsUsed(t: Record<string, number>): string[] {
  const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ["tools_used: {}"];
  return ["tools_used:", ...entries.map(([k, v]) => `  ${yamlSafeKey(k)}: ${v}`)];
}

function renderCommits(commits: SessionManifest["commits"]): string[] {
  if (commits.length === 0) return ["commits: []"];
  return [
    "commits:",
    ...commits.map((c) => `  - { sha: ${yamlSafeString(c.sha)}, msg: ${yamlSafeString(c.msg)}, line: ${c.line} }`),
  ];
}

function renderFilesTouched(files: string[]): string[] {
  if (files.length === 0) return ["files_touched: []"];
  return [
    "files_touched:",
    ...files.map((f) => `  - ${yamlSafeString(f)}`),
  ];
}

function renderCandidateDecisions(decisions: SessionManifest["candidate_decisions"]): string[] {
  if (decisions.length === 0) return ["candidate_decisions: []"];
  return [
    "candidate_decisions:",
    ...decisions.map((d) => `  - { line: ${d.line}, preview: ${yamlSafeString(d.preview)} }`),
  ];
}

/** YAML-safe one-line string. If the value contains anything quoting-hostile
 *  (colons, hash, special chars, leading/trailing whitespace, or any quote),
 *  wrap in single quotes and escape internal single quotes by doubling them
 *  (YAML 1.2 spec). */
function yamlSafeString(s: string): string {
  if (/^[A-Za-z0-9_一-鿿　-〿 -]+$/.test(s) && s === s.trim()) return s;
  const escaped = s.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** YAML-safe object key. Tool names contain only letters/digits/`_`, but be
 *  defensive: anything outside the safe set gets single-quoted. */
function yamlSafeKey(s: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function renderMessageBlock(
  m: NormalizedSession["messages"][number],
  ctx: RenderCtx,
): string {
  const heading =
    m.role === "user" ? "## User" :
    m.role === "assistant" ? "## Assistant" :
    `## ${m.role}`;
  const ts = m.timestamp ? ` _(${m.timestamp})_` : "";

  const rendered = renderMessageContent(m.contentBlocks, m.text, m.reasoning, ctx);
  if (!rendered.trim()) return "";
  return `${heading}${ts}\n\n${rendered}`;
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
