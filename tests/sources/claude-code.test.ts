import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, sanitizeMessageText } from "../../src/sources/claude-code.js";
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
    expect(s.messages.length).toBe(2);  // "thanks" (< 10 chars) sanitized away
    expect(s.messages[0].role).toBe("user");
    expect(s.messages[1].role).toBe("assistant");
    expect(s.startedAt).toBe("2026-04-13T03:36:53.475Z");
    expect(s.endedAt).toBe("2026-04-13T03:40:00.000Z");
  });
});

describe("ClaudeCodeAdapter — pollution filter", () => {
  let claudeRoot: string;
  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), "vibebook-claude-test-"));
  });

  it("skips top-level project dirs that look like vibebook scratch", async () => {
    // Real-looking project dir
    const realProj = join(claudeRoot, "-Users-me-edge-memvc");
    mkdirSync(realProj, { recursive: true });
    writeFileSync(join(realProj, "session-1.jsonl"), '{"sessionId":"s1","cwd":"/Users/me/edge/memvc"}\n');

    // Polluted dirs — different shapes
    const polluted1 = join(claudeRoot, "-private-var-folders-zm-x-T-vibebook-claude-Abc");
    mkdirSync(polluted1, { recursive: true });
    writeFileSync(join(polluted1, "junk.jsonl"), '{"sessionId":"junk","cwd":"/private/var/folders/x/T/vibebook-claude-Abc"}\n');

    const polluted2 = join(claudeRoot, "-var-folders-y-T-vibebook-claude-Def");
    mkdirSync(polluted2, { recursive: true });
    writeFileSync(join(polluted2, "junk2.jsonl"), '{"sessionId":"junk2","cwd":"/var/folders/y/T/vibebook-claude-Def"}\n');

    const polluted3 = join(claudeRoot, "-tmp-vibebook-claude-Ghi");
    mkdirSync(polluted3, { recursive: true });
    writeFileSync(join(polluted3, "junk3.jsonl"), '{"sessionId":"junk3","cwd":"/tmp/vibebook-claude-Ghi"}\n');

    // Generic vibebook-claude name without the standard tmpdir prefix
    const polluted4 = join(claudeRoot, "-some-random-path-vibebook-claude-Jkl");
    mkdirSync(polluted4, { recursive: true });
    writeFileSync(join(polluted4, "junk4.jsonl"), '{"sessionId":"junk4","cwd":"/x/vibebook-claude-Jkl"}\n');

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
    expect(sourcePaths.some((p) => p.includes("-Users-me-edge-memvc"))).toBe(true);
    // Legit tmp-rooted developer work also yielded — we only filter vibebook's own scratch.
    expect(sourcePaths.some((p) => p.includes("-tmp-experiment"))).toBe(true);
    // No vibebook-claude scratch yielded — assertion is on discover() itself,
    // not on load(), so a filter regression cannot be masked by parse errors.
    // (The mkdtemp root itself contains "vibebook-claude-test-" so we check the
    // junk filenames that only exist inside the polluted dirs.)
    expect(sourcePaths.some((p) => p.endsWith("junk.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk2.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk3.jsonl"))).toBe(false);
    expect(sourcePaths.some((p) => p.endsWith("junk4.jsonl"))).toBe(false);
  });

  it("skips subagents/ subdirs at any depth", async () => {
    const proj = join(claudeRoot, "-Users-me-real-project");
    mkdirSync(proj, { recursive: true });
    // A real top-level session.
    writeFileSync(join(proj, "real.jsonl"), '{"sessionId":"real","cwd":"/Users/me/real-project"}\n');
    // A subagents/ subdir nested inside an outer session's dir.
    const outerSession = join(proj, "outer-session-id");
    mkdirSync(join(outerSession, "subagents"), { recursive: true });
    writeFileSync(
      join(outerSession, "subagents", "agent-foo.jsonl"),
      '{"sessionId":"agent-foo","cwd":"/Users/me/real-project"}\n',
    );
    // A nested subagents/ deeper still (defensive).
    mkdirSync(join(outerSession, "subagents", "nested-stuff"), { recursive: true });
    writeFileSync(
      join(outerSession, "subagents", "nested-stuff", "agent-bar.jsonl"),
      '{"sessionId":"agent-bar","cwd":"/Users/me/real-project"}\n',
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

describe("sanitizeMessageText", () => {
  it("strips <system-reminder> blocks (with body, multi-line)", () => {
    const out = sanitizeMessageText("real content\n<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>\nmore content");
    expect(out).not.toContain("system-reminder");
    expect(out).not.toContain("task tools");
    expect(out).toContain("real content");
    expect(out).toContain("more content");
  });

  it("strips <local-command-caveat> blocks", () => {
    const out = sanitizeMessageText("<local-command-caveat>Caveat: messages below were generated...</local-command-caveat>\nactual user question here");
    expect(out).not.toContain("Caveat");
    expect(out).toContain("actual user question");
  });

  it("strips <local-command-stdout> blocks (which contain ANSI noise)", () => {
    const out = sanitizeMessageText("<local-command-stdout>[38;2;153;153;153m⛁ ⛁ ⛁ Context Usage</local-command-stdout>\nuser thoughts");
    expect(out).not.toContain("⛁");
    expect(out).not.toContain("Context Usage");
    expect(out).toContain("user thoughts");
  });

  it("strips <command-message> / <command-name> / <command-args> blocks", () => {
    const out = sanitizeMessageText("<command-message>create-colleague</command-message><command-name>/create-colleague</command-name><command-args>Alias: jiaming</command-args>real instructions");
    expect(out).not.toContain("create-colleague");
    expect(out).not.toContain("jiaming");
    expect(out).toContain("real instructions");
  });

  it("strips skill preamble starting with 'Base directory for this skill:' up to ---", () => {
    const out = sanitizeMessageText(`Base directory for this skill: /Users/x/.claude/skills/foo

# Some skill instructions
Lots of skill template lines that aren't user content
More template
---
The actual user question after the separator`);
    expect(out).not.toContain("Base directory");
    expect(out).not.toContain("skill template");
    expect(out).toContain("actual user question");
  });

  it("drops whole text when it's an API error", () => {
    expect(sanitizeMessageText("API Error: 400 model_not_supported foobar")).toBe("");
    expect(sanitizeMessageText("  API Error: 500 timeout")).toBe("");
  });

  it("drops text < 10 chars after sanitize", () => {
    expect(sanitizeMessageText("hi")).toBe("");
    expect(sanitizeMessageText("ok thanks")).toBe("");        // 9 chars
    expect(sanitizeMessageText("ok thanks!")).toBe("ok thanks!"); // 10 chars - keep
  });

  it("strips <task-notification> blocks (background-task event noise)", () => {
    const out = sanitizeMessageText("real user message\n<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>\nmore");
    expect(out).not.toContain("task-notification");
    expect(out).not.toContain("task-id");
    expect(out).toContain("real user message");
    expect(out).toContain("more");
  });

  it("strips [Request interrupted by user...] system-injected pseudo-messages", () => {
    expect(sanitizeMessageText("[Request interrupted by user]")).toBe("");
    expect(sanitizeMessageText("[Request interrupted by user for tool use]")).toBe("");
    const out = sanitizeMessageText("real content\n[Request interrupted by user]\nmore content here");
    expect(out).not.toContain("interrupted");
    expect(out).toContain("real content");
    expect(out).toContain("more content");
  });

  it("strips multiple pollution kinds in one message + length-gates the result", () => {
    // Common real-world shape: command preamble + caveat + tiny user reply.
    const out = sanitizeMessageText("<local-command-caveat>blah</local-command-caveat><command-message>x</command-message><command-name>/x</command-name>ok");
    expect(out).toBe("");  // only "ok" left — drop
  });

  it("preserves clean user messages untouched (modulo trim)", () => {
    const real = "我修改了 OnWidgetActivationChanged 方法,需要你看看这段代码逻辑对不对...";
    expect(sanitizeMessageText(real)).toBe(real);
  });

  it("returns empty for null/undefined/empty input", () => {
    expect(sanitizeMessageText("")).toBe("");
    // @ts-expect-error testing runtime safety
    expect(sanitizeMessageText(null)).toBe("");
    // @ts-expect-error testing runtime safety
    expect(sanitizeMessageText(undefined)).toBe("");
  });
});
