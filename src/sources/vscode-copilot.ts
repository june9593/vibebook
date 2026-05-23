import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync, Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage, ContentBlock } from "../types.js";
import { deriveSlug, projectSlugFromPath } from "../slug.js";
import { sanitizeMessageText } from "./claude-code.js";

function defaultStorageRoot(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  if (process.platform === "win32")
    return join(homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage");
  return join(homedir(), ".config", "Code", "User", "workspaceStorage");
}

export class VSCodeCopilotAdapter implements SourceAdapter {
  readonly name = "copilot" as const;
  constructor(private readonly root: string = defaultStorageRoot()) {}

  async *discover(): AsyncIterable<DiscoveredSession> {
    if (!existsSync(this.root)) return;
    let workspaces;
    try { workspaces = readdirSync(this.root, { withFileTypes: true }); } catch { return; }
    for (const w of workspaces) {
      if (!w.isDirectory()) continue;
      const wsDir = join(this.root, w.name);
      const wsPath = readWorkspacePath(join(wsDir, "workspace.json"));

      // Within a single workspace, the SAME conversation can land in BOTH
      // `chatSessions/<id>.jsonl` (the rolling-window state log, schema fixed
      // in 0.7.0) and `GitHub.copilot-chat/transcripts/<id>.jsonl` (an
      // older event-stream format). Letting both through produces twin .md
      // files at different paths because the two formats extract different
      // first-user prompts and different startedAt timestamps — same
      // sessionId, two filenames, only one of them indexed (audit on Yue's
      // 2026-05-23 sync surfaced 83 orphan files repo-wide). Prefer
      // chatSessions/ as the authoritative source; transcripts/ runs only
      // as a fallback when chatSessions/ doesn't have the id.
      const chatDir = join(wsDir, "chatSessions");
      const chatSessionIds = new Set<string>();

      // Legacy format (pre-2026-04): workspaceStorage/<hash>/chatSessions/<id>.json
      // Newer append-log format (2026-03+): workspaceStorage/<hash>/chatSessions/<id>.jsonl
      if (existsSync(chatDir)) {
        let files: Dirent[] = [];
        try { files = readdirSync(chatDir, { withFileTypes: true }); } catch { files = []; }
        for (const f of files) {
          if (!f.isFile()) continue;
          const isJson = f.name.endsWith(".json");
          const isJsonl = f.name.endsWith(".jsonl");
          if (!isJson && !isJsonl) continue;
          const p = join(chatDir, f.name);
          const st = statSync(p);
          if (st.size === 0) continue;
          chatSessionIds.add(basename(f.name, isJsonl ? ".jsonl" : ".json"));
          const buf = readFileSync(p);
          const sha = createHash("sha256").update(buf).digest("hex");
          yield {
            sourcePath: p,
            sourceMtimeMs: st.mtimeMs,
            sourceSha256: sha,
            load: async () => isJsonl
              ? parseCopilotChatSessionsJsonl(p, buf.toString("utf8"), wsPath)
              : parseCopilotJson(p, buf.toString("utf8"), wsPath),
          };
        }
      }

      // New format (2026-04+): workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl
      const transcriptsDir = join(wsDir, "GitHub.copilot-chat", "transcripts");
      if (existsSync(transcriptsDir)) {
        let tfiles: Dirent[] = [];
        try { tfiles = readdirSync(transcriptsDir, { withFileTypes: true }); } catch { tfiles = []; }
        for (const f of tfiles) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const id = basename(f.name, ".jsonl");
          if (chatSessionIds.has(id)) continue; // chatSessions/ wins for same workspace+sessionId
          const p = join(transcriptsDir, f.name);
          const st = statSync(p);
          if (st.size === 0) continue;
          const buf = readFileSync(p);
          const sha = createHash("sha256").update(buf).digest("hex");
          yield {
            sourcePath: p,
            sourceMtimeMs: st.mtimeMs,
            sourceSha256: sha,
            load: async () => parseCopilotTranscript(p, buf.toString("utf8"), wsPath),
          };
        }
      }
    }
  }
}

function readWorkspacePath(workspaceJsonPath: string): string {
  if (!existsSync(workspaceJsonPath)) return "";
  try {
    const obj = JSON.parse(readFileSync(workspaceJsonPath, "utf8"));
    const u: string = obj.folder ?? obj.workspace ?? "";
    if (!u) return "";
    return u.startsWith("file://") ? decodeURIComponent(u.slice("file://".length)) : u;
  } catch { return ""; }
}

function parseCopilotJson(sourcePath: string, content: string, workspacePath: string): NormalizedSession {
  const obj = JSON.parse(content);
  const fileBase = basename(sourcePath, ".json");
  const sessionId = fileBase;
  const requests = Array.isArray(obj.requests) ? obj.requests : [];
  return buildSessionFromRequests(sourcePath, sessionId, requests, workspacePath);
}

