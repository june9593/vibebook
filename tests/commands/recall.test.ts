import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let repoPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-recall-"));
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

function writeConfig() {
  mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
    repoPath,
    repoUrl: "git@example.com:u/r.git",
    encrypt: false, salt: "x",
    deviceBranch: "test.lan",
    runner: "claude-cli",
    enableAggregateCI: false, includeReasoning: true,
    threadingConcurrency: 4, threadingMaxAttempts: 3,
    digestEnabled: true,
  }));
}

function writeIndex(entries: Record<string, unknown>) {
  mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
  writeFileSync(join(repoPath, ".vibebook", "index.json"), JSON.stringify({
    version: 1, entries,
  }, null, 2));
}

function writeBook(idx: object) {
  mkdirSync(join(repoPath, ".vibebook"), { recursive: true });
  writeFileSync(join(repoPath, ".vibebook", "index.book.json"), JSON.stringify(idx, null, 2));
}

function writeArtifact(rel: string, body: string) {
  const abs = join(repoPath, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("recall stage 1 — topic list", () => {
  it("default mode returns topics (not chronicles) for the project", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2,
      chronicles: {
        "fix-foo": {
          threadId: "fix-foo", project: "edge-src", title: "Fix foo",
          sessionIds: ["s1"], path: "book/edge-src/chronicle/2026-01-01__fix-foo__fix-foo.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: ["bug"],
        },
      },
      topics: {
        "edge-src/menu-bar": {
          topicSlug: "menu-bar", project: "edge-src",
          path: "book/edge-src/topics/menu-bar.md",
          createdAt: "2026-01-02", updatedAt: "2026-01-02",
          contributingThreads: ["fix-foo"],
        },
      },
      cards: {},
    });
    writeArtifact("book/edge-src/topics/menu-bar.md",
      "# Menu bar\n\nEdge macOS Menu Bar Copilot subsystem covering NSStatusItem and the floating widget.\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });

    expect(out.stage).toBe("stage-1-topics");
    expect(out.project).toBe("edge-src");
    expect(out.topic).toBeNull();
    // Only the topic should appear; chronicles are stage 2.
    const kinds = out.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["topic"]);
    expect(out.entries[0]!.title).toBe("Menu bar");
    expect(out.entries[0]!.summary).toContain("Edge macOS Menu Bar");
    expect(out.meta.topics).toBe(1);
    expect(out.meta.chronicles).toBe(0);
    expect(out.meta.nextStep).toContain("vibebook recall");
  });
});

describe("recall stage 2 — chronicles for one topic", () => {
  it("--topic returns chronicles in contributingThreads with frontmatter", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2,
      chronicles: {
        "fix-foo": {
          threadId: "fix-foo", project: "edge-src", title: "Fix foo bug",
          sessionIds: ["s1"], path: "book/edge-src/chronicle/2026-01-01__fix-foo__fix-foo.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: ["bug"],
        },
        "irrelevant": {
          threadId: "irrelevant", project: "edge-src", title: "Other",
          sessionIds: ["s2"], path: "book/edge-src/chronicle/2026-01-02__irrelevant__irrelevant.md",
          createdAt: "2026-01-02", updatedAt: "2026-01-02", tags: [],
        },
      },
      topics: {
        "edge-src/menu-bar": {
          topicSlug: "menu-bar", project: "edge-src",
          path: "book/edge-src/topics/menu-bar.md",
          createdAt: "2026-01-02", updatedAt: "2026-01-02",
          contributingThreads: ["fix-foo"],
        },
      },
      cards: {},
    });
    writeArtifact("book/edge-src/chronicle/2026-01-01__fix-foo__fix-foo.md",
      `---
title: Fix foo bug
project: edge-src
threadId: fix-foo
files_touched:
  - chrome/browser/foo.cc
  - chrome/browser/foo.h
commits:
  - abc1234
decisions:
  - Use approach A
status: shipped
---

# Fix foo bug

## What
Body.
`);
    writeArtifact("book/edge-src/chronicle/2026-01-02__irrelevant__irrelevant.md",
      "# Other\n\nbody\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src", topic: "menu-bar" });

    expect(out.stage).toBe("stage-2-articles");
    expect(out.topic).toBe("menu-bar");
    expect(out.entries.length).toBe(1);
    const c = out.entries[0]!;
    expect(c.kind).toBe("chronicle");
    expect(c.slug).toBe("fix-foo");
    expect(c.frontmatter?.files_touched).toEqual(["chrome/browser/foo.cc", "chrome/browser/foo.h"]);
    expect(c.frontmatter?.commits).toEqual(["abc1234"]);
    expect(c.frontmatter?.decisions).toEqual(["Use approach A"]);
    expect(c.frontmatter?.status).toBe("shipped");
    expect(c.summary).toContain("status=shipped");
    expect(c.summary).toContain("2 files");
    // path is absolute (so the agent can pass to Read directly)
    expect(c.path.startsWith("/")).toBe(true);
    expect(c.path.endsWith("2026-01-01__fix-foo__fix-foo.md")).toBe(true);
  });

  it("returns empty when topic doesn't exist", async () => {
    writeConfig();
    writeIndex({});
    writeBook({ version: 2, chronicles: {}, topics: {}, cards: {} });
    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src", topic: "nonexistent" });
    expect(out.stage).toBe("stage-2-articles");
    expect(out.entries).toEqual([]);
  });
});

