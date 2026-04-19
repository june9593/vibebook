import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigestRedo } from "../../src/digest/redo.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex, BookEntry } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { ARTICLE_VERSION } from "../../src/digest/article.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-redo-"));
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
describe("runDigestRedo — empty BookIndex", () => {
  it("with no failed threads and no projects: only toc runs", async () => {
    const idx: IndexFile = { version: 1, entries: {} };
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const { runner, calls } = makeRunner([]);
    const r = await runDigestRedo(runner, repoRoot, idx, book, null);
    expect(calls).toHaveLength(0);
    expect(r.threadsAttempted).toBe(0);
    expect(r.threadsRecovered).toBe(0);
    expect(r.chaptersRewritten).toEqual([]);
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigestRedo — recovers a previously-failed thread", () => {
  it("flips articleStatus failed → ok, force-rewrites chapter, runs toc", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "session body");
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-fail": {
          threadId: "t-fail", project: "proj-a", title: "失败过",
          sessionIds: ["s1"],
          articlePath: "",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "shaA",
          articleStatus: "failed",
          articleError: "previous timeout",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };

    const { runner, calls } = makeRunner([
      // Article retry: succeeds.
      { ok: true, durationMs: 1, text: "# 失败过\n\n这次成功了。" },
      // Chapter (forced): succeeds.
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ]);

    const r = await runDigestRedo(runner, repoRoot, idx, book, null);

    expect(calls).toHaveLength(2);
    expect(r.threadsAttempted).toBe(1);
    expect(r.threadsRecovered).toBe(1);
    expect(r.threadsStillFailed).toBe(0);
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
    expect(book.threads["t-fail"]!.articleStatus).toBe("ok");
    expect(book.threads["t-fail"]!.articlePath).toMatch(/^book\/proj-a\/articles\//);
    expect(book.threads["t-fail"]!.articleError).toBeUndefined(); // cleared on success
    expect(existsSync(join(repoRoot, book.threads["t-fail"]!.articlePath))).toBe(true);
    expect(readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8")).toBe("# proj-a\n\n章。");
  });
});

// =====================================================================
describe("runDigestRedo — failed thread whose retry returns SKIP", () => {
  it("counts as threadsNewlySkipped, BookEntry becomes skip:true", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "trivial body");
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-fail": {
          threadId: "t-fail", project: "proj-a", title: "T",
          sessionIds: ["s1"],
          articlePath: "",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "shaA",
          articleStatus: "failed",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };
    const { runner } = makeRunner([
      { ok: true, durationMs: 1, text: "SKIP: 内容太短" },
    ]);
    const r = await runDigestRedo(runner, repoRoot, idx, book, null);
    expect(r.threadsAttempted).toBe(1);
    expect(r.threadsRecovered).toBe(0);
    expect(r.threadsStillFailed).toBe(0);
    expect(r.threadsNewlySkipped).toBe(1);
    expect(book.threads["t-fail"]!.skip).toBe(true);
    expect(book.threads["t-fail"]!.articleStatus).toBe("ok");
  });
});

// =====================================================================
describe("runDigestRedo — failed thread that fails again stays failed", () => {
  it("articleStatus stays failed; chapter still attempted but no-articles for that project", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "body");
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-fail": {
          threadId: "t-fail", project: "proj-a", title: "T",
          sessionIds: ["s1"],
          articlePath: "",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "shaA",
          articleStatus: "failed",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };

    const { runner, calls } = makeRunner([
      // Article retry: fails again.
      { ok: false, durationMs: 1, error: "still timing out" },
      // No chapter call expected (no publishable articles for proj-a after retry fail).
    ]);

    const r = await runDigestRedo(runner, repoRoot, idx, book, null);

    expect(calls).toHaveLength(1);
    expect(r.threadsAttempted).toBe(1);
    expect(r.threadsRecovered).toBe(0);
    expect(r.threadsStillFailed).toBe(1);
    expect(r.chaptersRewritten).toEqual([]);
    expect(book.threads["t-fail"]!.articleStatus).toBe("failed");
    expect(book.threads["t-fail"]!.articleError).toBe("still timing out");
    // Toc still runs.
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigestRedo — force-rewrites ALL chapters, even unchanged ones", () => {
  it("a project whose articles haven't changed since last chapter still gets a fresh chapter.md", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "body");
    // Pre-existing OK article on disk.
    mkdirSync(join(repoRoot, "book/proj-a/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/proj-a/articles/existing.md"), "# Existing\n\nbody");

    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-ok": {
          threadId: "t-ok", project: "proj-a", title: "OK",
          sessionIds: ["s1"],
          articlePath: "book/proj-a/articles/existing.md",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "shaA",
          articleStatus: "ok",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      // Chapter exists with a hash matching current state — chapterNeedsRewrite would say "no".
      chapters: { "proj-a": { chapterVersion: 1, lastFullRewrite: "2026-04-10T00:00:00Z", latestArticleHash: "any-hash" } },
    };

    const { runner, calls } = makeRunner([
      // Force-rewrite call (no article calls — no failed threads).
      { ok: true, durationMs: 1, text: "# proj-a\n\n新章。" },
    ]);

    const r = await runDigestRedo(runner, repoRoot, idx, book, null);

    expect(calls).toHaveLength(1);
    expect(r.threadsAttempted).toBe(0);
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
    expect(readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8")).toBe("# proj-a\n\n新章。");
    // BookIndex's chapter entry refreshed.
    expect(book.chapters["proj-a"]!.lastFullRewrite).not.toBe("2026-04-10T00:00:00Z");
  });
});

