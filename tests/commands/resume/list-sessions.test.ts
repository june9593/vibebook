import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listSessionsCmd", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "vb-ls-"));
    vi.stubEnv("HOME", fakeHome);
    vi.resetModules();
    // Plant a config that points at a spool inside fakeHome
    const repoPath = join(fakeHome, ".vibebook/session-repo");
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    mkdirSync(join(fakeHome, ".vibebook"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".vibebook/config.json"),
      JSON.stringify({
        repoPath,
        repoUrl: "git@example.com:me/repo.git",
        encrypt: false,
        salt: "",
        deviceBranch: "test-device",
        runner: "claude-cli",
        enableAggregateCI: false,
        includeReasoning: true,
        threadingConcurrency: 4,
        threadingMaxAttempts: 3,
        digestEnabled: true,
      }),
    );
    // Plant 3 sessions in index
    writeFileSync(
      join(repoPath, ".vibebook/index.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "claude:abc123": {
            sessionId: "abc123", shortId: "abc123", tool: "claude",
            project: "my-app", projectRaw: "/Users/test/code/my-app",
            startedAt: "2026-05-10T00:00:00Z", endedAt: "2026-05-10T01:00:00Z",
            nameSlug: "fix-thing", displayName: "Fix the thing",
            relativePath: "raw_sessions/claude/my-app/2026-05-10/fix-thing__abc123.raw.json",
            sourcePath: "/Users/test/.claude/projects/-Users-test-code-my-app/abc123.jsonl",
            sourceMtimeMs: 1, sourceSha256: "x",
          },
          "claude:def456": {
            sessionId: "def456", shortId: "def456", tool: "claude",
            project: "other-app", projectRaw: "/Users/test/code/other-app",
            startedAt: "2026-05-12T00:00:00Z", endedAt: "2026-05-12T00:30:00Z",
            nameSlug: "explore", displayName: "Explore",
            relativePath: "raw_sessions/claude/other-app/2026-05-12/explore__def456.raw.json",
            sourcePath: "/Users/test/.claude/projects/-Users-test-code-other-app/def456.jsonl",
            sourceMtimeMs: 2, sourceSha256: "y",
          },
          "copilot:ghi789": {
            sessionId: "ghi789", shortId: "ghi789", tool: "copilot",
            project: "my-app", projectRaw: "/Users/test/code/my-app",
            startedAt: "2025-12-01T00:00:00Z", endedAt: "2025-12-01T00:30:00Z",
            nameSlug: "old-session", displayName: "Old session",
            relativePath: "raw_sessions/copilot/my-app/2025-12-01/old-session__ghi789.raw.json",
            sourcePath: "/Users/test/.vscode-copilot-storage/...",
            sourceMtimeMs: 0, sourceSha256: "z",
          },
        },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("with no filters, returns all sessions sorted by endedAt desc", async () => {
    const { listSessionsCmd } = await import("../../../src/commands/resume/list-sessions.js");
    const result = await listSessionsCmd({});
    expect(result.length).toBe(3);
    expect(result[0].sessionId).toBe("def456"); // newest
    expect(result[1].sessionId).toBe("abc123");
    expect(result[2].sessionId).toBe("ghi789"); // oldest
  });

  it("filters by --project slug", async () => {
    const { listSessionsCmd } = await import("../../../src/commands/resume/list-sessions.js");
    const result = await listSessionsCmd({ project: "my-app" });
    expect(result.length).toBe(2);
    expect(result.every((r) => r.project === "my-app")).toBe(true);
  });

  it("filters by --since (relative window)", async () => {
    // Pin time so test is deterministic — say "now" is 2026-05-13
    vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
    try {
      const { listSessionsCmd } = await import("../../../src/commands/resume/list-sessions.js");
      const result = await listSessionsCmd({ since: "7d" });
      // Only sessions with endedAt within last 7 days
      expect(result.length).toBe(2);
      expect(result.map((r) => r.sessionId).sort()).toEqual(["abc123", "def456"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty array when nothing matches", async () => {
    const { listSessionsCmd } = await import("../../../src/commands/resume/list-sessions.js");
    const result = await listSessionsCmd({ project: "nonexistent" });
    expect(result).toEqual([]);
  });
});
