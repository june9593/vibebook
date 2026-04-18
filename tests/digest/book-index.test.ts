import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBookIndex,
  saveBookIndex,
  upsertThread,
  upsertChapter,
  latestSourceShaFor,
  type BookIndex,
  type BookEntry,
} from "../../src/digest/book-index.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "memvc-book-"));
}

describe("loadBookIndex", () => {
  it("returns an empty skeleton when no file exists", () => {
    const repo = tmpRepo();
    const idx = loadBookIndex(repo);
    expect(idx.version).toBe(1);
    expect(idx.threads).toEqual({});
    expect(idx.chapters).toEqual({});
  });

  it("round-trips through saveBookIndex", () => {
    const repo = tmpRepo();
    const idx: BookIndex = {
      version: 1,
      threads: {
        t1: {
          threadId: "t1",
          project: "proj-a",
          title: "标题",
          sessionIds: ["s1", "s2"],
          articlePath: "book/proj-a/articles/2026-04-18__t1__abcd1234.md",
          articleVersion: 1,
          latestSourceSha: "deadbeef",
          articleStatus: "ok",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
      },
      chapters: {
        "proj-a": {
          chapterVersion: 1,
          lastFullRewrite: "2026-04-18T00:00:00.000Z",
          latestArticleHash: "feedface",
        },
      },
    };
    saveBookIndex(repo, idx);
    expect(existsSync(join(repo, ".memvc/index.book.json"))).toBe(true);
    const loaded = loadBookIndex(repo);
    expect(loaded).toEqual(idx);
  });

  it("throws on unsupported version", () => {
    const repo = tmpRepo();
    saveBookIndex(repo, { version: 1, threads: {}, chapters: {} });
    const path = join(repo, ".memvc/index.book.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.version = 99;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => loadBookIndex(repo)).toThrow(/version/);
  });
});

describe("upsertThread", () => {
  it("inserts a new thread and overwrites an existing one by threadId", () => {
    const idx: BookIndex = { version: 1, threads: {}, chapters: {} };
    const e: BookEntry = {
      threadId: "fix-bug",
      project: "p",
      title: "修 bug",
      sessionIds: ["s1"],
      articlePath: "book/p/articles/x.md",
      articleVersion: 1,
      latestSourceSha: "aaa",
      articleStatus: "ok",
      updatedAt: "2026-04-18T00:00:00.000Z",
    };
    upsertThread(idx, e);
    expect(idx.threads["fix-bug"]).toEqual(e);

    const e2: BookEntry = { ...e, sessionIds: ["s1", "s2"], latestSourceSha: "bbb" };
    upsertThread(idx, e2);
    expect(idx.threads["fix-bug"].sessionIds).toEqual(["s1", "s2"]);
    expect(idx.threads["fix-bug"].latestSourceSha).toBe("bbb");
    expect(Object.keys(idx.threads).length).toBe(1);
  });
});

describe("upsertChapter", () => {
  it("creates and updates chapter entries by project key", () => {
    const idx: BookIndex = { version: 1, threads: {}, chapters: {} };
    upsertChapter(idx, "proj-a", { chapterVersion: 1, lastFullRewrite: "t1", latestArticleHash: "h1" });
    expect(idx.chapters["proj-a"].latestArticleHash).toBe("h1");
    upsertChapter(idx, "proj-a", { chapterVersion: 2, lastFullRewrite: "t2", latestArticleHash: "h2" });
    expect(idx.chapters["proj-a"]).toEqual({ chapterVersion: 2, lastFullRewrite: "t2", latestArticleHash: "h2" });
  });
});

describe("latestSourceShaFor", () => {
  it("hashes the concatenation of session shas in input order", () => {
    const a = latestSourceShaFor(["sha-1", "sha-2", "sha-3"]);
    const b = latestSourceShaFor(["sha-1", "sha-2", "sha-3"]);
    const c = latestSourceShaFor(["sha-2", "sha-1", "sha-3"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a stable empty-input hash", () => {
    expect(latestSourceShaFor([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
