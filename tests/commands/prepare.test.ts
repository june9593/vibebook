import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshSaltBase64, type Config } from "../../src/config.js";

let tmpHome: string;
let repoPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-prep-"));
  vi.stubEnv("HOME", tmpHome);
  repoPath = join(tmpHome, "repo");
  mkdirSync(repoPath, { recursive: true });
  vi.resetModules();  // force fresh import of config.ts so CONFIG_DIR re-evaluates
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

function writeRawSession(rel: string, body: string) {
  const abs = join(repoPath, rel);
  mkdirSync(join(abs, "..").replace(/[^/]+$/, ""), { recursive: true });
  // Simpler: ensure dir
  const dir = abs.split("/").slice(0, -1).join("/");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body);
}

describe("prepare — happy path", () => {
  it("returns new sessions, sorted by endedAt, with insightScore + preview", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": {
        sessionId: "s1", shortId: "s1aaaaaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "Fix-bug-A", displayName: "Fix bug A",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json",
        sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "abc",
      },
      "claude:s2": {
        sessionId: "s2", shortId: "s2bbbbbb", tool: "claude", project: "edge-src",
        startedAt: "2026-04-02T10:00:00Z", endedAt: "2026-04-02T11:00:00Z",
        nameSlug: "Refactor", displayName: "Refactor",
        relativePath: "raw_sessions/claude/edge-src/2026-04-02/x__s2.raw.json",
        sourcePath: "/x2.jsonl", sourceMtimeMs: 1, sourceSha256: "def",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.md",
      "# x\n## User\nfix the bug because root cause is unclear\n## Assistant\nLet me look\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-02/x__s2.md",
      "# x\n## User\nrefactor this thing\n## Assistant\nok\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json", "{}");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-02/x__s2.raw.json", "{}");

    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.newSessions.length).toBe(2);
    expect(payload.newSessions[0].sessionId).toBe("s1"); // older first
    expect(payload.newSessions[1].sessionId).toBe("s2");
    expect(payload.newSessions[0].mdPath).toBe("raw_sessions/claude/edge-src/2026-04-01/x__s1.md");
    expect(payload.newSessions[0].preview).toContain("fix the bug");
    expect(payload.newSessions[0].insightScore).toBeGreaterThan(0); // has 'bug', 'root cause'
    expect(payload.meta.newSessionsCount).toBe(2);
    expect(payload.meta.totalSessionsInIndex).toBe(2);
    expect(payload.meta.sessionsAlreadyChronicled).toBe(0);
  });
});

describe("prepare — already-chronicled sessions", () => {
  it("excludes sessions referenced by an existing chronicle", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": {
        sessionId: "s1", shortId: "s1aaaaaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json",
        sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "abc",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.md", "# x\n## User\nfoo bar baz qux\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json", "{}");
    // pretend a chronicle already consumed s1
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    writeFileSync(join(repoPath, ".vibebook", "index.book.json"), JSON.stringify({
      version: 2,
      chronicles: {
        "fix-x": {
          threadId: "fix-x", project: "edge-src", title: "Fix x", sessionIds: ["s1"],
          path: "book/edge-src/chronicle/x.md",
          createdAt: "2026-04-01", updatedAt: "2026-04-01", tags: [],
        },
      },
      topics: {}, cards: {},
    }));
    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.newSessions.length).toBe(0);
    expect(payload.meta.sessionsAlreadyChronicled).toBe(1);
  });
});

describe("prepare — project filter", () => {
  it("includes only sessions from the requested project", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": {
        sessionId: "s1", shortId: "s1aaaaaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/a__s1.raw.json",
        sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "a",
      },
      "claude:s2": {
        sessionId: "s2", shortId: "s2bbbbbb", tool: "claude", project: "chromium-src",
        startedAt: "2026-04-02T10:00:00Z", endedAt: "2026-04-02T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/chromium-src/2026-04-02/b__s2.raw.json",
        sourcePath: "/x2.jsonl", sourceMtimeMs: 1, sourceSha256: "b",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/a__s1.md", "# x\n## User\nthis is bug fix work\n");
    writeRawSession("raw_sessions/claude/chromium-src/2026-04-02/b__s2.md", "# x\n## User\nthis is bug fix work\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/a__s1.raw.json", "{}");
    writeRawSession("raw_sessions/claude/chromium-src/2026-04-02/b__s2.raw.json", "{}");

    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload({ project: "edge-src" });
    expect(payload.newSessions.length).toBe(1);
    expect(payload.newSessions[0].project).toBe("edge-src");
    expect(payload.meta.sessionsFilteredByProject).toBe(1);
  });
});

