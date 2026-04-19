import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigest } from "../../src/digest/orchestrator.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-orch-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function ie(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    sessionId: "sid-1",
    shortId: "sid-1",
    tool: "claude" as Tool,
    project: "proj-a",
    startedAt: "2026-04-15T09:00:00Z",
    endedAt: "2026-04-15T10:00:00Z",
    nameSlug: "first",
    displayName: "First",
    relativePath: "raw_sessions/c/proj-a/2026-04-15/first__sid-1.md",
    sourcePath: "/tmp/x.jsonl",
    sourceMtimeMs: 1,
    sourceSha256: "shaA",
    ...over,
  };
}

function makeIndex(entries: IndexEntry[]): IndexFile {
  const out: IndexFile = { version: 1, entries: {} };
  for (const e of entries) out.entries[`${e.tool}:${e.sessionId}`] = e;
  return out;
}

function writeSessionMd(rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * Build a fake runner driven by a queue of canned responses. Each runner.run
 * call shifts one off the queue. Tests can also pass a function for finer
 * control (e.g. inspect prompt, return computed text).
 */
type CannedReply = RunResult | ((prompt: string, vars: Record<string, string>) => Promise<RunResult> | RunResult);
function makeRunner(replies: CannedReply[]): { runner: LlmRunner; calls: { prompt: string; vars: Record<string, string> }[] } {
  const calls: { prompt: string; vars: Record<string, string> }[] = [];
  const queue = [...replies];
  const runner: LlmRunner = {
    async run(prompt, vars) {
      calls.push({ prompt, vars });
      const next = queue.shift();
      if (!next) throw new Error(`fake runner: no more canned replies (call #${calls.length})`);
      if (typeof next === "function") return await next(prompt, vars);
      return next;
    },
  };
  return { runner, calls };
}

// =====================================================================
describe("runDigest — empty input", () => {
  it("with no IndexFile entries: no LLM calls, runs toc only, returns zero counts", async () => {
    const idx: IndexFile = { version: 1, entries: {} };
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const { runner, calls } = makeRunner([]);
    const r = await runDigest(runner, repoRoot, idx, book, null);
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({
      newSessions: 0,
      threadCandidates: 0,
      threadsSkipped: 0,
      articlesOk: 0,
      articlesFailed: 0,
      chaptersRewritten: [],
    });
    // Toc still runs.
    expect(r.tocFilesWritten).toContain("book/index.md");
    expect(existsSync(join(repoRoot, "book/index.md"))).toBe(true);
  });
});

// =====================================================================
describe("runDigest — happy path: one new session → one thread → one article → one chapter → toc", () => {
  it("walks all phases and updates BookIndex + writes files", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "session body content here");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };

    const { runner, calls } = makeRunner([
      // Threading call: returns one candidate.
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-happy", title: "成功", sessionIds: ["s1"] },
      ])},
      // Article call: returns markdown.
      { ok: true, durationMs: 1, text: "# 成功\n\n文章正文。" },
      // Chapter call: returns markdown.
      { ok: true, durationMs: 1, text: "# proj-a\n\n章前言。" },
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    // Three LLM calls in order: thread, article, chapter.
    expect(calls).toHaveLength(3);

    expect(r.newSessions).toBe(1);
    expect(r.threadCandidates).toBe(1);
    expect(r.threadsSkipped).toBe(0);
    expect(r.articlesOk).toBe(1);
    expect(r.articlesFailed).toBe(0);
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
    expect(r.chaptersFailed).toEqual([]);
    expect(r.tocFilesWritten).toEqual(expect.arrayContaining([
      "book/index.md", "book/_meta/timeline.md", "book/proj-a/timeline.md",
    ]));

    // BookEntry was upserted.
    expect(book.threads["t-happy"]).toMatchObject({
      threadId: "t-happy", project: "proj-a", title: "成功",
      sessionIds: ["s1"], articleStatus: "ok",
    });
    expect(book.threads["t-happy"]!.articlePath).toMatch(/^book\/proj-a\/articles\//);
    expect(book.chapters["proj-a"]).toBeDefined();

    // Article and chapter files exist.
    const articleAbs = join(repoRoot, book.threads["t-happy"]!.articlePath);
    expect(readFileSync(articleAbs, "utf8")).toBe("# 成功\n\n文章正文。");
    expect(readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8")).toBe("# proj-a\n\n章前言。");
  });
});

