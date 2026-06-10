import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter, parseCodexJsonl } from "../../src/sources/codex.js";

const fixturesDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "codex",
);

function loadTitleMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const indexPath = join(dir, "session_index.jsonl");
  const lines = readFileSync(indexPath, "utf8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s) as { id?: string; thread_name?: string };
      if (typeof obj.id === "string" && typeof obj.thread_name === "string") {
        map.set(obj.id, obj.thread_name);
      }
    } catch { /* skip */ }
  }
  return map;
}

describe("CodexAdapter — discover", () => {
  it("discovers rollout-*.jsonl files under sessions/ and archived_sessions/", async () => {
    const adapter = new CodexAdapter(fixturesDir);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    // Should find rollout-sample, rollout-exec, rollout-noindex, rollout-cmdnoise
    expect(found.length).toBe(4);
    const paths = found.map((d) => d.sourcePath);
    expect(paths.some((p) => p.includes("rollout-sample"))).toBe(true);
    expect(paths.some((p) => p.includes("rollout-exec"))).toBe(true);
    expect(paths.some((p) => p.includes("rollout-noindex"))).toBe(true);
    expect(paths.some((p) => p.includes("rollout-cmdnoise"))).toBe(true);
  });
});

describe("CodexAdapter — parseCodexJsonl: rollout-sample", () => {
  const titleMap = loadTitleMap(fixturesDir);
  const samplePath = join(fixturesDir, "sessions", "2026", "05", "10", "rollout-sample.jsonl");
  const content = readFileSync(samplePath, "utf8");
  const session = parseCodexJsonl(samplePath, content, titleMap);

  it("tool is codex", () => {
    expect(session.tool).toBe("codex");
  });

  it("sessionId matches session_meta payload.id", () => {
    expect(session.sessionId).toBe("sess-abc12345-cbf6-41f0-ab88-5cb425caba57");
  });

  it("shortId is first 8 chars of sessionId", () => {
    expect(session.shortId).toBe("sess-abc");
  });

  it("project derived from cwd /Users/yueliu/edge/edge-src", () => {
    expect(session.project).toBe("edge-edge-src");
  });

  it("displayName comes from session_index thread_name", () => {
    expect(session.displayName).toBe("Add retry logic to edge sync");
  });

  it("nameSlug is slugified thread_name", () => {
    expect(session.nameSlug).toBe("Add-retry-logic-to-edge-sync");
  });

  it("developer message is skipped", () => {
    // No message should contain the permissions text
    expect(
      session.messages.some((m) =>
        m.text?.includes("permissions instructions") ||
        m.contentBlocks?.some((b) => b.type === "text" && (b as any).text?.includes("permissions")),
      ),
    ).toBe(false);
  });

  it("event_msg lines are ignored", () => {
    // event_msg lines don't produce messages; count won't include them
    // We have: 2 user text messages + 2 assistant text messages + 1 tool_use + 1 tool_result = 6
    expect(session.messages.length).toBe(6);
  });

  it("AGENTS.md block is stripped from first user turn, real text survives", () => {
    const firstUser = session.messages.find((m) => m.role === "user" && m.text);
    expect(firstUser).toBeDefined();
    expect(firstUser!.text).not.toMatch(/^# AGENTS\.md/);
    expect(firstUser!.text).toContain("add retry logic");
  });

  it("<command-name> noise is sanitized from second user turn", () => {
    const userMessages = session.messages.filter((m) => m.role === "user" && m.text);
    // Second user text message (after tool_result which also has role=user)
    const textUsers = userMessages.filter((m) => m.text.length > 0);
    expect(textUsers.length).toBeGreaterThanOrEqual(2);
    const secondUserText = textUsers[1].text;
    expect(secondUserText).not.toContain("<command-name>");
    expect(secondUserText).toContain("model");
  });

  it("has tool_use contentBlock for function_call", () => {
    const toolUseMsg = session.messages.find((m) =>
      m.contentBlocks?.some((b) => b.type === "tool_use"),
    );
    expect(toolUseMsg).toBeDefined();
    const block = toolUseMsg!.contentBlocks!.find((b) => b.type === "tool_use")!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.name).toBe("read_file");
      expect(block.id).toBe("call-read-001");
      expect((block.input as any).path).toBe("src/sync.ts");
    }
  });

  it("has tool_result contentBlock for function_call_output", () => {
    const toolResultMsg = session.messages.find((m) =>
      m.contentBlocks?.some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.role).toBe("user");
    const block = toolResultMsg!.contentBlocks!.find((b) => b.type === "tool_result")!;
    if (block.type === "tool_result") {
      expect(block.content).toContain("sync");
      expect(block.toolUseId).toBe("call-read-001");
    }
  });

  it("reasoning block is dropped (no message from it)", () => {
    // No message should carry reasoning type content; the reasoning line is silently dropped
    expect(
      session.messages.some((m) =>
        m.contentBlocks?.some((b) => b.type === "thinking"),
      ),
    ).toBe(false);
    // Also total count should not include a reasoning-derived message
    expect(session.messages.length).toBe(6);
  });

  it("startedAt and endedAt are set correctly", () => {
    expect(session.startedAt).toBe("2026-05-10T14:00:00.000Z");
    // endedAt = last line timestamp (the final event_msg)
    expect(session.endedAt).toBe("2026-05-10T14:30:00.000Z");
  });

  it("sourcePath is set", () => {
    expect(session.sourcePath).toBe(samplePath);
  });
});

