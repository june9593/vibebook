import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync, Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage } from "../types.js";
import { deriveSlug, projectSlugFromPath } from "../slug.js";

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
      const chatDir = join(wsDir, "chatSessions");
      if (existsSync(chatDir)) {
        let files: Dirent[] = [];
        try { files = readdirSync(chatDir, { withFileTypes: true }); } catch { files = []; }
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".json")) continue;
          const p = join(chatDir, f.name);
          const st = statSync(p);
          if (st.size === 0) continue;
          const buf = readFileSync(p);
          const sha = createHash("sha256").update(buf).digest("hex");
          yield {
            sourcePath: p,
            sourceMtimeMs: st.mtimeMs,
            sourceSha256: sha,
            load: async () => parseCopilotJson(p, buf.toString("utf8"), wsPath),
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
  const messages: SessionMessage[] = [];
  let startedAt = "";
  let endedAt = "";

  const requests = Array.isArray(obj.requests) ? obj.requests : [];
  for (const r of requests) {
    const ts = typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : undefined;
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }
    const userText = r?.message?.text;
    if (typeof userText === "string" && userText) {
      messages.push({ role: "user", text: userText, timestamp: ts, raw: r.message });
    }
    const respParts = Array.isArray(r.response) ? r.response : [];
    const assistantText = respParts
      .map((p: any) => {
        if (p?.kind === "markdownContent") return p?.content?.value ?? "";
        if (p?.kind === "textEditGroup") return "";
        if (typeof p?.value === "string") return p.value;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (assistantText) {
      messages.push({ role: "assistant", text: assistantText, timestamp: ts, raw: respParts });
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
      const text = typeof obj?.data?.content === "string" ? obj.data.content : "";
      if (text) messages.push({ role: "user", text, timestamp: ts, raw: obj });
      continue;
    }
    if (t === "assistant.message") {
      const text = typeof obj?.data?.content === "string" ? obj.data.content : "";
      const reasoning = typeof obj?.data?.reasoningText === "string" ? obj.data.reasoningText : "";
      const toolReqs = Array.isArray(obj?.data?.toolRequests) ? obj.data.toolRequests : [];
      const toolSummary = toolReqs
        .map((r: any) => `[tool:${r?.name ?? "?"} ${typeof r?.arguments === "string" ? r.arguments : JSON.stringify(r?.arguments ?? "")}]`)
        .join("\n");
      const combined = [reasoning, text, toolSummary].filter(Boolean).join("\n");
      if (combined) messages.push({ role: "assistant", text: combined, timestamp: ts, raw: obj });
      continue;
    }
    if (t === "tool.execution_start" || t === "tool.execution_complete") {
      messages.push({ role: "tool", text: JSON.stringify(obj?.data ?? {}), timestamp: ts, raw: obj });
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
