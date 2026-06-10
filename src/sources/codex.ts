import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage, ContentBlock } from "../types.js";
import { deriveSlug, projectSlugFromPath } from "../slug.js";
import { sanitizeMessageText } from "./claude-code.js";

export class CodexAdapter implements SourceAdapter {
  readonly name = "codex" as const;
  private titleMapCache: Map<string, string> | null = null;

  constructor(private readonly root: string = join(homedir(), ".codex")) {}

  private loadTitleMap(): Map<string, string> {
    if (this.titleMapCache !== null) return this.titleMapCache;
    const map = new Map<string, string>();
    const indexPath = join(this.root, "session_index.jsonl");
    if (existsSync(indexPath)) {
      try {
        const lines = readFileSync(indexPath, "utf8").split("\n");
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          try {
            const obj = JSON.parse(s) as { id?: string; thread_name?: string };
            if (typeof obj.id === "string" && typeof obj.thread_name === "string") {
              map.set(obj.id, obj.thread_name);
            }
          } catch { /* skip malformed line */ }
        }
      } catch { /* file unreadable */ }
    }
    this.titleMapCache = map;
    return map;
  }

  async *discover(): AsyncGenerator<DiscoveredSession> {
    if (!existsSync(this.root)) return;

    const paths = collectRolloutPaths(this.root);
    const titleMap = this.loadTitleMap();

    for (const p of paths) {
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.size === 0) continue;
      const buf = readFileSync(p);
      const sha = createHash("sha256").update(buf).digest("hex");
      const content = buf.toString("utf8");
      yield {
        sourcePath: p,
        sourceMtimeMs: st.mtimeMs,
        sourceSha256: sha,
        load: async () => parseCodexJsonl(p, content, titleMap),
      };
    }
  }
}

/**
 * Walk root/sessions/ (nested) and root/archived_sessions/ for rollout-*.jsonl files.
 */
function collectRolloutPaths(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: import("node:fs").Dirent<string>[];
    try { entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        results.push(p);
      }
    }
  }

  const sessionsDir = join(root, "sessions");
  const archivedDir = join(root, "archived_sessions");
  if (existsSync(sessionsDir)) walk(sessionsDir);
  if (existsSync(archivedDir)) walk(archivedDir);
  return results;
}

/**
 * Strip a leading injected block from user input_text.
 * Codex injects "# AGENTS.md instructions\n..." or
 * "<environment_context>..." / "<permissions instructions>..." blocks
 * as the first content item in a user turn.
 */
function stripLeadingInjectedBlock(text: string): string {
  const t = text.trimStart();
  if (
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<environment_context") ||
    t.startsWith("<permissions")
  ) {
    // Find the next non-empty line AFTER the injected block ends.
    // The block ends at the first blank line following content, OR at a </...> closing tag.
    // Strategy: if the text contains a closing tag, take everything after it.
    const closingMatch = t.match(/<\/\w[^>]*>\s*\n?/);
    if (closingMatch && closingMatch.index !== undefined) {
      const after = t.slice(closingMatch.index + closingMatch[0].length).trim();
      return after;
    }
    // For "# AGENTS.md" style (no closing tag): find the first blank-line-separated paragraph
    // after the first line, and take the rest.
    const lines = t.split("\n");
    let blankIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "") { blankIdx = i; break; }
    }
    if (blankIdx >= 0) {
      return lines.slice(blankIdx + 1).join("\n").trim();
    }
    // No real user text remains
    return "";
  }
  return text;
}

