import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VSCodeCopilotAdapter } from "../../src/sources/vscode-copilot.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "copilot");

describe("VSCodeCopilotAdapter", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-"));
    const ws = join(storage, "hashA");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    cpSync(
      join(fixturesDir, "vscode-copilot-session.json"),
      join(ws, "chatSessions", "sess-aaaa1111.json"),
    );
  });

  it("parses Copilot chat JSON into NormalizedSession", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found.length).toBe(1);
    const s = await found[0].load();
    expect(s.tool).toBe("copilot");
    expect(s.sessionId).toBe("sess-aaaa1111");
    expect(s.shortId).toBe("sess-aaa");
    expect(s.project).toBe("edge-memvc");
    expect(s.nameSlug).toBe("Add-MCP-server-and-list-active-PRs");
    expect(s.messages.length).toBe(3);  // "Thanks" (6 chars) sanitized away
    expect(s.messages[0].role).toBe("user");
    expect(s.messages[1].role).toBe("assistant");
    expect(s.messages[2].role).toBe("assistant");  // "You're welcome." survives
  });
});

describe("VSCodeCopilotAdapter — chatSessions jsonl (rolling-window state log)", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-jsonl-"));
    const ws = join(storage, "hashB");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    cpSync(
      join(fixturesDir, "vscode-copilot-chatsessions.jsonl"),
      join(ws, "chatSessions", "sess-bbbb2222.jsonl"),
    );
  });

  it("reconstructs ALL turns from chronological snapshot events (not just the last)", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found.length).toBe(1);
    const s = await found[0].load();
    expect(s.tool).toBe("copilot");
    expect(s.sessionId).toBe("sess-bbbb2222");
    // 3 user turns + 3 assistant turns = 6 messages
    const userMsgs = s.messages.filter((m) => m.role === "user");
    const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBe(3);
    expect(assistantMsgs.length).toBe(3);
    expect(userMsgs[0].text).toBe("First user turn");
    expect(userMsgs[1].text).toBe("Second user turn");
    expect(userMsgs[2].text).toBe("Third user turn asks a question");
  });

  it("extracts thinking + toolInvocationSerialized as contentBlocks", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    const s = await found[0].load();
    const turn2 = s.messages.filter((m) => m.role === "assistant")[1];
    expect(turn2.reasoning).toBe("thinking about turn two");
    expect(turn2.contentBlocks).toBeDefined();
    const kinds = turn2.contentBlocks!.map((b) => b.type);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    const toolUse = turn2.contentBlocks!.find((b) => b.type === "tool_use") as any;
    expect(toolUse.name).toBe("mcp_demo_search");
    expect(toolUse.id).toBe("call-1");
  });

  it("derives displayName from the first user turn (not the last)", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    const s = await found[0].load();
    // Bug before fix: displayName would have been derived from "Third user turn..." (last)
    expect(s.displayName.toLowerCase()).toContain("first");
  });
});

describe("VSCodeCopilotAdapter — dedupe chatSessions/ vs transcripts/ for same sessionId", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-dedupe-"));
    const ws = join(storage, "hashC");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    mkdirSync(join(ws, "GitHub.copilot-chat", "transcripts"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    // Both sources, SAME sessionId. The dedupe must yield only chatSessions/.
    cpSync(
      join(fixturesDir, "vscode-copilot-chatsessions.jsonl"),
      join(ws, "chatSessions", "shared-id-aaaa.jsonl"),
    );
    writeFileSync(
      join(ws, "GitHub.copilot-chat", "transcripts", "shared-id-aaaa.jsonl"),
      JSON.stringify({ type: "user.message", timestamp: "2026-05-22T10:00:00Z", data: { content: "transcript user msg should be ignored" } }) + "\n",
    );
  });

  it("yields only chatSessions/ when both sources have the same sessionId in one workspace", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found).toHaveLength(1);
    expect(found[0].sourcePath).toContain("chatSessions/");
    expect(found[0].sourcePath).not.toContain("transcripts/");
  });

  it("still yields transcripts/ for sessionIds that have NO chatSessions/ counterpart", async () => {
    // Add a transcript-only session
    const ws = join(storage, "hashC");
    writeFileSync(
      join(ws, "GitHub.copilot-chat", "transcripts", "transcript-only-bbbb.jsonl"),
      JSON.stringify({ type: "user.message", timestamp: "2026-05-22T10:00:00Z", data: { content: "this transcript-only session should survive the dedupe" } }) + "\n",
    );
    const adapter = new VSCodeCopilotAdapter(storage);
    const sourcePaths: string[] = [];
    for await (const d of adapter.discover()) sourcePaths.push(d.sourcePath);
    expect(sourcePaths).toHaveLength(2);
    expect(sourcePaths.some((p) => p.endsWith("chatSessions/shared-id-aaaa.jsonl"))).toBe(true);
    expect(sourcePaths.some((p) => p.endsWith("transcripts/transcript-only-bbbb.jsonl"))).toBe(true);
  });
});