describe("prepare — plaintext working tree even when encrypt=true", () => {
  // After v0.2 git-filter encryption, the working tree is ALWAYS plaintext.
  // Encryption only happens at git-add time via the `vibebook crypt clean`
  // filter, so prepare just reads .md directly regardless of cfg.encrypt.
  it("reads .md as plaintext when encrypt=true (no in-process decrypt)", async () => {
    const salt = freshSaltBase64();
    writeConfig({ repoPath, encrypt: true, salt });
    writeFileSync(join(tmpHome, ".vibebook", "passphrase"), "secretpass");
    writeIndex({
      "claude:s1": {
        sessionId: "s1", shortId: "s1aaaaaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json",
        sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "abc",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.md",
      "# x\n## User\nfix this annoying bug\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/x__s1.raw.json", "{}");

    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.newSessions.length).toBe(1);
    expect(payload.newSessions[0].preview).toContain("fix this annoying bug");
  });
});

describe("prepare — pseudo project filter", () => {
  it("excludes sessions from worktree / scratch / hex-prefixed projects", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:s1": {
        sessionId: "s1", shortId: "s1aaaaaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/a__s1.raw.json",
        sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "a",
      },
      "claude:s2": {
        sessionId: "s2", shortId: "s2bbbbbb", tool: "claude",
        project: "edge-src.worktrees-rename-vibebook",
        startedAt: "2026-04-02T10:00:00Z", endedAt: "2026-04-02T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/garbage/2026-04-02/b__s2.raw.json",
        sourcePath: "/x2.jsonl", sourceMtimeMs: 1, sourceSha256: "b",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/a__s1.md", "# x\n## User\nfix work\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/a__s1.raw.json", "{}");

    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.newSessions.length).toBe(1);
    expect(payload.newSessions[0].project).toBe("edge-src");
    expect(payload.meta.sessionsFilteredAsPseudoProject).toBe(1);
  });
});

describe("prepare — exposes existing topics + cards grouped by project", () => {
  it("emits existingTopics + existingCards for the skill to dedup against", async () => {
    writeConfig({ repoPath });
    writeIndex({});
    mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
    writeFileSync(join(repoPath, ".vibebook", "index.book.json"), JSON.stringify({
      version: 2,
      chronicles: {},
      topics: {
        "edge-src/foo": { topicSlug: "foo", project: "edge-src", path: "x", createdAt: "d", updatedAt: "d", contributingThreads: [] },
        "edge-src/bar": { topicSlug: "bar", project: "edge-src", path: "x", createdAt: "d", updatedAt: "d", contributingThreads: [] },
        "chromium/baz": { topicSlug: "baz", project: "chromium", path: "x", createdAt: "d", updatedAt: "d", contributingThreads: [] },
      },
      cards: {
        "_global/howto-x": { cardSlug: "howto-x", project: "_global", type: "howto", path: "x", createdAt: "d", updatedAt: "d", tags: [] },
        "edge-src/gotcha-y": { cardSlug: "gotcha-y", project: "edge-src", type: "gotcha", path: "x", createdAt: "d", updatedAt: "d", tags: [] },
      },
    }));
    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.existingTopics["edge-src"].sort()).toEqual(["bar", "foo"]);
    expect(payload.existingTopics["chromium"]).toEqual(["baz"]);
    expect(payload.existingCards["_global"]).toEqual(["howto-x"]);
    expect(payload.existingCards["edge-src"]).toEqual(["gotcha-y"]);
  });
});

describe("prepare — vibebook meta-session filter", () => {
  it("excludes sessions whose first user message is /vibebook", async () => {
    writeConfig({ repoPath });
    writeIndex({
      "claude:meta1": {
        sessionId: "meta1", shortId: "meta1aaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-01T10:00:00Z", endedAt: "2026-04-01T11:00:00Z",
        nameSlug: "x", displayName: "x",
        relativePath: "raw_sessions/claude/edge-src/2026-04-01/m__meta1.raw.json",
        sourcePath: "/m.jsonl", sourceMtimeMs: 1, sourceSha256: "m",
      },
      "claude:real1": {
        sessionId: "real1", shortId: "real1aaa", tool: "claude", project: "edge-src",
        startedAt: "2026-04-02T10:00:00Z", endedAt: "2026-04-02T11:00:00Z",
        nameSlug: "y", displayName: "y",
        relativePath: "raw_sessions/claude/edge-src/2026-04-02/r__real1.raw.json",
        sourcePath: "/r.jsonl", sourceMtimeMs: 1, sourceSha256: "r",
      },
    });
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/m__meta1.md",
      "# meta\n## User\n/vibebook\n## Assistant\nrunning prepare\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-02/r__real1.md",
      "# real\n## User\nfix bug in foo.cc, the root cause is X\n## Assistant\nlet me look\n");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-01/m__meta1.raw.json", "{}");
    writeRawSession("raw_sessions/claude/edge-src/2026-04-02/r__real1.raw.json", "{}");

    const { buildPreparePayload } = await import("../../src/commands/prepare.js");
    const payload = buildPreparePayload();
    expect(payload.newSessions.length).toBe(1);
    expect(payload.newSessions[0].sessionId).toBe("real1");
    expect(payload.meta.sessionsFilteredAsVibebookMeta).toBe(1);
  });
});
