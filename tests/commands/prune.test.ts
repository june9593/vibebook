import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneCmd } from "../../src/commands/prune.js";

let repo: string;
let homeBackup: string;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vbk-prune-home-"));
  vi.stubEnv("HOME", tmpHome);
  homeBackup = process.env.HOME!;
  repo = mkdtempSync(join(tmpdir(), "vbk-prune-repo-"));
  mkdirSync(join(repo, ".vibebook"), { recursive: true });
  // Minimal config so readConfig works
  mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".vibebook", "config.json"),
    JSON.stringify({
      repoPath: repo, repoUrl: "", encrypt: false, salt: "x",
      deviceBranch: "test", runner: "claude-cli",
    }),
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  process.env.HOME = homeBackup;
});

function plantMd(rel: string, content = "x") {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function plantIndex(entries: { relativePath: string; sessionId: string }[]) {
  const idx = {
    version: 1,
    entries: Object.fromEntries(entries.map((e) => [
      `copilot:${e.sessionId}`,
      {
        sessionId: e.sessionId, shortId: e.sessionId.slice(0, 8), tool: "copilot",
        project: "p", projectRaw: "/p", startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:00Z", nameSlug: "x", displayName: "x",
        relativePath: e.relativePath, sourcePath: "/x", sourceMtimeMs: 1, sourceSha256: "x",
      },
    ])),
  };
  writeFileSync(join(repo, ".vibebook/index.json"), JSON.stringify(idx));
}

describe("pruneCmd", () => {
  it("finds orphan .md files (on disk but not in index)", async () => {
    plantMd("raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md");
    plantMd("raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md");
    plantIndex([{ relativePath: "raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md", sessionId: "aaaa1111-real-id" }]);

    const r = await pruneCmd({ repoPath: repo });
    expect(r.scanned).toBe(2);
    expect(r.indexed).toBe(1);
    expect(r.orphans).toEqual(["raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md"]);
    expect(r.deleted).toEqual([]);
    // Default is dry-run — files still there
    expect(existsSync(join(repo, "raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md"))).toBe(true);
  });

  it("--apply actually deletes the orphans", async () => {
    plantMd("raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md");
    plantMd("raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md");
    plantIndex([{ relativePath: "raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md", sessionId: "aaaa1111-real-id" }]);

    const r = await pruneCmd({ repoPath: repo, apply: true });
    expect(r.deleted).toEqual(["raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md"]);
    expect(existsSync(join(repo, "raw_sessions/copilot/p/2026-01-01/orphan__bbbb2222.md"))).toBe(false);
    expect(existsSync(join(repo, "raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md"))).toBe(true);
  });

  it("removes now-empty parent dirs after deleting last child", async () => {
    plantMd("raw_sessions/copilot/empty-proj/1970-01-01/only-file__cccc3333.md");
    plantIndex([]);

    await pruneCmd({ repoPath: repo, apply: true });
    expect(existsSync(join(repo, "raw_sessions/copilot/empty-proj/1970-01-01"))).toBe(false);
    expect(existsSync(join(repo, "raw_sessions/copilot/empty-proj"))).toBe(false);
    expect(existsSync(join(repo, "raw_sessions/copilot"))).toBe(false);
    // raw_sessions itself is left alone
    expect(existsSync(join(repo, "raw_sessions"))).toBe(true);
  });

  it("reports zero orphans cleanly when index matches disk", async () => {
    plantMd("raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md");
    plantIndex([{ relativePath: "raw_sessions/copilot/p/2026-01-01/keeper__aaaa1111.md", sessionId: "aaaa1111-real-id" }]);

    const r = await pruneCmd({ repoPath: repo });
    expect(r.orphans).toEqual([]);
    expect(r.deleted).toEqual([]);
  });
});
