import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VSCodeCopilotAdapter } from "../../src/sources/vscode-copilot.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

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
