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

describe("recall — basic catalog", () => {
  it("returns chronicle / topic / card entries with title + summary + path", async () => {
    writeConfig();
    writeIndex({
      "claude:s1": entry("s1", "edge-src", "/Users/me/edge/src"),
    });
    writeBook({
      version: 2,
      chronicles: {
        "fix-foo": {
          threadId: "fix-foo", project: "edge-src", title: "Fix foo bug",
          sessionIds: ["s1"], path: "book/edge-src/chronicle/2026-01-01__fix-foo__fix-foo.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: ["bug"],
        },
      },
      topics: {
        "edge-src/menu-bar": {
          topicSlug: "menu-bar", project: "edge-src",
          path: "book/edge-src/topics/menu-bar.md",
          createdAt: "2026-01-02", updatedAt: "2026-01-02", contributingThreads: ["fix-foo"],
        },
      },
      cards: {
        "edge-src/gotcha-rounded-corners": {
          cardSlug: "gotcha-rounded-corners", project: "edge-src", type: "gotcha",
          path: "book/edge-src/cards/gotcha-rounded-corners.md",
          createdAt: "2026-01-03", updatedAt: "2026-01-03", tags: ["macos"],
        },
      },
    });
    writeArtifact("book/edge-src/chronicle/2026-01-01__fix-foo__fix-foo.md",
      "# Fix foo bug\n\n## What\n\n这是修复 foo bug 的工作记录,涉及 NSWindow 圆角问题。\n");
    writeArtifact("book/edge-src/topics/menu-bar.md",
      "# Edge macOS Menu Bar Copilot\n\n## 这个 topic 是什么\n\nEdge 把菜单栏 Copilot 入口移植到 Mac。\n");
    writeArtifact("book/edge-src/cards/gotcha-rounded-corners.md",
      "Chromium views frameless NSWindow 圆角必须等于内容圆角,否则 DCHECK 挂。\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });

    expect(out.project).toBe("edge-src");
    expect(out.meta).toEqual({ chronicles: 1, topics: 1, cards: 1 });

    // Sort: cards → topics → chronicles
    expect(out.entries[0]!.kind).toBe("card");
    expect(out.entries[1]!.kind).toBe("topic");
    expect(out.entries[2]!.kind).toBe("chronicle");

    const card = out.entries[0]!;
    expect(card.title).toBe("Rounded corners");
    expect(card.summary).toContain("Chromium views frameless");
    expect(card.cardType).toBe("gotcha");
    expect(card.path).toBe("book/edge-src/cards/gotcha-rounded-corners.md");

    const chronicle = out.entries[2]!;
    expect(chronicle.title).toBe("Fix foo bug");
    expect(chronicle.summary).toContain("修复 foo bug");
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

describe("recall — _global cards", () => {
  it("includes _global cards alongside project cards by default", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2, chronicles: {}, topics: {},
      cards: {
        "edge-src/g1": {
          cardSlug: "gotcha-x", project: "edge-src", type: "gotcha",
          path: "book/edge-src/cards/gotcha-x.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
        "_global/g2": {
          cardSlug: "howto-git-rebase", project: "_global", type: "howto",
          path: "book/_global/cards/howto-git-rebase.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
      },
    });
    writeArtifact("book/edge-src/cards/gotcha-x.md", "x\n");
    writeArtifact("book/_global/cards/howto-git-rebase.md", "rebase tip\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });
    expect(out.meta.cards).toBe(2);
    const projects = out.entries.map((e) => e.project).sort();
    expect(projects).toEqual(["_global", "edge-src"]);
  });

  it("excludes _global cards when --no-global", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2, chronicles: {}, topics: {},
      cards: {
        "_global/g": {
          cardSlug: "howto-x", project: "_global", type: "howto",
          path: "book/_global/cards/howto-x.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
      },
    });
    writeArtifact("book/_global/cards/howto-x.md", "x\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src", includeGlobalCards: false });
    expect(out.entries.length).toBe(0);
  });
});

describe("recall — title + summary extraction fallbacks", () => {
  it("falls back to prettified slug when no # heading + no frontmatter", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2, chronicles: {}, topics: {},
      cards: {
        "edge-src/gotcha-some-tricky-bug": {
          cardSlug: "gotcha-some-tricky-bug", project: "edge-src", type: "gotcha",
          path: "book/edge-src/cards/gotcha-some-tricky-bug.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
      },
    });
    writeArtifact("book/edge-src/cards/gotcha-some-tricky-bug.md",
      "Body without any heading. Just one paragraph describing the issue.\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });
    expect(out.entries[0]!.title).toBe("Some tricky bug");
    expect(out.entries[0]!.summary).toBe("Body without any heading. Just one paragraph describing the issue.");
  });

  it("strips wikilinks + markdown links from summary preview", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2, chronicles: {}, topics: {},
      cards: {
        "edge-src/c1": {
          cardSlug: "gotcha-c1", project: "edge-src", type: "gotcha",
          path: "book/edge-src/cards/gotcha-c1.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
      },
    });
    writeArtifact("book/edge-src/cards/gotcha-c1.md",
      "See [[gotcha-foo]] and [link](path/to.md) for context. Real insight here.\n");

    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });
    expect(out.entries[0]!.summary).toBe("See gotcha-foo and link for context. Real insight here.");
  });

  it("infers cardType from slug prefix when BookIndex omits it", async () => {
    writeConfig();
    writeIndex({});
    writeBook({
      version: 2, chronicles: {}, topics: {},
      cards: {
        "edge-src/pattern-foo": {
          cardSlug: "pattern-foo", project: "edge-src",
          // type intentionally missing — legacy publish bug
          path: "book/edge-src/cards/pattern-foo.md",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [],
        },
      },
    });
    writeArtifact("book/edge-src/cards/pattern-foo.md", "foo pattern\n");
    const { buildRecallPayload } = await import("../../src/commands/recall.js");
    const out = buildRecallPayload({ project: "edge-src" });
    expect(out.entries[0]!.cardType).toBe("pattern");
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