// =====================================================================
describe("runDigest — skip candidate: persists skip BookEntry, no article/chapter call", () => {
  it("when threading marks the only thread as skip, neither article nor chapter run", async () => {
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "trivial");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };

    const { runner, calls } = makeRunner([
      // Threading: one skip candidate.
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-skip", title: "略过", sessionIds: ["s1"], skip: true, reason: "太短" },
      ])},
      // No more replies — if anything is called the fake throws.
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    expect(calls).toHaveLength(1); // threading only
    expect(r.threadsSkipped).toBe(1);
    expect(r.articlesOk).toBe(0);
    expect(r.articlesFailed).toBe(0);
    expect(r.chaptersRewritten).toEqual([]);

    expect(book.threads["t-skip"]).toMatchObject({
      threadId: "t-skip", skip: true, skipReason: "太短", articleStatus: "ok",
      articlePath: "",
    });
    // Toc still ran.
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigest — article phase failure isolation", () => {
  it("one thread's article fails; the other succeeds; chapter rewrite still attempted for the project", async () => {
    const e1 = ie({ sessionId: "s1", shortId: "s1", endedAt: "2026-04-15T09:00:00Z" });
    const e2 = ie({ sessionId: "s2", shortId: "s2", endedAt: "2026-04-15T10:00:00Z" });
    writeSessionMd(e1.relativePath, "a");
    writeSessionMd(e2.relativePath, "b");
    const idx = makeIndex([e1, e2]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };

    const { runner, calls } = makeRunner([
      // Threading: two candidates same project.
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-bad", title: "坏", sessionIds: ["s1"] },
        { threadId: "t-good", title: "好", sessionIds: ["s2"] },
      ])},
      // Article order is determined by the orchestrator; we use functional
      // replies to decide based on what title we see in vars.
      async (_p, vars) => vars.title === "坏"
        ? { ok: false, durationMs: 1, error: "fake article failure" }
        : { ok: true, durationMs: 1, text: "# 好\n\n好文章。" },
      async (_p, vars) => vars.title === "坏"
        ? { ok: false, durationMs: 1, error: "fake article failure" }
        : { ok: true, durationMs: 1, text: "# 好\n\n好文章。" },
      // Chapter: succeeds.
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    expect(r.articlesOk).toBe(1);
    expect(r.articlesFailed).toBe(1);
    expect(book.threads["t-bad"]!.articleStatus).toBe("failed");
    expect(book.threads["t-good"]!.articleStatus).toBe("ok");
    // Chapter was attempted (only ok articles included by chapter.ts).
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
    expect(calls).toHaveLength(4); // 1 thread + 2 articles + 1 chapter
  });
});

// =====================================================================
describe("runDigest — threading partial failure", () => {
  it("when threading runner returns ok:false, the batch soft-fails; toc still runs; report flags failed batches", async () => {
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "x");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const { runner } = makeRunner([
      { ok: false, durationMs: 1, error: "thread runner exploded" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runDigest(runner, repoRoot, idx, book, null, 4, 1);
      expect(r.threadingBatchesFailed).toBe(1);
      expect(r.threadCandidates).toBe(0);
      expect(r.articlesOk).toBe(0);
      // Toc still ran.
      expect(existsSync(join(repoRoot, "book/index.md"))).toBe(true);
      expect(r.tocFilesWritten).toContain("book/index.md");
    } finally {
      warn.mockRestore();
    }
  });
});

// =====================================================================
describe("runDigest — chapter phase failure is isolated", () => {
  it("when chapter generation fails, prior chapter.md untouched, report flags it, toc still runs", async () => {
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "x");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };

    // Pre-place a chapter.md to verify it's preserved.
    mkdirSync(join(repoRoot, "book/proj-a"), { recursive: true });
    writeFileSync(join(repoRoot, "book/proj-a/chapter.md"), "OLD CHAPTER");

    const { runner } = makeRunner([
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t1", title: "T", sessionIds: ["s1"] },
      ])},
      { ok: true, durationMs: 1, text: "# T\n\n文。" },           // article ok
      { ok: false, durationMs: 1, error: "chapter runner timeout" }, // chapter fails
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    expect(r.articlesOk).toBe(1);
    expect(r.chaptersRewritten).toEqual([]);
    expect(r.chaptersFailed).toEqual([{ project: "proj-a", error: "chapter runner timeout" }]);
    // Old chapter.md preserved.
    expect(readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8")).toBe("OLD CHAPTER");
    // Toc still ran.
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigest — chapter rewrite gate", () => {
  it("when articles changed in proj-a but proj-b articles unchanged, only proj-a chapter is rewritten", async () => {
    // Pre-existing state: proj-b already has one ok article and a chapter.
    const ePrior = ie({
      sessionId: "prior", shortId: "prior", project: "proj-b",
      relativePath: "raw_sessions/c/proj-b/2026-04-10/p__prior.md",
      sourceSha256: "shaPrior",
      endedAt: "2026-04-10T00:00:00Z",
    });
    writeSessionMd(ePrior.relativePath, "prior content");
    mkdirSync(join(repoRoot, "book/proj-b/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/proj-b/articles/prior.md"), "# prior\n\nold article body");
    // New session in proj-a.
    const eNew = ie({
      sessionId: "newone", shortId: "newone", project: "proj-a",
      relativePath: "raw_sessions/c/proj-a/2026-04-15/n__newone.md",
      sourceSha256: "shaNew",
      endedAt: "2026-04-15T00:00:00Z",
    });
    writeSessionMd(eNew.relativePath, "new content");
    const idx = makeIndex([ePrior, eNew]);

    // Bootstrap bookIndex with the prior thread + a chapter entry whose hash
    // matches its current articles (so chapterNeedsRewrite returns false).
    const { computeChapterArticleHash } = await import("../../src/digest/chapter.js");
    const priorThreadHash = computeChapterArticleHash([
      { threadId: "t-prior", articleVersion: 1, latestSourceSha: "shaPrior" },
    ]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-prior": {
          threadId: "t-prior", project: "proj-b", title: "Prior",
          sessionIds: ["prior"],
          articlePath: "book/proj-b/articles/prior.md",
          articleVersion: 1, latestSourceSha: "shaPrior",
          articleStatus: "ok", updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {
        "proj-b": { chapterVersion: 1, lastFullRewrite: "2026-04-10T00:00:00Z", latestArticleHash: priorThreadHash },
      },
    };

    const { runner, calls } = makeRunner([
      // Threading: one new candidate in proj-a.
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-new", title: "新", sessionIds: ["newone"] },
      ])},
      // Article for the new thread.
      { ok: true, durationMs: 1, text: "# 新\n\n新文章。" },
      // Chapter for proj-a only — proj-b should be skipped.
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    expect(r.chaptersRewritten).toEqual(["proj-a"]);
    expect(book.chapters["proj-b"]!.lastFullRewrite).toBe("2026-04-10T00:00:00Z"); // untouched
    expect(calls).toHaveLength(3); // 1 thread + 1 article + 1 chapter
  });
});

