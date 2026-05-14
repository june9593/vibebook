import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../src/writer.js";
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
    expect(existsSync(join(repo, written.jsonl))).toBe(true);
    const copied = readFileSync(join(repo, written.jsonl), "utf8");
    expect(copied).toBe(sourceContent);

    rmSync(tmp, { recursive: true, force: true });
  });
});