describe("CodexAdapter — parseCodexJsonl: rollout-exec (codex_exec skip)", () => {
  const titleMap = new Map<string, string>();
  const execPath = join(fixturesDir, "sessions", "2026", "05", "10", "rollout-exec.jsonl");
  const content = readFileSync(execPath, "utf8");
  const session = parseCodexJsonl(execPath, content, titleMap);

  it("returns 0 messages for codex_exec originator", () => {
    expect(session.messages.length).toBe(0);
  });

  it("tool is still codex", () => {
    expect(session.tool).toBe("codex");
  });
});

describe("CodexAdapter — parseCodexJsonl: rollout-noindex (no session_index entry)", () => {
  // Only include the sample entry in titleMap, NOT the noindex session
  const titleMap = loadTitleMap(fixturesDir);
  const noindexPath = join(fixturesDir, "sessions", "2026", "05", "10", "rollout-noindex.jsonl");
  const content = readFileSync(noindexPath, "utf8");
  const session = parseCodexJsonl(noindexPath, content, titleMap);

  it("displayName falls back to first user message text", () => {
    // session id is 'sess-noindex-bbbb-cccc-dddd-eeeeeeeeeeee' — not in index
    expect(session.displayName).toContain("Refactor the configuration loader");
  });

  it("nameSlug is derived from first user message", () => {
    expect(session.nameSlug).toMatch(/^Refactor/);
  });

  it("has expected messages", () => {
    expect(session.messages.length).toBe(2); // 1 user + 1 assistant
  });
});

describe("CodexAdapter — parseCodexJsonl: rollout-cmdnoise (command-noise thread_name + first user msg)", () => {
  const titleMap = loadTitleMap(fixturesDir);
  const cmdnoisePath = join(fixturesDir, "sessions", "2026", "05", "10", "rollout-cmdnoise.jsonl");
  const content = readFileSync(cmdnoisePath, "utf8");
  const session = parseCodexJsonl(cmdnoisePath, content, titleMap);

  it("ignores command-noise thread_name from session_index", () => {
    // The index entry for this session has thread_name = "<command-message>foo</command-message>"
    // — it must NOT appear in displayName or nameSlug.
    expect(session.displayName).not.toMatch(/^<(command|local-command)/);
    expect(session.nameSlug).not.toMatch(/^command-message|^local-command/);
  });

  it("ignores first user message that is pure command noise", () => {
    // First user message is "<command-name>/clear</command-name>" — must not be used as title.
    expect(session.displayName).not.toContain("/clear");
    expect(session.nameSlug).not.toContain("clear");
  });

  it("derives displayName from the second (real) user message", () => {
    // Second user message is "我们已经把sprint 2给做完了，接下来我们来规划sprint 3"
    expect(session.displayName).toContain("sprint");
    expect(session.nameSlug).toMatch(/sprint/);
  });

  it("does not emit a raw command-wrapper string as displayName", () => {
    // Regression guard: displayName must not start with a < tag
    expect(session.displayName.trimStart()).not.toMatch(/^</);
  });
});
