import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  projectRaw: "/Users/me/edge-memvc",
  startedAt: "2026-04-17T10:00:00Z",
  endedAt: "2026-04-17T10:30:00Z",
  nameSlug: "fix-login-bug",
  displayName: "fix login bug",
  relativePath: "raw_sessions/claude/edge-memvc/2026-04-17/fix-login-bug__abc12345.jsonl",
  sourcePath: "/tmp/original.jsonl",
  sourceMtimeMs: 1234567890,
  sourceSha256: "deadbeef",
};

/** Plant the file that `entry.relativePath` points at, so hasUnchanged()'s
 *  existence check passes. Most index-store tests don't care about the file
 *  on disk — only the existence-check test does. */
function plantIndexedFile(repoRoot: string, e: IndexEntry) {
  const abs = join(repoRoot, e.relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "{}\n");
}

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

  it("hasUnchanged returns true when mtime+sha match AND file exists in working tree", () => {
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    plantIndexedFile(dir, entry);
    expect(hasUnchanged(idx, "claude", "abc-123", 1234567890, "deadbeef", dir)).toBe(true);
    expect(hasUnchanged(idx, "claude", "abc-123", 9999, "deadbeef", dir)).toBe(false);
    expect(hasUnchanged(idx, "claude", "abc-123", 1234567890, "newhash", dir)).toBe(false);
  });

  it("hasUnchanged returns false when index entry exists but the working-tree file is missing", () => {
    // This is the branch-switch dogfood bug from 2026-05-20: index says the
    // session was synced before, but the new branch's raw_sessions/ doesn't
    // have the file. Without this guard, sync would skip and the new branch
    // would stay perpetually incomplete.
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    plantIndexedFile(dir, entry);
    unlinkSync(join(dir, entry.relativePath));
    expect(hasUnchanged(idx, "claude", "abc-123", 1234567890, "deadbeef", dir)).toBe(false);
  });

  it("saves pretty-printed JSON", () => {
    const idx = loadIndex(dir);
    upsertEntry(idx, entry);
    saveIndex(dir, idx);
    const raw = readFileSync(join(dir, ".vibebook", "index.json"), "utf8");
    expect(raw).toContain("\n");
    expect(raw).toContain('"version": 1');
  });
});