// =====================================================================
describe("runDigestRedo — failed thread whose sessions vanished from indexFile", () => {
  it("counts as unresolvable; left as failed; toc still runs", async () => {
    const idx = makeIndex([]); // empty: no sessions present
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-orphan": {
          threadId: "t-orphan", project: "proj-a", title: "孤儿",
          sessionIds: ["missing-sid"],
          articlePath: "",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "x",
          articleStatus: "failed",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };
    const { runner, calls } = makeRunner([]);
    const r = await runDigestRedo(runner, repoRoot, idx, book, null);
    expect(calls).toHaveLength(0);
    expect(r.threadsAttempted).toBe(0);
    expect(r.threadsUnresolvable).toBe(1);
    expect(book.threads["t-orphan"]!.articleStatus).toBe("failed"); // unchanged
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigestRedo — chapter rewrite failure is isolated", () => {
  it("preserves prior chapter.md, flags it in report, toc still runs", async () => {
    const e = ie({ sessionId: "s1", shortId: "s1" });
    writeSessionMd(e.relativePath, "body");
    mkdirSync(join(repoRoot, "book/proj-a"), { recursive: true });
    writeFileSync(join(repoRoot, "book/proj-a/chapter.md"), "OLD CHAPTER");
    mkdirSync(join(repoRoot, "book/proj-a/articles"), { recursive: true });
    writeFileSync(join(repoRoot, "book/proj-a/articles/existing.md"), "# X\n\nx");

    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-ok": {
          threadId: "t-ok", project: "proj-a", title: "OK",
          sessionIds: ["s1"],
          articlePath: "book/proj-a/articles/existing.md",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "shaA",
          articleStatus: "ok",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: { "proj-a": { chapterVersion: 1, lastFullRewrite: "2026-04-10T00:00:00Z", latestArticleHash: "x" } },
    };
    const { runner } = makeRunner([
      { ok: false, durationMs: 1, error: "chapter exploded" },
    ]);

    const r = await runDigestRedo(runner, repoRoot, idx, book, null);

    expect(r.chaptersRewritten).toEqual([]);
    expect(r.chaptersFailed).toEqual([{ project: "proj-a", error: "chapter exploded" }]);
    expect(readFileSync(join(repoRoot, "book/proj-a/chapter.md"), "utf8")).toBe("OLD CHAPTER");
    expect(r.tocFilesWritten).toContain("book/index.md");
  });
});

// =====================================================================
describe("runDigestRedo — skip threads are not retried", () => {
  it("a skip:true BookEntry stays put even if its articleStatus is somehow failed", async () => {
    const idx: IndexFile = { version: 1, entries: {} };
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-skip": {
          threadId: "t-skip", project: "proj-a", title: "skipped",
          sessionIds: ["sid"],
          articlePath: "",
          articleVersion: ARTICLE_VERSION,
          latestSourceSha: "",
          articleStatus: "ok",
          skip: true, skipReason: "trivial",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };
    const { runner, calls } = makeRunner([]);
    const r = await runDigestRedo(runner, repoRoot, idx, book, null);
    expect(calls).toHaveLength(0);
    expect(r.threadsAttempted).toBe(0);
    expect(book.threads["t-skip"]!.skip).toBe(true);
  });
});
