import { describe, it, expect } from "vitest";
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