export function parseCodexJsonl(
  sourcePath: string,
  content: string,
  titleMap: Map<string, string>,
): NormalizedSession {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return emptySession(sourcePath, titleMap);
  }

  // Line 1: session_meta
  let sessionId = basename(sourcePath, ".jsonl");
  let cwd = "";
  let originator = "";
  let startedAt = "";

  try {
    const meta = JSON.parse(lines[0]);
    if (meta?.type === "session_meta" && meta?.payload) {
      const p = meta.payload;
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.originator === "string") originator = p.originator;
      if (typeof p.timestamp === "string") startedAt = p.timestamp;
    }
  } catch { /* use fallback values */ }

  // Skip filter: codex_exec sessions or sessions run in Codex sandboxed dir
  const isExec = originator === "codex_exec";
  const isCodexDir =
    typeof cwd === "string" &&
    cwd.startsWith(join(homedir(), "Documents", "Codex"));

  if (isExec || isCodexDir) {
    return {
      tool: "codex",
      sessionId,
      shortId: sessionId.slice(0, 8),
      project: projectSlugFromPath(cwd),
      projectRaw: cwd,
      startedAt: startedAt || new Date(0).toISOString(),
      endedAt: startedAt || new Date(0).toISOString(),
      nameSlug: "untitled",
      displayName: "untitled",
      messages: [],
      sourcePath,
    };
  }

  const messages: SessionMessage[] = [];
  let endedAt = startedAt;

  for (let i = 1; i < lines.length; i++) {
    let obj: any;
    try { obj = JSON.parse(lines[i]); } catch { continue; }

    // Track last timestamp for endedAt
    if (typeof obj?.timestamp === "string" && obj.timestamp) {
      endedAt = obj.timestamp;
    }

    // Only process response_item; skip event_msg and anything else
    if (obj?.type !== "response_item") continue;
    const payload = obj?.payload;
    if (!payload) continue;

    const ptype = payload.type;

    if (ptype === "message") {
      const role: string = payload.role;

      // Skip developer messages (permissions/system injection)
      if (role === "developer") continue;

      if (role === "user") {
        // Join all input_text blocks
        const contentArr: any[] = Array.isArray(payload.content) ? payload.content : [];
        const rawTexts: string[] = [];
        for (const block of contentArr) {
          if (block?.type === "input_text" && typeof block.text === "string") {
            rawTexts.push(block.text);
          }
        }
        if (rawTexts.length === 0) continue;

        // Strip leading AGENTS.md/environment_context/permissions block from first block
        let firstText = stripLeadingInjectedBlock(rawTexts[0]);
        const remainingTexts = rawTexts.slice(1);
        const allParts = firstText ? [firstText, ...remainingTexts] : remainingTexts;
        const joined = allParts.join("\n").trim();
        if (!joined) continue;

        const text = sanitizeMessageText(joined);
        if (!text) continue;

        const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
        messages.push({
          role: "user",
          text,
          timestamp: ts,
          contentBlocks: [{ type: "text", text }],
        });
      } else if (role === "assistant") {
        const contentArr: any[] = Array.isArray(payload.content) ? payload.content : [];
        const texts: string[] = [];
        for (const block of contentArr) {
          if (block?.type === "output_text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
        const joined = texts.join("\n");
        const text = sanitizeMessageText(joined);
        if (!text) continue;

        const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
        messages.push({
          role: "assistant",
          text,
          timestamp: ts,
          contentBlocks: [{ type: "text", text }],
        });
      }
      // other roles → skip
    } else if (ptype === "function_call") {
      // Emit as an assistant-role message carrying a tool_use block
      const name = typeof payload.name === "string" ? payload.name : "unknown";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      let input: unknown;
      try {
        input = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments ?? {};
      } catch {
        input = typeof payload.arguments === "string" ? payload.arguments : {};
      }
      const block: ContentBlock = { type: "tool_use", name, input };
      if (callId) block.id = callId;

      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      messages.push({
        role: "assistant",
        text: "",
        timestamp: ts,
        contentBlocks: [block],
      });
    } else if (ptype === "function_call_output") {
      // Emit as a user-role message carrying a tool_result block (mirrors Claude)
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const output = typeof payload.output === "string" ? payload.output : String(payload.output ?? "");
      const block: ContentBlock = { type: "tool_result", content: output };
      if (callId) block.toolUseId = callId;

      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      messages.push({
        role: "user",
        text: "",
        timestamp: ts,
        contentBlocks: [block],
      });
    } else if (ptype === "reasoning") {
      // Drop: encrypted content, no plaintext available
      continue;
    }
    // any other payload.type → drop
  }

  // Derive nameSlug + displayName
  const threadName = titleMap.get(sessionId);
  let nameSlug: string;
  let displayName: string;
  if (threadName) {
    const derived = deriveSlug(threadName);
    nameSlug = derived.slug;
    displayName = derived.display;
  } else {
    const firstUserText = messages.find((m) => m.role === "user" && m.text)?.text ?? "";
    const derived = deriveSlug(firstUserText);
    nameSlug = derived.slug;
    displayName = derived.display;
  }

  const shortId = sessionId.slice(0, 8);
  const project = projectSlugFromPath(cwd);

  return {
    tool: "codex",
    sessionId,
    shortId,
    project,
    projectRaw: cwd,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || startedAt || new Date(0).toISOString(),
    nameSlug,
    displayName,
    messages,
    sourcePath,
  };
}

function emptySession(sourcePath: string, _titleMap: Map<string, string>): NormalizedSession {
  const sessionId = basename(sourcePath, ".jsonl");
  return {
    tool: "codex",
    sessionId,
    shortId: sessionId.slice(0, 8),
    project: "root",
    projectRaw: "",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    nameSlug: "untitled",
    displayName: "untitled",
    messages: [],
    sourcePath,
  };
}