describe("recall — cwd resolution", () => {
  it("resolves project from cwd via projectSlugFromPath", async () => {
    writeConfig();
    writeIndex({
      "claude:s1": entry("s1", "edge-src", "/Users/me/edge/src"),
    });
    writeBook({ version: 2, chronicles: {}, topics: {}, cards: {} });

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ cwd: "/Users/me/edge/src" });
    expect(out.project).toBe("edge-src");
    expect(out.meta.cwdUnresolved).toBeUndefined();
  });

  it("flags cwdUnresolved when no synced session matches the cwd", async () => {
    writeConfig();
    writeIndex({
      "claude:s1": entry("s1", "edge-src", "/Users/me/edge/src"),
    });
    writeBook({ version: 2, chronicles: {}, topics: {}, cards: {} });

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ cwd: "/some/unrelated/path" });
    expect(out.project).toBeNull();
    expect(out.meta.cwdUnresolved).toBe(true);
    expect(out.entries.length).toBe(0);
  });
});

describe("recall — memex source", () => {
  it("parseMemexIndex extracts slug + summary + category", async () => {
    const { parseMemexIndex } = await import("../../src/commands/recall.js");
    const md = `# Memex Knowledge Map

## Debugging

- [[gotcha-jwt-revocation]] — stateless JWTs can't be revoked; use a blacklist
- [[howto-stack-trace-bisect|Stack trace bisect]] — narrow a regression to one commit

## Patterns

- [[pattern-event-sourced-projection]]
`;
    const out = parseMemexIndex(md);
    expect(out.length).toBe(3);
    expect(out[0]!.slug).toBe("gotcha-jwt-revocation");
    expect(out[0]!.title).toBe("Jwt revocation");
    expect(out[0]!.summary).toContain("stateless JWTs");
    expect(out[0]!.tags).toEqual(["Debugging"]);
    expect(out[0]!.path).toBe("memex:gotcha-jwt-revocation");
    expect(out[1]!.title).toBe("Stack trace bisect");
    expect(out[2]!.tags).toEqual(["Patterns"]);
  });

  it("parseMemexIndex handles empty / heading-only input", async () => {
    const { parseMemexIndex } = await import("../../src/commands/recall.js");
    expect(parseMemexIndex("")).toEqual([]);
    expect(parseMemexIndex("# Just a heading\n")).toEqual([]);
  });

  it("--no-memex skips memex query; meta.memexQueried absent", async () => {
    writeConfig();
    writeIndex({});
    writeBook({ version: 2, chronicles: {}, topics: {}, cards: {} });

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src", noMemex: true });
    expect(out.meta.memexQueried).toBeUndefined();
    expect(out.entries.filter((e) => e.kind === "memex-card")).toEqual([]);
  });
});

function entry(id: string, project: string, projectRaw: string) {
  return {
    sessionId: id, shortId: id.slice(0, 8), tool: "claude", project,
    projectRaw,
    startedAt: "2026-01-01T10:00:00Z", endedAt: "2026-01-01T11:00:00Z",
    nameSlug: "x", displayName: "x",
    relativePath: `raw_sessions/claude/${project}/2026-01-01/x__${id}.raw.json`,
    sourcePath: "/x.jsonl", sourceMtimeMs: 1, sourceSha256: "abc",
  };
}
