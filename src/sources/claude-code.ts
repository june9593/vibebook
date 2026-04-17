import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceAdapter, DiscoveredSession } from "./base.js";
import type { NormalizedSession, SessionMessage } from "../types.js";
import { deriveSlug, projectSlugFromPath } from "../slug.js";

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
        if (e.isDirectory()) stack.push(p);
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
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }
      const text = extractText(obj.message);
      if (text) {
        messages.push({
          role: obj.type === "user" ? "user" : "assistant",
          text,
          timestamp: ts,
          raw: obj,
        });
      }
    }
  }

  const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
  const { slug, display } = deriveSlug(firstUser);
  const shortId = (sessionId || "unknown").slice(0, 8);

  return {
    tool: "claude",
    sessionId: sessionId || "unknown",
    shortId,
    project: projectSlugFromPath(cwd),
    projectRaw: cwd,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || new Date(0).toISOString(),
    nameSlug: slug,
    displayName: display,
    messages,
    sourcePath,
  };
}

function extractText(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text).join("\n");
  }
  return "";
}
