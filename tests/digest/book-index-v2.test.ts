import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBookIndexV2, saveBookIndexV2,
  insertChronicle, upsertTopic, upsertCard,
  topicKey, cardKey,
  type BookIndexV2, type ChronicleEntry, type TopicEntry, type CardEntry,
} from "../../src/digest/book-index-v2.js";
import { BOOK_INDEX_REL } from "../../src/repo-data-dir.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vibebook-bi2-"));
});

function writeIndex(content: unknown) {
  const p = join(repo, BOOK_INDEX_REL);
  mkdirSync(join(repo, ".vibebook"), { recursive: true });
  writeFileSync(p, JSON.stringify(content, null, 2));
}

describe("loadBookIndexV2 — fresh repo", () => {
  it("returns empty v2 when index file missing", () => {
    const idx = loadBookIndexV2(repo);
    expect(idx.version).toBe(2);
    expect(Object.keys(idx.chronicles)).toEqual([]);
    expect(Object.keys(idx.topics)).toEqual([]);
    expect(Object.keys(idx.cards)).toEqual([]);
  });
});

describe("loadBookIndexV2 — v2 round-trip", () => {
  it("loads and saves v2 schema unchanged", () => {
    const v2: BookIndexV2 = {
      version: 2,
      chronicles: {
        "fix-foo": {
          threadId: "fix-foo", project: "edge-src", title: "Fix foo",
          sessionIds: ["abc12345"], path: "book/edge-src/chronicle/x.md",
          createdAt: "2026-04-01", updatedAt: "2026-04-02", tags: ["foo"],
        },
      },
      topics: {},
      cards: {},
    };
    saveBookIndexV2(repo, v2);
    expect(loadBookIndexV2(repo)).toEqual(v2);
  });
});

describe("loadBookIndexV2 — v1 migration", () => {
  it("migrates v1 threads → v2 chronicles, drops chapters, backs up old file", () => {
    const v1 = {
      version: 1,
      threads: {
        "fix-bug-a": {
          threadId: "fix-bug-a", project: "edge-src", title: "Fix bug A",
          sessionIds: ["sess-a"],
          articlePath: "book/edge-src/articles/2026-04-01__fix-bug-a__fix-bug-.md",
          articleVersion: 2, articleStatus: "ok", latestSourceSha: "sha1",
          updatedAt: "2026-04-01T10:00:00Z",
        },
        "say-hi-1": {
          threadId: "say-hi-1", project: "home", title: "say hi",
          sessionIds: ["sess-h"],
          articlePath: "", articleVersion: 2, articleStatus: "ok",
          latestSourceSha: "sha2", updatedAt: "2026-04-02T10:00:00Z",
          skip: true, skipReason: "no substance",
        },
      },
      chapters: { "edge-src": { chapterVersion: 1, lastFullRewrite: "2026-04-01T10:00:00Z", latestArticleHash: "h" } },
    };
    writeIndex(v1);
    const idx = loadBookIndexV2(repo);
    expect(idx.version).toBe(2);
    expect(Object.keys(idx.chronicles).sort()).toEqual(["fix-bug-a", "say-hi-1"]);
    const fixBug = idx.chronicles["fix-bug-a"];
    expect(fixBug.project).toBe("edge-src");
    expect(fixBug.title).toBe("Fix bug A");
    expect(fixBug.path).toContain("book/edge-src/articles/");
    expect(fixBug.skip).toBeUndefined();
    const sayHi = idx.chronicles["say-hi-1"];
    expect(sayHi.skip).toBe(true);
    expect(sayHi.skipReason).toBe("no substance");
    expect(idx.topics).toEqual({});
    expect(idx.cards).toEqual({});
    // backup created
    expect(existsSync(join(repo, BOOK_INDEX_REL + ".v1.bak"))).toBe(true);
    // and the on-disk file is now v2
    const onDisk = JSON.parse(readFileSync(join(repo, BOOK_INDEX_REL), "utf8"));
    expect(onDisk.version).toBe(2);
  });
});

describe("loadBookIndexV2 — schema validation", () => {
  it("throws on unknown version", () => {
    writeIndex({ version: 99, chronicles: {}, topics: {}, cards: {} });
    expect(() => loadBookIndexV2(repo)).toThrow(/unsupported book index version/);
  });
  it("throws on v2 missing chronicles key", () => {
    writeIndex({ version: 2, topics: {}, cards: {} });
    expect(() => loadBookIndexV2(repo)).toThrow(/missing 'chronicles'/);
  });
  it("throws on v2 missing topics key", () => {
    writeIndex({ version: 2, chronicles: {}, cards: {} });
    expect(() => loadBookIndexV2(repo)).toThrow(/missing 'topics'/);
  });
});

describe("insertChronicle", () => {
  it("inserts a new chronicle by threadId", () => {
    const idx: BookIndexV2 = { version: 2, chronicles: {}, topics: {}, cards: {} };
    const c: ChronicleEntry = {
      threadId: "x", project: "p", title: "X", sessionIds: [],
      path: "book/p/chronicle/x.md", createdAt: "d", updatedAt: "d", tags: [],
    };
    insertChronicle(idx, c);
    expect(idx.chronicles["x"]).toEqual(c);
  });
  it("throws on threadId collision (chronicles are insert-only)", () => {
    const idx: BookIndexV2 = { version: 2, chronicles: {}, topics: {}, cards: {} };
    const c: ChronicleEntry = {
      threadId: "x", project: "p", title: "X", sessionIds: [],
      path: "book/p/chronicle/x.md", createdAt: "d", updatedAt: "d", tags: [],
    };
    insertChronicle(idx, c);
    expect(() => insertChronicle(idx, c)).toThrow(/already exists/);
  });
});

describe("upsertTopic — composite key (project, slug)", () => {
  it("same slug across projects stays separate", () => {
    const idx: BookIndexV2 = { version: 2, chronicles: {}, topics: {}, cards: {} };
    const a: TopicEntry = {
      topicSlug: "fullscreen", project: "edge-src", path: "book/edge-src/topics/fullscreen.md",
      createdAt: "d", updatedAt: "d", contributingThreads: [],
    };
    const b: TopicEntry = { ...a, project: "chromium-src", path: "book/chromium-src/topics/fullscreen.md" };
    upsertTopic(idx, a);
    upsertTopic(idx, b);
    expect(Object.keys(idx.topics).sort()).toEqual([
      topicKey("chromium-src", "fullscreen"),
      topicKey("edge-src", "fullscreen"),
    ]);
  });
});

describe("upsertCard — _global allowed", () => {
  it("inserts a _global card under composite key", () => {
    const idx: BookIndexV2 = { version: 2, chronicles: {}, topics: {}, cards: {} };
    const c: CardEntry = {
      cardSlug: "gotcha-foo", project: "_global", type: "gotcha",
      path: "book/_global/cards/gotcha-foo.md",
      createdAt: "d", updatedAt: "d", tags: [],
    };
    upsertCard(idx, c);
    expect(idx.cards[cardKey("_global", "gotcha-foo")]).toEqual(c);
  });
});
