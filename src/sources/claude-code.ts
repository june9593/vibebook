import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
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
  const fallbackId = basename(sourcePath, ".jsonl");
  const finalId = sessionId || fallbackId;
  const shortId = finalId.slice(0, 8);

  return {
    tool: "claude",
    sessionId: finalId,
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
