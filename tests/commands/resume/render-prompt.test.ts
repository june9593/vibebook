import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import {
  renderResumePrompt,
  renderResumePromptChunked,
  extractMdHeader,
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

describe("extractMdHeader", () => {
  it("returns null for legacy 0.6 md (no manifest_version)", () => {
    const md = "---\nsessionId: x\ntool: claude\n---\n\n## User\n\nhi\n";
    expect(extractMdHeader(md)).toBeNull();
  });

  it("returns null when manifest_version present but no ## User/Assistant in body", () => {
    const md = "---\nmanifest_version: 1\n---\n\nbody without headings\n";
    expect(extractMdHeader(md)).toBeNull();
  });

  it("returns the prefix ending right before the first ## User/Assistant heading", () => {
    const md = [
      "---",
      "sessionId: x",
      "manifest_version: 1",
      "user_turns: 3",
      "---",
      "",
      "# Table of Contents",
      "| # | Time | Marker | Preview | Line |",
      "| 1 | 04-17 10:00 | 🧑 | first user | →L11 |",
      "",
      "## User _(2026-04-17T10:00:00Z)_",
      "",
      "first user",
    ].join("\n");
    const header = extractMdHeader(md);
    expect(header).not.toBeNull();
    expect(header).toContain("manifest_version: 1");
    expect(header).toContain("# Table of Contents");
    expect(header).not.toContain("## User");
  });

  it("matches first ## Assistant if it comes before ## User (rare but legal)", () => {
    const md = [
      "---",
      "manifest_version: 1",
      "---",
      "",
      "# Table of Contents",
      "",
      "## Assistant _(t)_",
      "",
      "kickoff",
    ].join("\n");
    const header = extractMdHeader(md);
    expect(header).not.toBeNull();
    expect(header).not.toContain("## Assistant");
  });
});

describe("renderResumePromptChunked", () => {
  it("instructs Claude to Read from disk via TOC offsets, not load whole file", () => {
    const header = "---\nmanifest_version: 1\nuser_turns: 50\n---\n\n# Table of Contents\n| 1 | x | 🧑 | first | →L42 |";
    const prompt = renderResumePromptChunked(entry, "/tmp/foo.md", header, 9_500_000, { device: "macmini" });
    // Points at the on-disk file
    expect(prompt).toContain("/tmp/foo.md");
    // Reports size in MB so Claude knows it's big
    expect(prompt).toContain("9.1 MB");
    // Explains the TOC navigation pattern
    expect(prompt).toContain("→L<number>");
    expect(prompt).toContain("offset:");
    // Embeds the header inline
    expect(prompt).toContain("manifest_version: 1");
    expect(prompt).toContain("→L42");
    // Carries session metadata + device
    expect(prompt).toContain("macmini");
    expect(prompt).toContain("Trace memory leak");
  });

  it("formats size as KB (not '0.0 MB') for sub-MB files (0.8.5 cosmetic fix)", () => {
    const header = "---\nmanifest_version: 1\n---\n";
    const prompt = renderResumePromptChunked(entry, "/tmp/foo.md", header, 33_817);
    expect(prompt).toContain("33.0 KB");
    expect(prompt).not.toContain("0.0 MB");
  });

  it("formats size as bytes for tiny files", () => {
    const header = "---\nmanifest_version: 1\n---\n";
    const prompt = renderResumePromptChunked(entry, "/tmp/foo.md", header, 512);
    expect(prompt).toContain("512 B");
  });
});
