import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, JSONL_MAX_BYTES } from "../src/writer.js";
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
      { role: "user", text: "Fix the auth bug", timestamp: "2026-04-17T10:00:00Z" },
      { role: "assistant", text: "Looking now.", timestamp: "2026-04-17T10:01:00Z" },
    ],
    sourcePath: src,
  };
});

describe("writeSession", () => {
  it("writes .raw.json and .md to the correct path", () => {
    const rel = writeSession(repo, session);
    expect(rel.raw).toBe("raw_sessions/claude/edge-memvc/2026-04-17/Fix-the-auth-bug__abc12345.raw.json");
    expect(rel.md).toBe("raw_sessions/claude/edge-memvc/2026-04-17/Fix-the-auth-bug__abc12345.md");
    expect(existsSync(join(repo, rel.raw))).toBe(true);
    expect(existsSync(join(repo, rel.md))).toBe(true);
  });

  it("markdown contains display name and messages", () => {
    const rel = writeSession(repo, session);
    const md = readFileSync(join(repo, rel.md), "utf8");
    expect(md).toContain("# Fix the auth bug");
    expect(md).toContain("**Tool:** claude");
    expect(md).toContain("**Project:** edge-memvc");
    expect(md).toContain("## User");
    expect(md).toContain("Fix the auth bug");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Looking now.");
  });

  it("raw json round-trips the session", () => {
    const rel = writeSession(repo, session);
    const raw = JSON.parse(readFileSync(join(repo, rel.raw), "utf8"));
    expect(raw.sessionId).toBe(session.sessionId);
    expect(raw.messages).toHaveLength(2);
  });

  it("also preserves the original jsonl byte-for-byte for resume", () => {
    const tmp = mkdtempSync(join(tmpdir(), "writer-jsonl-"));
    const sourceJsonl = join(tmp, "source.jsonl");
    const sourceContent = '{"type":"user","sessionId":"abc","cwd":"/x"}\n{"type":"assistant","sessionId":"abc","cwd":"/x"}\n';
    writeFileSync(sourceJsonl, sourceContent);

    const sess: NormalizedSession = {
      sessionId: "abc",
      shortId: "abc",
      tool: "claude",
      project: "test-project",
      projectRaw: "/x",
      nameSlug: "untitled",
      displayName: "untitled",
      startedAt: "2026-05-14T00:00:00Z",
      endedAt: "2026-05-14T00:01:00Z",
      sourcePath: sourceJsonl,
      messages: [],
    };

    const written = writeSession(repo, sess);
    expect(written.jsonl).toBeTruthy();
    expect(existsSync(join(repo, written.jsonl!))).toBe(true);
    const copied = readFileSync(join(repo, written.jsonl!), "utf8");
    expect(copied).toBe(sourceContent);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips jsonl when source exceeds GitHub-push size cap (still writes .md + .raw.json)", () => {
    // Build a source file just over the 95 MB cap. Using a single write of
    // (cap + 1) bytes — slow-ish but only ~95 MB, runs in ~1s and is the
    // only way to truly exercise the size check without mocking.
    const tmp = mkdtempSync(join(tmpdir(), "writer-oversized-"));
    const sourceJsonl = join(tmp, "huge.jsonl");
    const bytes = Buffer.alloc(JSONL_MAX_BYTES + 1, "a");
    writeFileSync(sourceJsonl, bytes);

    const sess: NormalizedSession = {
      sessionId: "huge-session",
      shortId: "huge1234",
      tool: "claude",
      project: "test-project",
      projectRaw: "/x",
      nameSlug: "huge",
      displayName: "huge",
      startedAt: "2026-05-20T00:00:00Z",
      endedAt: "2026-05-20T00:01:00Z",
      sourcePath: sourceJsonl,
      messages: [],
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const written = writeSession(repo, sess);
      expect(written.jsonl).toBeUndefined();
      expect(existsSync(join(repo, written.raw))).toBe(true);
      expect(existsSync(join(repo, written.md))).toBe(true);
      // Verify the would-be jsonl was NOT copied
      expect(existsSync(join(repo, "raw_sessions/claude/test-project/2026-05-20/huge__huge1234.jsonl"))).toBe(false);
      // Verify user got a warning explaining why
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/oversized jsonl skipped/));
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined jsonl when source file is missing (silent skip)", () => {
    const sess: NormalizedSession = {
      ...session,
      sourcePath: "/nonexistent/path/never/created.jsonl",
    };
    const written = writeSession(repo, sess);
    expect(written.jsonl).toBeUndefined();
    // .md and .raw.json still got written
    expect(existsSync(join(repo, written.raw))).toBe(true);
    expect(existsSync(join(repo, written.md))).toBe(true);
  });
});
