import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, TRUNCATE_THRESHOLD_BYTES } from "../src/writer.js";
import type { NormalizedSession } from "../src/types.js";

let repo: string;
let session: NormalizedSession;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "memvc-repo-"));
  const src = join(repo, "src.jsonl");
  writeFileSync(src, "{}\n");
  session = {
    tool: "claude",
    sessionId: "abc12345-cbf6-41f0-ab88-5cb425caba57",
    shortId: "abc12345",
    project: "edge-memvc",
    projectRaw: "/Users/me/edge/memvc",
    startedAt: "2026-04-17T10:00:00Z",
    endedAt: "2026-04-17T10:30:00Z",
    nameSlug: "Fix-the-auth-bug",
    displayName: "Fix the auth bug",
    messages: [
      {
        role: "user",
        text: "Fix the auth bug",
        timestamp: "2026-04-17T10:00:00Z",
        contentBlocks: [{ type: "text", text: "Fix the auth bug" }],
      },
      {
        role: "assistant",
        text: "Looking now.",
        reasoning: "Need to read the file first.",
        timestamp: "2026-04-17T10:01:00Z",
        contentBlocks: [
          { type: "thinking", thinking: "Need to read the file first." },
          { type: "text", text: "Looking now." },
          { type: "tool_use", name: "Read", input: { file_path: "/auth.ts" } },
        ],
      },
      {
        role: "user",
        text: "",
        timestamp: "2026-04-17T10:01:05Z",
        contentBlocks: [
          { type: "tool_result", content: "export const login = () => null;" },
        ],
      },
    ],
    sourcePath: src,
  };
});

describe("writeSession (0.6 — single .md, frontmatter, content blocks)", () => {
  it("writes only .md (no .raw.json, no .jsonl)", () => {
    const rel = writeSession(repo, session);
    expect(rel.md).toBe("raw_sessions/claude/edge-memvc/2026-04-17/Fix-the-auth-bug__abc12345.md");
    expect(existsSync(join(repo, rel.md))).toBe(true);
    // Negative assertions: legacy artifacts must not exist
    const base = "raw_sessions/claude/edge-memvc/2026-04-17/Fix-the-auth-bug__abc12345";
    expect(existsSync(join(repo, `${base}.raw.json`))).toBe(false);
    expect(existsSync(join(repo, `${base}.jsonl`))).toBe(false);
  });

  it("includes YAML frontmatter with required fields", () => {
    const { md } = writeSession(repo, session);
    const body = readFileSync(join(repo, md), "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("sessionId: abc12345-cbf6-41f0-ab88-5cb425caba57");
    expect(body).toContain("tool: claude");
    expect(body).toContain("project: edge-memvc");
    expect(body).toContain("projectRaw: /Users/me/edge/memvc");
    expect(body).toContain("startedAt: 2026-04-17T10:00:00Z");
    expect(body).toContain("endedAt: 2026-04-17T10:30:00Z");
    expect(body).toContain("displayName: Fix the auth bug");
  });

  it("renders text, thinking, tool_use, tool_result blocks", () => {
    const { md } = writeSession(repo, session);
    const body = readFileSync(join(repo, md), "utf8");
    expect(body).toContain("## User");
    expect(body).toContain("## Assistant");
    expect(body).toContain("Fix the auth bug");
    expect(body).toContain("> 💭 _thinking_");
    expect(body).toContain("> Need to read the file first.");
    expect(body).toContain("Looking now.");
    expect(body).toContain("### 🔧 tool_use: Read");
    expect(body).toContain('"file_path": "/auth.ts"');
    expect(body).toContain("### ✅ tool_result");
    expect(body).toContain("export const login = () => null;");
  });

  it("truncates tool_result content larger than TRUNCATE_THRESHOLD_BYTES", () => {
    const big = "line " + "x".repeat(50) + "\n";
    const bigContent = big.repeat(500); // ~28 KB
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(TRUNCATE_THRESHOLD_BYTES);
    const s2: NormalizedSession = {
      ...session,
      messages: [{
        role: "user",
        text: "",
        contentBlocks: [{ type: "tool_result", content: bigContent }],
      }],
    };
    const { md } = writeSession(repo, s2);
    const body = readFileSync(join(repo, md), "utf8");
    expect(body).toMatch(/\[\.\.\. truncated: .* KB output, omitting \d+ middle lines/);
    // Body must be much shorter than the raw content
    expect(body.length).toBeLessThan(bigContent.length / 2);
  });

  it("VIBEBOOK_FULL_TOOL_RESULTS=1 disables truncation", () => {
    const big = "line " + "x".repeat(50) + "\n";
    const bigContent = big.repeat(500);
    const s2: NormalizedSession = {
      ...session,
      messages: [{
        role: "user",
        text: "",
        contentBlocks: [{ type: "tool_result", content: bigContent }],
      }],
    };
    process.env.VIBEBOOK_FULL_TOOL_RESULTS = "1";
    try {
      const { md } = writeSession(repo, s2);
      const body = readFileSync(join(repo, md), "utf8");
      expect(body).toContain(bigContent);
      expect(body).not.toContain("[... truncated:");
    } finally {
      delete process.env.VIBEBOOK_FULL_TOOL_RESULTS;
    }
  });

  it("falls back to text/reasoning when contentBlocks is absent (legacy / Copilot source)", () => {
    const legacy: NormalizedSession = {
      ...session,
      messages: [{
        role: "assistant",
        text: "Hello world",
        reasoning: "I should greet",
        // no contentBlocks
      }],
    };
    const { md } = writeSession(repo, legacy);
    const body = readFileSync(join(repo, md), "utf8");
    expect(body).toContain("> 💭 _thinking_");
    expect(body).toContain("> I should greet");
    expect(body).toContain("Hello world");
  });

  it("drops messages that have no renderable content", () => {
    const empty: NormalizedSession = {
      ...session,
      messages: [
        { role: "user", text: "real" },
        { role: "assistant", text: "" },
        { role: "user", text: "more" },
      ],
    };
    const { md } = writeSession(repo, empty);
    const body = readFileSync(join(repo, md), "utf8");
    const userCount = (body.match(/^## User/gm) || []).length;
    expect(userCount).toBe(2);
    const asstCount = (body.match(/^## Assistant/gm) || []).length;
    expect(asstCount).toBe(0);
  });
});
