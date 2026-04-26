import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync, Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage } from "../types.js";
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

      // Legacy format (pre-2026-04): workspaceStorage/<hash>/chatSessions/<id>.json
      // Newer append-log format (2026-03+): workspaceStorage/<hash>/chatSessions/<id>.jsonl
      const chatDir = join(wsDir, "chatSessions");
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

function parseCopilotChatSessionsJsonl(sourcePath: string, content: string, workspacePath: string): NormalizedSession {
  const fileBase = basename(sourcePath, ".jsonl");
  let sessionId = fileBase;
  let requests: any[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj?.kind === 0 && obj?.v) {
      if (typeof obj.v.sessionId === "string" && obj.v.sessionId) sessionId = obj.v.sessionId;
      if (Array.isArray(obj.v.requests)) requests = obj.v.requests;
    } else if (obj?.kind === 2 && Array.isArray(obj.k) && obj.k[0] === "requests" && obj.k.length === 1 && Array.isArray(obj.v)) {
      // Full requests snapshot
      requests = obj.v;
    } else if (obj?.kind === 2 && Array.isArray(obj.k) && obj.k[0] === "requests" && obj.k.length >= 2 && typeof obj.k[1] === "number") {
      // Targeted append/update: k = ["requests", index, ...path]
      const idx = obj.k[1] as number;
      if (obj.k.length === 2) {
        requests[idx] = obj.v;
      } else {
        // Path into an existing request; best-effort deep set.
        let cur: any = requests[idx];
        if (cur === undefined) { cur = {}; requests[idx] = cur; }
        for (let i = 2; i < obj.k.length - 1; i++) {
          const seg = obj.k[i];
          if (cur[seg] === undefined) cur[seg] = typeof obj.k[i + 1] === "number" ? [] : {};
          cur = cur[seg];
        }
        cur[obj.k[obj.k.length - 1]] = obj.v;
      }
    }
  }
  return buildSessionFromRequests(sourcePath, sessionId, requests, workspacePath);
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
    const assistantTextRaw = respParts
      .map((p: any) => {
        if (p?.kind === "markdownContent") return p?.content?.value ?? "";
        if (p?.kind === "textEditGroup") return "";
        if (typeof p?.value === "string") return p.value;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (assistantTextRaw) {
      const assistantText = sanitizeMessageText(assistantTextRaw);
      if (assistantText) {
        messages.push({ role: "assistant", text: assistantText, timestamp: ts, raw: respParts });
      }
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
