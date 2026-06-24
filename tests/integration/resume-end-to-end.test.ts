import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resume end-to-end (0.6)", () => {
  let fakeHome: string;
  let repoPath: string;

  beforeEach(() => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), "vb-e2e-"));
    vi.stubEnv("HOME", fakeHome);
    repoPath = join(fakeHome, ".vibebook/session-repo");
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    mkdirSync(join(fakeHome, ".vibebook"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".vibebook/config.json"),
      JSON.stringify({
        repoPath,
        repoUrl: "",
        deviceBranch: "dev", runner: "claude-cli",
        enableAggregateCI: false,
        includeReasoning: true,
        threadingConcurrency: 4, threadingMaxAttempts: 3,
        digestEnabled: true,
        bookLocale: "en",
      }),
    );
    // Plant a realistic md with frontmatter + content blocks
    const md = [
      "---",
      "sessionId: e2e12345-cbf6-41f0-ab88-5cb425caba57",
      "tool: claude",
      "project: my-app",
      "projectRaw: /Users/me/my-app",
      "startedAt: 2026-05-20T10:00:00Z",
      "endedAt: 2026-05-20T11:00:00Z",
      "displayName: E2E test session",
      "---",
      "",
      "## User _(10:00:00)_",
      "",
      "fix the bug",
      "",
      "## Assistant _(10:00:30)_",
      "",
      "Let me look.",
      "",
      "### 🔧 tool_use: Read",
      "",
      "```json",
      `{ "file_path": "/foo.ts" }`,
      "```",
      "",
      "### ✅ tool_result",
      "",
      "```",
      "(file content)",
      "```",
    ].join("\n");
    mkdirSync(join(repoPath, "raw_sessions/claude/my-app/2026-05-20"), { recursive: true });
    writeFileSync(
      join(repoPath, "raw_sessions/claude/my-app/2026-05-20/E2E__e2e12345.md"),
      md,
    );
    writeFileSync(
      join(repoPath, ".vibebook/index.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "claude:e2e12345-cbf6-41f0-ab88-5cb425caba57": {
            sessionId: "e2e12345-cbf6-41f0-ab88-5cb425caba57",
            shortId: "e2e12345",
            tool: "claude",
            project: "my-app",
            projectRaw: "/Users/me/my-app",
            startedAt: "2026-05-20T10:00:00Z",
            endedAt: "2026-05-20T11:00:00Z",
            nameSlug: "E2E",
            displayName: "E2E test session",
            relativePath: "raw_sessions/claude/my-app/2026-05-20/E2E__e2e12345.md",
            sourcePath: "/x.jsonl",
            sourceMtimeMs: 1, sourceSha256: "x",
          },
        },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("--print mode produces an invocation that contains framing + frontmatter + body", async () => {
    const { resumeCmd } = await import("../../src/commands/resume/resume.js");
    const cwd = "/Users/me/my-app";
    // We override cwd via opts because we can't actually mkdir /Users/me on
    // arbitrary CI machines. resumeCmd doesn't actually chdir; it just
    // compares against entry.projectRaw for the validation gate.
    const r = await resumeCmd({ idOrPrefix: "e2e12345", cwd, print: true });

    expect(r.invocation[0]).toBe("claude");
    const prompt = r.invocation[1]!;
    // Framing
    expect(prompt).toContain("I had a coding session on another machine");
    expect(prompt).toContain("E2E test session");
    expect(prompt).toContain("What's our next step?");
    // Embedded md (frontmatter + body)
    expect(prompt).toContain("sessionId: e2e12345-cbf6-41f0-ab88-5cb425caba57");
    expect(prompt).toContain("## User");
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("### 🔧 tool_use: Read");
    expect(prompt).toContain("### ✅ tool_result");
  });

  it("spawn mode invokes claude with correct argv + cwd + stdio", async () => {
    // Mock node:child_process.spawnSync before importing resume.ts so the
    // module captures the mocked binding.
    const spawnSpy = vi.fn().mockReturnValue({ status: 0 });
    vi.doMock("node:child_process", () => ({ spawnSync: spawnSpy }));

    const { resumeCmd } = await import("../../src/commands/resume/resume.js");
    const cwd = "/Users/me/my-app";
    const r = await resumeCmd({ idOrPrefix: "e2e12345", cwd, print: false });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [bin, args, options] = spawnSpy.mock.calls[0]!;
    expect(bin).toBe("claude");
    expect(args).toHaveLength(1);
    expect((args as string[])[0]).toContain("I had a coding session on another machine");
    expect((args as string[])[0]).toContain("E2E test session");
    expect((options as { cwd: string; stdio: string }).cwd).toBe("/Users/me/my-app");
    expect((options as { cwd: string; stdio: string }).stdio).toBe("inherit");
    expect(r.spawned).toBe(true);
  });
});