// =====================================================================
describe("runDigest — stale article version forces regeneration", () => {
  it("a BookEntry whose articleVersion < ARTICLE_VERSION is regenerated even though no new sessions", async () => {
    // Use vi to force ARTICLE_VERSION mismatch by mocking the constant export
    // at module level. Easier: stamp the BookEntry with version 0 (older).
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "body");
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-stale": {
          threadId: "t-stale", project: "proj-a", title: "陈旧",
          sessionIds: ["s1"],
          articlePath: "book/proj-a/articles/stale.md",
          articleVersion: 0, // older than current ARTICLE_VERSION (=1)
          latestSourceSha: "shaA",
          articleStatus: "ok",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };

    const { runner, calls } = makeRunner([
      // No threading call expected: no new sessions.
      // Article rewrite for the stale thread.
      { ok: true, durationMs: 1, text: "# 陈旧\n\n重写后的文章。" },
      // Chapter for proj-a.
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ]);

    const r = await runDigest(runner, repoRoot, idx, book, null);

    // No threading call — only article + chapter.
    expect(calls).toHaveLength(2);
    expect(r.articlesOk).toBe(1);
    expect(book.threads["t-stale"]!.articleVersion).toBe(1); // bumped
    expect(book.threads["t-stale"]!.title).toBe("陈旧"); // preserved
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
  });
});

// =====================================================================
describe("runDigest — pseudo-project pruning migration", () => {
  it("prunes pre-existing pseudo-project entries from BookIndex on first run", async () => {
    const idx: IndexFile = { version: 1, entries: {} };
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-good": {
          threadId: "t-good", project: "proj-a", title: "ok",
          sessionIds: ["s-good"], articlePath: "book/proj-a/articles/ok.md",
          articleVersion: 1, latestSourceSha: "x", articleStatus: "ok",
          skip: false, updatedAt: "2026-04-15T10:00:00Z",
        },
        "t-junk": {
          threadId: "t-junk", project: ".worktrees-abc-123", title: "junk",
          sessionIds: ["s-junk"], articlePath: "book/.worktrees-abc-123/articles/junk.md",
          articleVersion: 1, latestSourceSha: "y", articleStatus: "ok",
          skip: false, updatedAt: "2026-04-15T10:00:00Z",
        },
      },
      chapters: {
        "proj-a": { chapterPath: "book/proj-a/chapter.md", articleHashesSha: "h", updatedAt: "2026-04-15T10:00:00Z" },
        ".worktrees-abc-123": { chapterPath: "book/.worktrees-abc-123/chapter.md", articleHashesSha: "h2", updatedAt: "2026-04-15T10:00:00Z" },
      },
    };
    const { runner } = makeRunner([]);
    await runDigest(runner, repoRoot, idx, book, null);
    expect(book.threads["t-junk"]).toBeUndefined();
    expect(book.threads["t-good"]).toBeDefined();
    expect(book.chapters[".worktrees-abc-123"]).toBeUndefined();
    expect(book.chapters["proj-a"]).toBeDefined();
  });
});
