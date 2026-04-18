import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToc } from "../../src/digest/toc.js";
import type { BookIndex, BookEntry, ChapterEntry } from "../../src/digest/book-index.js";

function entry(over: Partial<BookEntry> = {}): BookEntry {
  return {
    threadId: "t1",
    project: "proj-a",
    title: "标题",
    sessionIds: ["s1"],
    articlePath: "book/proj-a/articles/2026-04-15__t1__t1.md",
    articleVersion: 1,
    latestSourceSha: "deadbeef",
    articleStatus: "ok",
    updatedAt: "2026-04-15T10:00:00Z",
    ...over,
  };
}

function chapter(over: Partial<ChapterEntry> = {}): ChapterEntry {
  return { chapterVersion: 1, lastFullRewrite: "2026-04-15T10:00:00Z", latestArticleHash: "x", ...over };
}

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-toc-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("generateToc — empty index", () => {
  it("writes a front page and an empty global timeline", () => {
    const idx: BookIndex = { version: 1, threads: {}, chapters: {} };
    const res = generateToc(repoRoot, idx);
    expect(res.written.sort()).toEqual(["book/_meta/timeline.md", "book/index.md"]);
    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    expect(front).toContain("# 笔记本");
    expect(front).toContain("共 0 章，0 篇文章");
    expect(front).toContain("[全局时间线](_meta/timeline.md)");
    const tl = readFileSync(join(repoRoot, "book/_meta/timeline.md"), "utf8");
    expect(tl).toContain("# 全局时间线");
    expect(tl).toContain("| 时间 | 项目 | 标题 | 文章 |");
    // No data rows — only header and separator.
    expect(tl.split("\n").filter((l) => l.startsWith("|")).length).toBe(2);
  });
});

describe("generateToc — happy path with two chapters", () => {
  it("writes front page, global timeline, and one per-chapter timeline per non-empty project", () => {
    const idx: BookIndex = {
      version: 1,
      threads: {
        a1: entry({
          threadId: "a1", project: "proj-a", title: "A 第一篇",
          articlePath: "book/proj-a/articles/2026-04-15__a1__a1.md",
          updatedAt: "2026-04-15T10:00:00Z",
        }),
        a2: entry({
          threadId: "a2", project: "proj-a", title: "A 第二篇",
          articlePath: "book/proj-a/articles/2026-04-16__a2__a2.md",
          updatedAt: "2026-04-16T10:00:00Z",
        }),
        b1: entry({
          threadId: "b1", project: "proj-b", title: "B 第一篇",
          articlePath: "book/proj-b/articles/2026-04-17__b1__b1.md",
          updatedAt: "2026-04-17T10:00:00Z",
        }),
      },
      chapters: { "proj-a": chapter(), "proj-b": chapter() },
    };

    const res = generateToc(repoRoot, idx);
    expect(res.written.sort()).toEqual([
      "book/_meta/timeline.md",
      "book/index.md",
      "book/proj-a/timeline.md",
      "book/proj-b/timeline.md",
    ]);

    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    expect(front).toContain("共 2 章，3 篇文章");
    // Alphabetical project order.
    const aIdx = front.indexOf("[proj-a](proj-a/)");
    const bIdx = front.indexOf("[proj-b](proj-b/)");
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(front).toContain("[proj-a](proj-a/) — 2 篇文章");
    expect(front).toContain("[proj-b](proj-b/) — 1 篇文章");

    const global = readFileSync(join(repoRoot, "book/_meta/timeline.md"), "utf8");
    // Newest-first: b1 (2026-04-17), a2 (2026-04-16), a1 (2026-04-15).
    const b1Pos = global.indexOf("B 第一篇");
    const a2Pos = global.indexOf("A 第二篇");
    const a1Pos = global.indexOf("A 第一篇");
    expect(b1Pos).toBeGreaterThan(0);
    expect(a2Pos).toBeGreaterThan(b1Pos);
    expect(a1Pos).toBeGreaterThan(a2Pos);
    // Link is relative to book/_meta/.
    expect(global).toContain("../proj-b/articles/2026-04-17__b1__b1.md");

    const chA = readFileSync(join(repoRoot, "book/proj-a/timeline.md"), "utf8");
    expect(chA).toContain("# proj-a · 时间线");
    // Newest-first within proj-a: a2 then a1.
    expect(chA.indexOf("A 第二篇")).toBeLessThan(chA.indexOf("A 第一篇"));
    // Per-chapter link is relative to book/proj-a/.
    expect(chA).toContain("articles/2026-04-15__a1__a1.md");
    expect(chA).not.toContain("../");
  });
});

