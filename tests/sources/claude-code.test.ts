import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/sources/claude-code.js";
import { fileURLToPath } from "node:url";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

describe("ClaudeCodeAdapter", () => {
  it("parses a JSONL fixture into NormalizedSession", async () => {
    const adapter = new ClaudeCodeAdapter(fixturesDir);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found.length).toBe(1);
    const s = await found[0].load();
    expect(s.tool).toBe("claude");
    expect(s.sessionId).toBe("abc12345-cbf6-41f0-ab88-5cb425caba57");
    expect(s.shortId).toBe("abc12345");
    expect(s.project).toBe("edge-memvc");
    expect(s.nameSlug).toBe("Fix-the-auth-bug-in-login-flow");
    expect(s.displayName).toBe("Fix the auth bug in login flow");
    expect(s.messages.length).toBe(3);
    expect(s.messages[0].role).toBe("user");
    expect(s.messages[1].role).toBe("assistant");
    expect(s.startedAt).toBe("2026-04-13T03:36:53.475Z");
    expect(s.endedAt).toBe("2026-04-13T03:40:00.000Z");
  });
});

describe("ClaudeCodeAdapter — pollution filter", () => {
  let claudeRoot: string;
  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), "memvc-claude-test-"));
  });

  it("skips top-level project dirs that look like memvc scratch", async () => {
    // Real-looking project dir
    const realProj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(realProj, { recursive: true });
    writeFileSync(join(realProj, "session-1.jsonl"), '{"sessionId":"s1","cwd":"/Users/yueliu/edge/memvc"}\n');

    // Polluted dirs — different shapes
    const polluted1 = join(claudeRoot, "-private-var-folders-zm-x-T-memvc-claude-Abc");
    mkdirSync(polluted1, { recursive: true });
    writeFileSync(join(polluted1, "junk.jsonl"), '{"sessionId":"junk","cwd":"/private/var/folders/x/T/memvc-claude-Abc"}\n');

    const polluted2 = join(claudeRoot, "-var-folders-y-T-memvc-claude-Def");
    mkdirSync(polluted2, { recursive: true });
    writeFileSync(join(polluted2, "junk2.jsonl"), '{"sessionId":"junk2","cwd":"/var/folders/y/T/memvc-claude-Def"}\n');

    const polluted3 = join(claudeRoot, "-tmp-memvc-claude-Ghi");
    mkdirSync(polluted3, { recursive: true });
    writeFileSync(join(polluted3, "junk3.jsonl"), '{"sessionId":"junk3","cwd":"/tmp/memvc-claude-Ghi"}\n');

    // Generic memvc-claude name without the standard tmpdir prefix
    const polluted4 = join(claudeRoot, "-some-random-path-memvc-claude-Jkl");
    mkdirSync(polluted4, { recursive: true });
    writeFileSync(join(polluted4, "junk4.jsonl"), '{"sessionId":"junk4","cwd":"/x/memvc-claude-Jkl"}\n');

    const adapter = new ClaudeCodeAdapter(claudeRoot);
    const sessionIds: string[] = [];
    for await (const ds of adapter.discover()) {
      try {
        const s = await ds.load();
        sessionIds.push(s.sessionId);
      } catch {
        // Some toy JSONLs may not parse cleanly; ignore for this test
      }
    }
    expect(sessionIds).toContain("s1");
    expect(sessionIds).not.toContain("junk");
    expect(sessionIds).not.toContain("junk2");
    expect(sessionIds).not.toContain("junk3");
    expect(sessionIds).not.toContain("junk4");
  });
});
