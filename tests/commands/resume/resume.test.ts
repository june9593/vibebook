import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resumeCmd (0.6 — context-as-prompt)", () => {
  let fakeHome: string;
  let repoPath: string;

  beforeEach(() => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), "vb-resume06-"));
    vi.stubEnv("HOME", fakeHome);
    repoPath = join(fakeHome, ".vibebook/session-repo");
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    mkdirSync(join(fakeHome, ".vibebook"), { recursive: true });
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
        bookLocale: "en",
        pathMap: { "/Users/yueA": fakeHome },
      }),
    );
    // Plant a session md in spool
    const dateDir = "raw_sessions/claude/my-app/2026-05-10";
    const base = "fix__abc12345";
    mkdirSync(join(repoPath, dateDir), { recursive: true });
    writeFileSync(join(repoPath, dateDir, `${base}.md`), "---\nsessionId: abc12345\n---\n\n## User\n\nhi\n");
    writeFileSync(
      join(repoPath, ".vibebook/index.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "claude:abc12345-cbf6-41f0-ab88-5cb425caba57": {
            sessionId: "abc12345-cbf6-41f0-ab88-5cb425caba57",
            shortId: "abc12345",
            tool: "claude",
            project: "my-app",
            projectRaw: "/Users/yueA/code/my-app",
            startedAt: "2026-05-10T00:00:00Z",
            endedAt: "2026-05-10T01:00:00Z",
            nameSlug: "fix",
            displayName: "Fix the thing",
            relativePath: `${dateDir}/${base}.md`,
            sourcePath: "/x.jsonl",
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

  it("matches by shortId and builds invocation in --print mode", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const cwd = `${fakeHome}/code/my-app`;
    mkdirSync(cwd, { recursive: true });
    const r = await resumeCmd({ idOrPrefix: "abc12345", cwd, print: true });
    expect(r.matchedSessionId).toBe("abc12345-cbf6-41f0-ab88-5cb425caba57");
    expect(r.expectedCwd).toBe(cwd);
    expect(r.invocation[0]).toBe("claude");
    expect(r.invocation[1]).toContain("I had a coding session on another machine");
    expect(r.invocation[1]).toContain("## User");
    expect(r.spawned).toBe(false);
  });

  it("matches by short prefix (< 8 chars)", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const cwd = `${fakeHome}/code/my-app`;
    mkdirSync(cwd, { recursive: true });
    const r = await resumeCmd({ idOrPrefix: "abc12", cwd, print: true });
    expect(r.matchedSessionId).toBe("abc12345-cbf6-41f0-ab88-5cb425caba57");
  });

  it("throws when no match", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    await expect(resumeCmd({ idOrPrefix: "deadbeef", print: true })).rejects.toThrow(/No session matches/);
  });

  it("throws when cwd doesn't match expected (after pathMap)", async () => {
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    await expect(
      resumeCmd({ idOrPrefix: "abc12345", cwd: "/wrong/place", print: true }),
    ).rejects.toThrow(/cd there first/);
  });

  it("throws when context md missing", async () => {
    rmSync(join(repoPath, "raw_sessions/claude/my-app/2026-05-10/fix__abc12345.md"));
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const cwd = `${fakeHome}/code/my-app`;
    mkdirSync(cwd, { recursive: true });
    await expect(resumeCmd({ idOrPrefix: "abc12345", cwd, print: true })).rejects.toThrow(/Context md missing/);
  });

  it("falls back from .raw.json relativePath to .md sibling (0.5.x legacy entry)", async () => {
    // Mutate the index entry to point at a legacy .raw.json path
    const idxPath = join(repoPath, ".vibebook/index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    const key = Object.keys(idx.entries)[0]!;
    idx.entries[key].relativePath = "raw_sessions/claude/my-app/2026-05-10/fix__abc12345.raw.json";
    writeFileSync(idxPath, JSON.stringify(idx));
    // sibling .md is still present from beforeEach
    const { resumeCmd } = await import("../../../src/commands/resume/resume.js");
    const cwd = `${fakeHome}/code/my-app`;
    mkdirSync(cwd, { recursive: true });
    const r = await resumeCmd({ idOrPrefix: "abc12345", cwd, print: true });
    expect(r.mdPath).toMatch(/\.md$/);
  });
});