/**
 * chatSessions/<id>.jsonl is a *live state log* with a rolling-window snapshot
 * pattern, NOT a complete conversation transcript. We discovered this on
 * 2026-05-22 after vibebook 0.5/0.6 was found to only capture the LAST turn
 * (~5–8% of the actual conversation) on multi-turn Copilot agent sessions.
 *
 * Event schema:
 *   - kind=0 (first line): initial state with v.requests (usually `[]`).
 *   - kind=1: replace top-level state path (e.g. inputState, responderUsername).
 *     Not relevant to conversation turns; we ignore.
 *   - kind=2 with k=["requests"]: VS Code's snapshot is a 1-element array
 *     containing only the *latest* turn. But the conceptual `requests` array
 *     grows monotonically across turns — subsequent patches reference
 *     k=["requests", N, ...] where N is the chronological turn index (0, 1, 2…).
 *     So we APPEND v[0] to our growing turns list rather than replacing.
 *   - kind=2 with k=["requests", N, "response"]: REPLACE the response array of
 *     turn N. Each patch is a full replacement (not a delta), so the last
 *     such patch for any given N wins.
 *   - kind=2 with k=["requests", N]: replace turn N entirely.
 *   - kind=2 with k=["requests", N, ...deep path]: deep-set into turn N.
 */
function parseCopilotChatSessionsJsonl(sourcePath: string, content: string, workspacePath: string): NormalizedSession {
  const fileBase = basename(sourcePath, ".jsonl");
  let sessionId = fileBase;
  const turns: any[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try { obj = JSON.parse(s); } catch { continue; }

    if (obj?.kind === 0 && obj?.v) {
      if (typeof obj.v.sessionId === "string" && obj.v.sessionId) sessionId = obj.v.sessionId;
      if (Array.isArray(obj.v.requests)) {
        // Initial state — seed turns from whatever was already in v.requests
        for (const r of obj.v.requests) turns.push(r);
      }
      continue;
    }

    if (obj?.kind !== 2 || !Array.isArray(obj.k) || obj.k[0] !== "requests") continue;

    if (obj.k.length === 1 && Array.isArray(obj.v)) {
      // Snapshot event. v is a rolling window (typically a single element).
      // Append each element to grow our chronological turn list.
      for (const r of obj.v) turns.push(r);
    } else if (obj.k.length >= 2 && typeof obj.k[1] === "number") {
      const idx = obj.k[1] as number;
      // Grow sparsely if the patch references a turn we haven't seen yet
      // (defensive — in well-formed logs the snapshot precedes the patch).
      while (turns.length <= idx) turns.push({});
      if (obj.k.length === 2) {
        turns[idx] = obj.v;
      } else {
        let cur: any = turns[idx];
        if (cur === undefined || cur === null) { cur = {}; turns[idx] = cur; }
        for (let i = 2; i < obj.k.length - 1; i++) {
          const seg = obj.k[i];
          if (cur[seg] === undefined) cur[seg] = typeof obj.k[i + 1] === "number" ? [] : {};
          cur = cur[seg];
        }
        cur[obj.k[obj.k.length - 1]] = obj.v;
      }
    }
  }
  return buildSessionFromRequests(sourcePath, sessionId, turns, workspacePath);
}

function buildSessionFromRequests(
  sourcePath: string,
  sessionId: string,
  requests: any[],
  workspacePath: string,
): NormalizedSession {
  const messages: SessionMessage[] = [];
  let startedAt = "";
  let endedAt = "";

  for (const r of requests) {
    if (!r) continue;
    const ts = typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : undefined;
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }
    const userTextRaw = r?.message?.text;
    if (typeof userTextRaw === "string" && userTextRaw) {
      const userText = sanitizeMessageText(userTextRaw);
      if (userText) messages.push({ role: "user", text: userText, timestamp: ts, raw: r.message });
    }
    const respParts = Array.isArray(r.response) ? r.response : [];
    const { text: rawText, reasoning: rawReasoning, contentBlocks } = extractCopilotResponseParts(respParts);
    const text = sanitizeMessageText(rawText);
    const reasoning = sanitizeMessageText(rawReasoning);
    if (text || reasoning || contentBlocks.length > 0) {
      const msg: SessionMessage = { role: "assistant", text, timestamp: ts, raw: respParts };
      if (reasoning) msg.reasoning = reasoning;
      if (contentBlocks.length > 0) msg.contentBlocks = contentBlocks;
      messages.push(msg);
    }
  }

  const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
  const { slug, display } = deriveSlug(firstUser);
  const shortId = sessionId.slice(0, 8);

  return {
    tool: "copilot",
    sessionId,
    shortId,
    project: projectSlugFromPath(workspacePath),
    projectRaw: workspacePath,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || new Date(0).toISOString(),
    nameSlug: slug,
    displayName: display,
    messages,
    sourcePath,
  };
}

