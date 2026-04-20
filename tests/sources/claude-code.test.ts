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

    // Legit developer work in /tmp/experiment — must NOT be filtered out.
    const realTmpProj = join(claudeRoot, "-tmp-experiment");
    mkdirSync(realTmpProj, { recursive: true });
    writeFileSync(join(realTmpProj, "real-tmp.jsonl"), '{"sessionId":"real-tmp","cwd":"/tmp/experiment"}\n');

    const adapter = new ClaudeCodeAdapter(claudeRoot);
    const sourcePaths: string[] = [];
    for await (const ds of adapter.discover()) {
      sourcePaths.push(ds.sourcePath);
    }
    // Real session yielded.
    expect(sourcePaths.some((p) => p.includes("-Users-yueliu-edge-memvc"))).toBe(true);
    // Legit tmp-rooted developer work also yielded — we only filter memvc's own scratch.
    expect(sourcePaths.some((p) => p.includes("-tmp-experiment"))).toBe(true);
    // No memvc-claude scratch yielded — assertion is on discover() itself,
    // not on load(), so a filter regression cannot be masked by parse errors.
    // (The mkdtemp root itself contains "memvc-claude-test-" so we check the
    // junk filenames that only exist inside the polluted dirs.)
    expect(sourcePaths.some((p) => p.endsWith("junk.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk2.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk3.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk4.jsonl"))).toBe(false);
  });

  it("skips subagents/ subdirs at any depth", async () => {
    const proj = join(claudeRoot, "-Users-yueliu-real-project");
    mkdirSync(proj, { recursive: true });
    // A real top-level session.
    writeFileSync(join(proj, "real.jsonl"), '{"sessionId":"real","cwd":"/Users/yueliu/real-project"}\n');
    // A subagents/ subdir nested inside an outer session's dir.
    const outerSession = join(proj, "outer-session-id");
    mkdirSync(join(outerSession, "subagents"), { recursive: true });
    writeFileSync(
      join(outerSession, "subagents", "agent-foo.jsonl"),
      '{"sessionId":"agent-foo","cwd":"/Users/yueliu/real-project"}\n',
    );
    // A nested subagents/ deeper still (defensive).
    mkdirSync(join(outerSession, "subagents", "nested-stuff"), { recursive: true });
    writeFileSync(
      join(outerSession, "subagents", "nested-stuff", "agent-bar.jsonl"),
      '{"sessionId":"agent-bar","cwd":"/Users/yueliu/real-project"}\n',
    );

    const adapter = new ClaudeCodeAdapter(claudeRoot);
    const sourcePaths: string[] = [];
    for await (const ds of adapter.discover()) {
      sourcePaths.push(ds.sourcePath);
    }
    expect(sourcePaths.some((p) => p.endsWith("real.jsonl"))).toBe(true);
    expect(sourcePaths.some((p) => p.includes("/subagents/"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("agent-foo.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("agent-bar.jsonl"))).toBe(false);
  });
});
