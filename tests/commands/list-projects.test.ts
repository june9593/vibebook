import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

let tmpHome: string;
let repoPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-listprojs-"));
  vi.stubEnv("HOME", tmpHome);
  repoPath = join(tmpHome, "repo");
  mkdirSync(repoPath, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

function writeConfig(c: Partial<Config> & { repoPath: string }) {
  mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
    repoUrl: "git@example.com:u/r.git",
    encrypt: false, salt: "x",
    deviceBranch: "test.lan",
    runner: "claude-cli",
    enableAggregateCI: false, includeReasoning: true,
    threadingConcurrency: 4, threadingMaxAttempts: 3,
    digestEnabled: true,
    ...c,
  }));
}

function writeIndex(entries: Record<string, unknown>) {
  mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
  writeFileSync(join(repoPath, ".vibebook", "index.json"), JSON.stringify({
    version: 1, entries,
  }, null, 2));
}

function writeBookIndex(idx: object) {
  mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
  writeFileSync(join(repoPath, ".vibebook", "index.book.json"), JSON.stringify(idx, null, 2));
}

describe("list-projects", () => {
  it("returns per-project counts with pending = total - consumed", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": entry("s1", "edge-src"),
      "claude:s2": entry("s2", "edge-src"),
      "claude:s3": entry("s3", "chromium-src"),
    });
    writeBookIndex({
      version: 2,
      chronicles: {
        "t1": {
          threadId: "t1", project: "edge-src", title: "x",
          sessionIds: ["s1"], path: "book/edge-src/chronicle/x.md",
          createdAt: "2026-04-01", updatedAt: "2026-04-01", tags: [],
        },
      },
      topics: {},
      cards: {},
    });

    const { buildListProjectsPayload } = await import("../../src/commands/list-projects.js");
    const out = buildListProjectsPayload(repoPath);

    expect(out.meta.isInSessionRepo).toBe(true);
    expect(out.meta.sessionRepoPath).toBe(repoPath);
    const edge = out.projects.find((p) => p.project === "edge-src")!;
    expect(edge.totalSessions).toBe(2);
    expect(edge.consumedSessions).toBe(1);
    expect(edge.pendingSessions).toBe(1);
    expect(edge.chronicles).toBe(1);
    const cr = out.projects.find((p) => p.project === "chromium-src")!;
    expect(cr.totalSessions).toBe(1);
    expect(cr.pendingSessions).toBe(1);
    expect(cr.chronicles).toBe(0);
  });

  it("sorts projects by pendingSessions desc; isInSessionRepo=false when cwd != repoPath", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:a": entry("a", "small-proj"),
      "claude:b": entry("b", "big-proj"),
      "claude:c": entry("c", "big-proj"),
      "claude:d": entry("d", "big-proj"),
    });
    writeBookIndex({ version: 2, chronicles: {}, topics: {}, cards: {} });

    const { buildListProjectsPayload } = await import("../../src/commands/list-projects.js");
    const out = buildListProjectsPayload("/some/other/cwd");

    expect(out.meta.isInSessionRepo).toBe(false);
    expect(out.projects[0]!.project).toBe("big-proj");
    expect(out.projects[1]!.project).toBe("small-proj");
  });

  it("excludes pseudo-projects (isRealProjectPath=false)", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": entry("s1", "edge-src"),
      // "home" is a pseudo project per isRealProjectPath:
      "claude:s2": entry("s2", "home"),
    });
    writeBookIndex({ version: 2, chronicles: {}, topics: {}, cards: {} });

    const { buildListProjectsPayload } = await import("../../src/commands/list-projects.js");
    const out = buildListProjectsPayload(repoPath);
    expect(out.projects.map((p) => p.project)).toEqual(["edge-src"]);
  });
});

function entry(id: string, project: string) {
  return {
    sessionId: id, shortId: id.slice(0, 8), tool: "claude", project,
    projectRaw: `/${project}`,
    startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
    nameSlug: "x", displayName: "x",
    relativePath: `raw_sessions/claude/${project}/2026-04-01/x__${id}.raw.json`,
    sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "abc",
  };
}