/**
 * Pull text + reasoning + tool calls out of a Copilot response parts array.
 *
 * Response part kinds observed (chatSessions format):
 *   - markdownContent → visible assistant text (.content.value)
 *   - thinking        → reasoning (.value)
 *   - toolInvocationSerialized → tool call (.toolId + .pastTenseMessage / .invocationMessage)
 *   - textEditGroup, inlineReference, mcpServersStarting, progressTaskSerialized → UI noise, drop
 *   - null / no-kind  → drop
 *
 * Tool *results* are NOT captured by VS Code in chatSessions — only the
 * invocation marker. So tool blocks carry a placeholder result indicating
 * the result is unavailable from the source.
 */
function extractCopilotResponseParts(parts: any[]): {
  text: string;
  reasoning: string;
  contentBlocks: ContentBlock[];
} {
  const texts: string[] = [];
  const reasonings: string[] = [];
  const blocks: ContentBlock[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const k = p.kind;
    if (k === "markdownContent") {
      const v = typeof p?.content?.value === "string" ? p.content.value : "";
      if (v) { texts.push(v); blocks.push({ type: "text", text: v }); }
    } else if (k === "thinking") {
      const v = typeof p?.value === "string" ? p.value : "";
      if (v) { reasonings.push(v); blocks.push({ type: "thinking", thinking: v }); }
    } else if (k === "toolInvocationSerialized") {
      const toolId = typeof p?.toolId === "string" ? p.toolId : "tool";
      const past = p?.pastTenseMessage?.value;
      const cur = p?.invocationMessage?.value;
      const label = (typeof past === "string" && past) || (typeof cur === "string" && cur) || "";
      const input = p?.toolSpecificData ?? {};
      const block: ContentBlock = { type: "tool_use", name: toolId, input };
      if (typeof p?.toolCallId === "string") block.id = p.toolCallId;
      blocks.push(block);
      if (label) blocks.push({ type: "tool_result", content: label });
    }
    // textEditGroup / inlineReference / mcpServersStarting / progressTaskSerialized
    // are UI / streaming-state noise and intentionally dropped.
  }
  return {
    text: texts.join("\n"),
    reasoning: reasonings.join("\n"),
    contentBlocks: blocks,
  };
}

function parseCopilotTranscript(sourcePath: string, content: string, workspacePath: string): NormalizedSession {
  const fileBase = basename(sourcePath, ".jsonl");
  let sessionId = fileBase;
  const messages: SessionMessage[] = [];
  let startedAt = "";
  let endedAt = "";

  const lines = content.split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try { obj = JSON.parse(s); } catch { continue; }
    const t = obj?.type;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }

    if (t === "session.start") {
      const sid = obj?.data?.sessionId;
      if (typeof sid === "string" && sid) sessionId = sid;
      continue;
    }
    if (t === "user.message") {
      const raw = typeof obj?.data?.content === "string" ? obj.data.content : "";
      const text = sanitizeMessageText(raw);
      if (text) messages.push({ role: "user", text, timestamp: ts, raw: obj });
      continue;
    }
    if (t === "assistant.message") {
      const rawText = typeof obj?.data?.content === "string" ? obj.data.content : "";
      const rawReasoning = typeof obj?.data?.reasoningText === "string" ? obj.data.reasoningText : "";
      const text = sanitizeMessageText(rawText);
      const reasoning = sanitizeMessageText(rawReasoning);
      // tool requests are intentionally NOT included — vibebook summarizes
      // intent + outcome, not tool traces. Drop the message only when both
      // text AND reasoning are empty.
      if (text || reasoning) {
        const msg: SessionMessage = { role: "assistant", text, timestamp: ts, raw: obj };
        if (reasoning) msg.reasoning = reasoning;
        messages.push(msg);
      }
      continue;
    }
    if (t === "tool.execution_start" || t === "tool.execution_complete") {
      // Drop tool execution events entirely — same rationale as above.
      continue;
    }
  }

  const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
  const { slug, display } = deriveSlug(firstUser);
  const shortId = sessionId.slice(0, 8);

  return {
    tool: "copilot",
    sessionId,
    shortId,
    project: projectSlugFromPath(workspacePath),
    projectRaw: workspacePath,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || new Date(0).toISOString(),
    nameSlug: slug,
    displayName: display,
    messages,
    sourcePath,
  };
}
