import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import {
  renderResumePrompt,
  chooseInvocation,
  ARG_MAX_BYTES,
} from "../../../src/commands/resume/render-prompt.js";
import type { IndexEntry } from "../../../src/types.js";

const entry: IndexEntry = {
  sessionId: "abc12345-cbf6-41f0-ab88-5cb425caba57",
  shortId: "abc12345",
  tool: "claude",
  project: "edge-src",
  projectRaw: "/Users/me/edge/src",
  startedAt: "2026-05-15T14:32:00Z",
  endedAt: "2026-05-15T16:18:00Z",
  nameSlug: "trace-leak",
  displayName: "Trace memory leak",
  relativePath: "raw_sessions/claude/edge-src/2026-05-15/trace-leak__abc12345.md",
  sourcePath: "/x.jsonl",
  sourceMtimeMs: 1,
  sourceSha256: "x",
};

describe("renderResumePrompt", () => {
  it("includes a clear instruction header for Claude", () => {
    const prompt = renderResumePrompt(entry, "## User\n\nhi\n");
    expect(prompt).toContain("I had a coding session on another machine");
    expect(prompt).toContain("Read it carefully");
    expect(prompt).toContain("What's our next step?");
  });

  it("includes session metadata (name, device, dates)", () => {
    const prompt = renderResumePrompt(entry, "(body)", { device: "yuedeMacBook" });
    expect(prompt).toContain("Trace memory leak");
    expect(prompt).toContain("yuedeMacBook");
    expect(prompt).toContain("2026-05-15T14:32:00Z");
  });

  it("embeds the full context md body verbatim", () => {
    const md = "## User\n\nthe full thing\n\n## Assistant\n\nack\n";
    const prompt = renderResumePrompt(entry, md);
    expect(prompt).toContain(md);
  });
});

describe("chooseInvocation", () => {
  it("returns [claude, prompt] for short prompts", () => {
    const argv = chooseInvocation("hi", "abc12345");
    expect(argv).toEqual(["claude", "hi"]);
  });

  it("falls back to /tmp file + Read for prompts > 90% of ARG_MAX", () => {
    const big = "x".repeat(Math.floor(ARG_MAX_BYTES * 0.95));
    const argv = chooseInvocation(big, "abc12345");
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toMatch(/^Read .+\/\.vibebook-resume-abc12345\.md and act on the instructions there\.$/);
    // verify the file was written and contains the prompt
    const m = argv[1]!.match(/Read (\S+) and/);
    expect(m).not.toBeNull();
    const tmpPath = m![1]!;
    expect(existsSync(tmpPath)).toBe(true);
    expect(readFileSync(tmpPath, "utf8")).toBe(big);
    rmSync(tmpPath);
  });
});
