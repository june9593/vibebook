import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage, ContentBlock } from "../types.js";
import { deriveSlug } from "../slug.js";
import { cachedProjectSlug } from "../project-identity.js";
import {
  inferProjectFromContent,
  listKnownProjectRoots,
  MIN_CONFIDENCE,
} from "../content-project-inference.js";

// Cached at module scope: listing ~/.claude/projects/ on every parse is
// fine but redundant when sync touches hundreds of jsonls in one run.
let cachedRoots: { path: string; slug: string }[] | null = null;
function getRoots(): { path: string; slug: string }[] {
  if (cachedRoots === null) cachedRoots = listKnownProjectRoots();
  return cachedRoots;
}

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly name = "claude" as const;
  constructor(private readonly root: string = join(homedir(), ".claude", "projects")) {}

  async *discover(): AsyncIterable<DiscoveredSession> {
    if (!existsSync(this.root)) return;
    const stack: string[] = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          // Skip our own scratch dirs and system tmpdirs — see isVibebookOrTmpProjectDir.
          // We only filter at the top level (entries directly under ~/.claude/projects/).
          if (dir === this.root && isVibebookOrTmpProjectDir(e.name)) continue;
          // Skip Claude Code's own subagent transcript dirs at any depth.
          // These appear as ~/.claude/projects/<proj>/<sessionId>/subagents/agent-*.jsonl
          // and contain agentic prompt boilerplate ("You are implementing Task X")
          // that pollutes raw_sessions with bogus session titles. They are NOT user
          // sessions; they are sub-task transcripts spawned by an outer session.
          if (e.name === "subagents") continue;
          stack.push(p);
        }
        else if (e.isFile() && e.name.endsWith(".jsonl")) {
          const st = statSync(p);
          const buf = readFileSync(p);
          const sha = createHash("sha256").update(buf).digest("hex");
          yield {
            sourcePath: p,
            sourceMtimeMs: st.mtimeMs,
            sourceSha256: sha,
            load: async () => parseClaudeJsonl(p, buf.toString("utf8")),
          };
        }
      }
    }
  }
}

/**
 * Skip Claude project directories that correspond to vibebook's own scratch
 * subprocesses. We deliberately do NOT filter by tmpdir-prefix alone —
 * developers may legitimately run `claude` in /tmp/experiment etc., and we
 * shouldn't silently drop their work. We require one of the known scratch
 * substrings (which only vibebook-spawned cwds contain) to confirm provenance.
 *
 * Both `vibebook-claude-` and `memvc-claude-` are recognized — the latter is
 * the legacy name from before the project was renamed; old user machines
 * may still have leftover dirs from pre-rename runs that crashed before
 * cleanup, and we want sync to skip them too.
 */
export function isVibebookOrTmpProjectDir(name: string): boolean {
  return name.includes("-vibebook-claude-") || name.includes("-memvc-claude-");
}

function parseClaudeJsonl(sourcePath: string, content: string): NormalizedSession {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const messages: SessionMessage[] = [];
  let sessionId = "";
  let cwd = "";
  let startedAt = "";
  let endedAt = "";

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.type === "user" || obj.type === "assistant") {
      // isMeta=true entries are system-injected pseudo-messages (slash-command
      // skill body, command output replays, etc.) — never real user input.
      // Without this filter, a session that started with `hi` + `/vibebook`
      // (both too short to survive sanitization) would derive its displayName
      // from the injected skill template, producing titles like
      // "## Step 0 — Detect the mode (DO THIS FIRST)…" with no real user prompts
      // in the rendered .md.
      if (obj.isMeta === true) continue;
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }
      const { text: rawText, reasoning: rawReasoning, contentBlocks } = extractParts(obj.message);
      const text = sanitizeMessageText(rawText);
      const reasoning = sanitizeMessageText(rawReasoning);
      // Drop the message only when text + reasoning + tool blocks are all
      // empty. A message that's "just a tool_use" still carries information
      // and should be kept.
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === "tool_use" || b.type === "tool_result",
      );
      if (text || reasoning || hasToolBlocks) {
        const msg: SessionMessage = {
          role: obj.type === "user" ? "user" : "assistant",
          text,
          timestamp: ts,
          raw: obj,
          contentBlocks,
        };
        if (reasoning) msg.reasoning = reasoning;
        messages.push(msg);
      }
    }
  }

  const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
  const { slug, display } = deriveSlug(firstUser);
  const fallbackId = basename(sourcePath, ".jsonl");
  const finalId = sessionId || fallbackId;
  const shortId = finalId.slice(0, 8);

  // Default project from cwd; override only if content inference is
  // confident AND disagrees with cwd. We carry the original cwd-project
  // in `cwdProject` for auditing — caller (prepare/digest) can show it.
  const cwdProject = cachedProjectSlug(cwd);
  const inference = inferProjectFromContent(messages, getRoots());
  const useInferred =
    inference.inferredProject !== null &&
    inference.inferredProject !== cwdProject &&
    inference.confidence >= MIN_CONFIDENCE;
  const project = useInferred ? inference.inferredProject! : cwdProject;

  const out: NormalizedSession = {
    tool: "claude",
    sessionId: finalId,
    shortId,
    project,
    projectRaw: cwd,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || new Date(0).toISOString(),
    nameSlug: slug,
    displayName: display,
    messages,
    sourcePath,
  };
  if (useInferred) {
    out.projectInferredFrom = "content";
    out.cwdProject = cwdProject;
  }
  return out;
}

