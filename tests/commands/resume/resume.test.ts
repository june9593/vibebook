import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resumeCmd", () => {
  let fakeHome: string;
  let repoPath: string;

  beforeEach(() => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), "vb-resume-"));
    vi.stubEnv("HOME", fakeHome);
    repoPath = join(fakeHome, ".vibebook/session-repo");
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    mkdirSync(join(fakeHome, ".vibebook"), { recursive: true });
    // Plant config with a pathMap for cross-device translation
    writeFileSync(
      join(fakeHome, ".vibebook/config.json"),
      JSON.stringify({
        repoPath,
        repoUrl: "", encrypt: false, salt: "",
        deviceBranch: "test-device",
        runner: "claude-cli",
        enableAggregateCI: false,
        includeReasoning: true,
        threadingConcurrency: 4,
        threadingMaxAttempts: 3,
        digestEnabled: true,
        pathMap: { "/Users/yueA": fakeHome },
      }),
    );
    // Plant a session in spool — both .raw.json and .jsonl
    const dateDir = "raw_sessions/claude/my-app/2026-05-10";
    const base = "fix__abc123";
    mkdirSync(join(repoPath, dateDir), { recursive: true });
    const jsonlContent =
      JSON.stringify({ cwd: "/Users/yueA/code/my-app", type: "user", message: { content: "hi" } }) + "\n" +
      JSON.stringify({ cwd: "/Users/yueA/code/my-app", type: "assistant", message: { content: "hey" } }) + "\n";
    writeFileSync(join(repoPath, dateDir, `${base}.jsonl`), jsonlContent);
    writeFileSync(join(repoPath, dateDir, `${base}.raw.json`), "{}\n"); // placeholder
    // Plant index entry pointing at the .raw.json (per writer convention)
    writeFileSync(
      join(repoPath, ".vibebook/index.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "claude:abc123": {
            sessionId: "abc123", shortId: "abc123", tool: "claude",
            project: "my-app", projectRaw: "/Users/yueA/code/my-app",
            startedAt: "2026-05-10T00:00:00Z", endedAt: "2026-05-10T01:00:00Z",
            nameSlug: "fix", displayName: "Fix",
            relativePath: `${dateDir}/${base}.raw.json`,
            sourcePath: "/Users/yueA/.claude/projects/-Users-yueA-code-my-app/abc123.jsonl",
            sourceMtimeMs: 1, sourceSha256: "x",
          },
        },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("copies jsonl to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl with path rewrite applied", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const result = await resumeCmd({ sessionId: "abc123" });
    // localCwd = pathMap-translated projectRaw
    const localCwd = `${fakeHome}/code/my-app`;
    const encodedCwd = localCwd.replace(/\//g, "-");
    const dest = join(fakeHome, ".claude/projects", encodedCwd, "abc123.jsonl");
    expect(existsSync(dest)).toBe(true);
    const written = readFileSync(dest, "utf8");
    expect(written).toContain(`"cwd":"${fakeHome}/code/my-app"`);
    expect(written).not.toContain("yueA");
    expect(result.localCwd).toBe(localCwd);
    expect(result.dest).toBe(dest);
  });

  it("throws when sessionId not in index", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    await expect(resumeCmd({ sessionId: "nonexistent" })).rejects.toThrow(/not found/i);
  });

  it("emits a resume-hint string in result.hint", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const result = await resumeCmd({ sessionId: "abc123" });
    expect(result.hint).toContain("cd ");
    expect(result.hint).toContain(`${fakeHome}/code/my-app`);
    expect(result.hint).toContain("claude --resume abc123");
  });
});
