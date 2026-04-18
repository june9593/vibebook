import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAPTER_VERSION,
  chapterNeedsRewrite,
  computeChapterArticleHash,
  generateChapter,
} from "../../src/digest/chapter.js";
import type { BookIndex, BookEntry, ChapterEntry } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";

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

function fakeRunner(impl: LlmRunner["run"]): LlmRunner {
  return { run: impl };
}

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-chapter-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("computeChapterArticleHash", () => {
  it("is order-independent (sort by threadId ASC internally)", () => {
    const a = computeChapterArticleHash([
      { threadId: "z", articleVersion: 1, latestSourceSha: "aa" },
      { threadId: "a", articleVersion: 1, latestSourceSha: "bb" },
    ]);
    const b = computeChapterArticleHash([
      { threadId: "a", articleVersion: 1, latestSourceSha: "bb" },
      { threadId: "z", articleVersion: 1, latestSourceSha: "aa" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when any article's source sha changes", () => {
    const before = computeChapterArticleHash([
      { threadId: "a", articleVersion: 1, latestSourceSha: "x" },
    ]);
    const after = computeChapterArticleHash([
      { threadId: "a", articleVersion: 1, latestSourceSha: "y" },
    ]);
    expect(before).not.toBe(after);
  });

  it("changes when any article's articleVersion changes", () => {
    const before = computeChapterArticleHash([
      { threadId: "a", articleVersion: 1, latestSourceSha: "x" },
    ]);
    const after = computeChapterArticleHash([
      { threadId: "a", articleVersion: 2, latestSourceSha: "x" },
    ]);
    expect(before).not.toBe(after);
  });

  it("empty list still yields a stable hash", () => {
    expect(computeChapterArticleHash([])).toEqual(computeChapterArticleHash([]));
  });
});

describe("chapterNeedsRewrite", () => {
  it("returns true for a project that has articles but no ChapterEntry", () => {
    const idx: BookIndex = {
      version: 1,
      threads: { t1: entry({ project: "p", threadId: "t1" }) },
      chapters: {},
    };
    expect(chapterNeedsRewrite(idx, "p")).toBe(true);
  });

  it("returns false when latestArticleHash already matches the current articles", () => {
    const summaries = [{ threadId: "t1", articleVersion: 1, latestSourceSha: "deadbeef" }];
    const hash = computeChapterArticleHash(summaries);
    const idx: BookIndex = {
      version: 1,
      threads: { t1: entry({ project: "p", threadId: "t1" }) },
      chapters: { p: chapter({ latestArticleHash: hash }) },
    };
    expect(chapterNeedsRewrite(idx, "p")).toBe(false);
  });

  it("returns true when an article's latestSourceSha changed since last rewrite", () => {
    const idx: BookIndex = {
      version: 1,
      threads: { t1: entry({ project: "p", threadId: "t1", latestSourceSha: "newsha" }) },
      chapters: { p: chapter({ latestArticleHash: "stalehash" }) },
    };
    expect(chapterNeedsRewrite(idx, "p")).toBe(true);
  });

  it("returns false when the project has no publishable articles AND no chapter entry", () => {
    const idx: BookIndex = {
      version: 1,
      threads: { sk: entry({ project: "p", threadId: "sk", skip: true, articlePath: "" }) },
      chapters: {},
    };
    expect(chapterNeedsRewrite(idx, "p")).toBe(false);
  });

  it("excludes failed and skipped articles from the hash basis", () => {
    const okOnly = computeChapterArticleHash([
      { threadId: "ok", articleVersion: 1, latestSourceSha: "x" },
    ]);
    const idx: BookIndex = {
      version: 1,
      threads: {
        ok: entry({ project: "p", threadId: "ok", latestSourceSha: "x" }),
        sk: entry({ project: "p", threadId: "sk", skip: true, articlePath: "" }),
        fa: entry({ project: "p", threadId: "fa", articleStatus: "failed", articlePath: "" }),
      },
      chapters: { p: chapter({ latestArticleHash: okOnly }) },
    };
    expect(chapterNeedsRewrite(idx, "p")).toBe(false);
  });
});

describe("generateChapter — happy path", () => {
  it("writes book/<project>/chapter.md and updates ChapterEntry", async () => {
    // Pre-create an article on disk so its body is read into the prompt.
    mkdirSync(join(repoRoot, "book/proj-a/articles"), { recursive: true });
    writeFileSync(
      join(repoRoot, "book/proj-a/articles/2026-04-15__t1__t1.md"),
      "# 第一篇\n\n内容...",
    );
    const runner = fakeRunner(async (prompt, vars) => {
      // Sanity: vars.articles must reference the article we placed.
      expect(vars.articles).toContain("第一篇");
      expect(prompt).toContain("章前言");
      return { ok: true, text: "# proj-a\n\n章前言正文。", durationMs: 10 } satisfies RunResult;
    });

    const idx: BookIndex = {
      version: 1,
      threads: { t1: entry({ project: "proj-a", threadId: "t1" }) },
      chapters: {},
    };
    const res = await generateChapter(runner, repoRoot, "proj-a", idx);
    expect(res).toEqual({ status: "ok", chapterPath: "book/proj-a/chapter.md" });

    const written = readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8");
    expect(written).toBe("# proj-a\n\n章前言正文。");

    const ch = idx.chapters["proj-a"]!;
    expect(ch.chapterVersion).toBe(CHAPTER_VERSION);
    expect(ch.lastFullRewrite).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ch.latestArticleHash).toBe(
      computeChapterArticleHash([
        { threadId: "t1", articleVersion: 1, latestSourceSha: "deadbeef" },
      ]),
    );
  });

  it("orders articles in the prompt newest-first by updatedAt (matches spec '新到旧')", async () => {
    mkdirSync(join(repoRoot, "book/p/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/p/articles/old.md"), "# 旧文\n");
    writeFileSync(join(repoRoot, "book/p/articles/new.md"), "# 新文\n");
    let captured = "";
    const runner = fakeRunner(async (_prompt, vars) => {
      captured = vars.articles;
      return { ok: true, text: "# p\n", durationMs: 1 };
    });
    const idx: BookIndex = {
      version: 1,
      threads: {
        old: entry({
          project: "p", threadId: "old",
          articlePath: "book/p/articles/old.md",
          updatedAt: "2026-04-10T00:00:00Z",
        }),
        new: entry({
          project: "p", threadId: "new",
          articlePath: "book/p/articles/new.md",
          updatedAt: "2026-04-20T00:00:00Z",
        }),
      },
      chapters: {},
    };
    await generateChapter(runner, repoRoot, "p", idx);
    expect(captured.indexOf("新文")).toBeLessThan(captured.indexOf("旧文"));
  });

  it("excludes skipped and failed articles from the prompt and the hash basis", async () => {
    mkdirSync(join(repoRoot, "book/p/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/p/articles/ok.md"), "# OK 文\n");
    let captured = "";
    const runner = fakeRunner(async (_p, vars) => {
      captured = vars.articles;
      return { ok: true, text: "# p", durationMs: 1 };
    });
    const idx: BookIndex = {
      version: 1,
      threads: {
        ok: entry({
          project: "p", threadId: "ok",
          articlePath: "book/p/articles/ok.md",
        }),
        sk: entry({ project: "p", threadId: "sk", skip: true, articlePath: "" }),
        fa: entry({
          project: "p", threadId: "fa",
          articleStatus: "failed", articlePath: "",
        }),
      },
      chapters: {},
    };
    const res = await generateChapter(runner, repoRoot, "p", idx);
    expect(res.status).toBe("ok");
    expect(captured).toContain("OK 文");
    expect(captured).not.toContain("sk");
    expect(captured).not.toContain("fa");
    expect(idx.chapters["p"]!.latestArticleHash).toBe(
      computeChapterArticleHash([
        { threadId: "ok", articleVersion: 1, latestSourceSha: "deadbeef" },
      ]),
    );
  });
});

describe("generateChapter — empty project", () => {
  it("returns no-articles and does not write a file or upsert", async () => {
    const runner = fakeRunner(async () => {
      throw new Error("runner should not be called");
    });
    const idx: BookIndex = {
      version: 1,
      threads: { sk: entry({ project: "p", threadId: "sk", skip: true, articlePath: "" }) },
      chapters: {},
    };
    const res = await generateChapter(runner, repoRoot, "p", idx);
    expect(res).toEqual({ status: "no-articles" });
    expect(existsSync(join(repoRoot, "book/p/chapter.md"))).toBe(false);
    expect(idx.chapters["p"]).toBeUndefined();
  });
});

describe("generateChapter — failure isolation", () => {
  it("preserves the previous chapter.md and ChapterEntry when the runner returns ok:false", async () => {
    // Pre-existing chapter.md and ChapterEntry from a previous successful run.
    mkdirSync(join(repoRoot, "book/p/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/p/chapter.md"), "# p\n\n旧版本");
    writeFileSync(join(repoRoot, "book/p/articles/t1.md"), "# 文章\n");
    const prev: ChapterEntry = {
      chapterVersion: 1,
      lastFullRewrite: "2026-04-10T00:00:00Z",
      latestArticleHash: "previous-hash",
    };
    const idx: BookIndex = {
      version: 1,
      threads: {
        t1: entry({ project: "p", threadId: "t1", articlePath: "book/p/articles/t1.md" }),
      },
      chapters: { p: prev },
    };
    const runner = fakeRunner(async () => ({ ok: false, error: "timeout", durationMs: 5 }));
    const res = await generateChapter(runner, repoRoot, "p", idx);
    expect(res).toEqual({ status: "failed", error: "timeout" });
    expect(readFileSync(join(repoRoot, "book/p/chapter.md"), "utf8")).toBe("# p\n\n旧版本");
    expect(idx.chapters["p"]).toEqual(prev);
  });

  it("does not throw when the runner throws — converts to failed status", async () => {
    mkdirSync(join(repoRoot, "book/p/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/p/articles/t1.md"), "# x\n");
    const idx: BookIndex = {
      version: 1,
      threads: {
        t1: entry({ project: "p", threadId: "t1", articlePath: "book/p/articles/t1.md" }),
      },
      chapters: {},
    };
    const runner = fakeRunner(async () => {
      throw new Error("network exploded");
    });
    const res = await generateChapter(runner, repoRoot, "p", idx);
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toBe("network exploded");
    expect(idx.chapters["p"]).toBeUndefined();
  });

  it("returns failed (not throw) when an article file is missing on disk", async () => {
    // Article entry references a file that doesn't exist — IO error during read.
    const runner = fakeRunner(async () => ({ ok: true, text: "# p\n", durationMs: 1 }));
    const idx: BookIndex = {
      version: 1,
      threads: {
        t1: entry({
          project: "p", threadId: "t1",
          articlePath: "book/p/articles/missing.md",
        }),
      },
      chapters: {},
    };
    const res = await generateChapter(runner, repoRoot, "p", idx);
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toMatch(/missing\.md/);
    expect(idx.chapters["p"]).toBeUndefined();
  });
});