/**
 * Pull text + reasoning out of a Claude API message.
 *
 * Content can be either a string or an array of typed blocks:
 *   - {type:"text", text:"..."}        → text
 *   - {type:"thinking", thinking:"..."} → reasoning (usually empty in CLI
 *     output because the API returns an encrypted signature instead;
 *     rare cases ship plaintext when the user enabled it)
 *   - {type:"tool_use" / "tool_result"} → ignored (vibebook doesn't
 *     summarize tool traces; logex does the same)
 */
function extractParts(message: any): {
  text: string;
  reasoning: string;
  contentBlocks: ContentBlock[];
} {
  if (!message) return { text: "", reasoning: "", contentBlocks: [] };
  const c = message.content;
  if (typeof c === "string") {
    return {
      text: c,
      reasoning: "",
      contentBlocks: [{ type: "text", text: c }],
    };
  }
  if (!Array.isArray(c)) return { text: "", reasoning: "", contentBlocks: [] };

  const texts: string[] = [];
  const reasonings: string[] = [];
  const blocks: ContentBlock[] = [];
  for (const p of c) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      texts.push(p.text);
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking.length > 0) {
      reasonings.push(p.thinking);
      blocks.push({ type: "thinking", thinking: p.thinking });
    } else if (p.type === "tool_use" && typeof p.name === "string") {
      const block: ContentBlock = { type: "tool_use", name: p.name, input: p.input ?? {} };
      if (typeof p.id === "string") block.id = p.id;
      blocks.push(block);
    } else if (p.type === "tool_result") {
      // tool_result.content can be a string OR an array of {type:"text",text:"..."} blocks.
      // Flatten to a single string for our markdown renderer.
      let content = "";
      if (typeof p.content === "string") content = p.content;
      else if (Array.isArray(p.content)) {
        content = p.content
          .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
          .join("");
      }
      const block: ContentBlock = { type: "tool_result", content };
      if (typeof p.tool_use_id === "string") block.toolUseId = p.tool_use_id;
      blocks.push(block);
    }
    // image / etc. → drop
  }
  return {
    text: texts.join("\n"),
    reasoning: reasonings.join("\n"),
    contentBlocks: blocks,
  };
}

/**
 * Strip noise that pollutes summarization quality. The patterns target Claude
 * Code CLI's command-system markers and ANSI-laden tool output that show up
 * inside the user's text content but carry zero information about the actual
 * coding work.
 *
 * Categories handled:
 *   1. Inline tag blocks: <system-reminder>...</system-reminder>,
 *      <local-command-caveat>...</local-command-caveat>,
 *      <command-message>, <command-name>, <command-args>,
 *      <local-command-stdout>...</local-command-stdout>
 *      (the stdout block can contain heavy ANSI escapes from /context, /model,
 *       /tasks etc. — strip whole block)
 *   2. Skill preamble: every text starts with "Base directory for this skill:"
 *      followed by hundreds of lines of skill template. Drop everything from
 *      that marker to the next blank-line + "## " heading or end of text.
 *   3. API error messages: "API Error: 400 ..." replies are noise.
 *   4. Final length gate: after stripping, drop if < 10 chars (tiny
 *      acknowledgements like "ok" / "hi" carry no signal for digest).
 *
 * NOTE: This intentionally does NOT touch tool_use / tool_result / thinking
 * content blocks — those are filtered upstream in extractText() (only
 * type==="text" parts get through). This is purely about cleaning the user's
 * own text + Claude's text replies of CLI command-shell pollution.
 */
export function sanitizeMessageText(text: string): string {
  if (!text) return "";
  let s = text;

  // 1. Strip paired tag blocks (greedy match handles nested newlines + ANSI).
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  s = s.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  s = s.replace(/<command-name>[\s\S]*?<\/command-name>/g, "");
  s = s.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  // System-injected pseudo-messages: "Background command completed" / "task
  // finished" notifications and the user-interrupt markers Claude Code stamps
  // when the user hits Esc mid-tool-use. These appear under ## User but were
  // not actually typed by the user.
  s = s.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  s = s.replace(/\[Request interrupted by user[^\]]*\]/g, "");

  // 2. Skill preamble. Skill instructions can be 100s of lines of template;
  // they always start with "Base directory for this skill:" on its own line.
  // Cut from that marker to either (a) the next "---" separator on its own
  // line (skill files standard separator), (b) end of text. Be conservative:
  // only strip when the marker is at the start of a line.
  s = s.replace(/(^|\n)Base directory for this skill:[\s\S]*?(?=\n---\n|$)/g, "");

  // 3. Whole-message API errors carry no work signal — drop the whole text.
  if (/^\s*API Error:\s/.test(s)) return "";

  // 4. Trim and length-gate.
  s = s.trim();
  if (s.length < 10) return "";
  return s;
}
