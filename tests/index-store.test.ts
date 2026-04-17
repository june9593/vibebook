import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, saveIndex, upsertEntry, hasUnchanged } from "../src/index-store.js";
import type { IndexEntry } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memvc-"));
});

const entry: IndexEntry = {
  sessionId: "abc-123",
  shortId: "abc12345",
  tool: "claude",
  project: "edge-memvc",
  startedAt: "2026-04-17T10:00:00Z",
  endedAt: "2026-04-17T10:30:00Z",
  nameSlug: "fix-login-bug",
  displayName: "fix login bug",
  relativePath: "raw_sessions/claude/edge-memvc/2026-04-17/fix-login-bug__abc12345.jsonl",
  sourcePath: "/tmp/original.jsonl",
  sourceMtimeMs: 1234567890,
  sourceSha256: "deadbeef",
};

describe("index-store", () => {
  it("returns empty index when file missing", () => {
    const idx = loadIndex(dir);
    expect(idx.entries).toEqual({});
    expect(idx.version).toBe(1);
  });

  it("round-trips entries through save/load", () => {
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    saveIndex(dir, idx);
    const reloaded = loadIndex(dir);
    expect(reloaded.entries["claude:abc-123"]).toEqual(entry);
  });

  it("hasUnchanged returns true when mtime and sha match", () => {
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    expect(hasUnchanged(idx, "claude", "abc-123", 1234567890, "deadbeef")).toBe(true);
    expect(hasUnchanged(idx, "claude", "abc-123", 9999, "deadbeef")).toBe(false);
    expect(hasUnchanged(idx, "claude", "abc-123", 1234567890, "newhash")).toBe(false);
  });

  it("saves pretty-printed JSON", () => {
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    saveIndex(dir, idx);
    const raw = readFileSync(join(dir, ".memvc", "index.json"), "utf8");
    expect(raw).toContain("\n");
    expect(raw).toContain('"version": 1');
  });
});