describe("generateToc — skipped and failed threads", () => {
  it("excludes skipped and failed threads from timelines and from chapter article counts", () => {
    const idx: BookIndex = {
      version: 1,
      threads: {
        ok: entry({
          threadId: "ok", project: "p", title: "成功",
          articlePath: "book/p/articles/2026-04-15__ok__ok.md",
          updatedAt: "2026-04-15T10:00:00Z",
        }),
        sk: entry({
          threadId: "sk", project: "p", title: "略过",
          articlePath: "", skip: true, skipReason: "太短",
          updatedAt: "2026-04-15T11:00:00Z",
        }),
        fa: entry({
          threadId: "fa", project: "p", title: "失败",
          articlePath: "", articleStatus: "failed", articleError: "timeout",
          updatedAt: "2026-04-15T12:00:00Z",
        }),
      },
      chapters: { p: chapter() },
    };
    const res = generateToc(repoRoot, idx);
    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    // 1 OK article, 1 failed flagged, skipped silently dropped.
    expect(front).toContain("共 1 章，1 篇文章, 1 篇失败");
    expect(front).toContain("[p](p/) — 1 篇文章");

    const global = readFileSync(join(repoRoot, "book/_meta/timeline.md"), "utf8");
    expect(global).toContain("成功");
    expect(global).not.toContain("略过");
    expect(global).not.toContain("失败");

    const chP = readFileSync(join(repoRoot, "book/p/timeline.md"), "utf8");
    expect(chP).toContain("成功");
    expect(chP).not.toContain("略过");
    expect(chP).not.toContain("失败");
    // res.written should include the per-chapter timeline because there's 1 OK article.
    expect(res.written).toContain("book/p/timeline.md");
  });

  it("does NOT write a per-chapter timeline file when the chapter has zero ok+non-skipped articles", () => {
    const idx: BookIndex = {
      version: 1,
      threads: {
        sk: entry({ threadId: "sk", project: "p", articlePath: "", skip: true, skipReason: "x" }),
      },
      chapters: { p: chapter() },
    };
    const res = generateToc(repoRoot, idx);
    expect(existsSync(join(repoRoot, "book/p/timeline.md"))).toBe(false);
    expect(res.written).not.toContain("book/p/timeline.md");
    // Front page still lists the chapter (it exists in chapters), with 0 articles.
    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    expect(front).toContain("[p](p/) — 0 篇文章");
  });
});

describe("generateToc — chapter set is union of chapters keys and project field", () => {
  it("lists a project that has articles but no chapters entry", () => {
    const idx: BookIndex = {
      version: 1,
      threads: {
        t: entry({ threadId: "t", project: "stray-proj", articlePath: "book/stray-proj/articles/x.md" }),
      },
      chapters: {},
    };
    const res = generateToc(repoRoot, idx);
    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    expect(front).toContain("[stray-proj](stray-proj/) — 1 篇文章");
    expect(res.written).toContain("book/stray-proj/timeline.md");
  });

  it("lists a chapter that has no articles yet", () => {
    const idx: BookIndex = {
      version: 1,
      threads: {},
      chapters: { "lone-chapter": chapter() },
    };
    const res = generateToc(repoRoot, idx);
    const front = readFileSync(join(repoRoot, "book/index.md"), "utf8");
    expect(front).toContain("[lone-chapter](lone-chapter/) — 0 篇文章");
    expect(res.written).not.toContain("book/lone-chapter/timeline.md");
  });
});

describe("generateToc — sort determinism on tie", () => {
  it("breaks updatedAt ties by threadId ascending", () => {
    const t = "2026-04-15T10:00:00Z";
    const idx: BookIndex = {
      version: 1,
      threads: {
        zzz: entry({ threadId: "zzz", title: "Z", articlePath: "book/proj-a/articles/zzz.md", updatedAt: t }),
        aaa: entry({ threadId: "aaa", title: "A", articlePath: "book/proj-a/articles/aaa.md", updatedAt: t }),
      },
      chapters: { "proj-a": chapter() },
    };
    generateToc(repoRoot, idx);
    const global = readFileSync(join(repoRoot, "book/_meta/timeline.md"), "utf8");
    // Same updatedAt → secondary sort by threadId ASC, but timeline is NEWEST-first;
    // the secondary sort is for determinism only. We assert aaa comes before zzz.
    expect(global.indexOf("| A |")).toBeLessThan(global.indexOf("| Z |"));
  });
});
