# Sprint 2.8.2 — Digest Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the top-level `runDigest(runner, repoRoot, indexFile, bookIndex)` orchestrator that wires Sprint 2.8.1's `pipeline.ts` planning functions to the existing `batcher.ts` → `runThreading` → `generateArticle` → `generateChapter` → `generateToc` modules in spec order, with the spec's failure-isolation policy. Caller-driven (no IO except what the modules already do); fully unit-testable end-to-end with a fake runner against a tmp repo.

**Architecture:**
- One new file `src/digest/orchestrator.ts` exposes one entry point: `runDigest(...)`. It mutates the passed `BookIndex` in place (caller persists with `saveBookIndex` after) and returns a structured `DigestReport` summarizing what happened (counts + lists of failures) so 2.8.3's `sync.ts` can log it cleanly.
- Phase ordering follows the spec exactly: digest.plan → digest.thread → digest.article → digest.chapter → digest.toc.
- Failure isolation matches the spec:
  - thread phase failure (any batch) → throw; abort phases 4-7. The caller (sync.ts in 2.8.3) catches and continues to push raw branch.
  - article phase failure (single thread) → already isolated by `generateArticle` (no-throw); we keep going.
  - chapter phase failure (single project) → `generateChapter` returns `{status:"failed"}`; we log and continue.
  - toc phase: pure mechanical, runs always.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md` "Pipeline" section (phases 3-7) and "失败处理" (lines 137-141).

---

## Where 2.8.2 sits

- **2.8.1 (shipped):** `pipeline.ts` planning functions.
- **2.8.2 (this plan):** `orchestrator.ts` `runDigest` end-to-end, fake-runner integration test against tmp repo. No `sync.ts` change.
- **2.8.3 (next plan):** Wire `runDigest` into `commands/sync.ts`, add `--no-digest` flag, real-CLI integration test.

This file plans only 2.8.2.

---

## File Structure

**New files:**
- `src/digest/orchestrator.ts` — `runDigest()` + `DigestReport` type
- `tests/digest/orchestrator.test.ts` — fake `LlmRunner`, fixture .md files in tmp repo, asserts on resulting `BookIndex` + `book/` files

**Modified files:** none.

**Untouched:** `src/commands/sync.ts`, every existing test, every existing source file.

---

## Task 1: Orchestrator (single TDD task, single commit)

**Files:**
- Create: `src/digest/orchestrator.ts`
- Create: `tests/digest/orchestrator.test.ts`

### Public surface

```ts
import type { LlmRunner } from "./runner.js";
import type { IndexFile } from "../types.js";
import type { BookIndex } from "./book-index.js";

export interface DigestReport {
  /** Number of new sessions found in indexFile but not yet in bookIndex. */
  newSessions: number;
  /** Number of thread candidates returned by threading (after merge). */
  threadCandidates: number;
  /** Number of candidates marked skip:true by the LLM (persisted as skip BookEntries). */
  threadsSkipped: number;
  /** Number of articles generated successfully (status === "ok"). */
  articlesOk: number;
  /** Number of articles that returned status "skipped" (LLM SKIP sentinel). */
  articlesSkipped: number;
  /** Number of articles that failed (BookEntry.articleStatus === "failed"). */
  articlesFailed: number;
  /** Projects whose chapter.md was rewritten this run. */
  chaptersRewritten: string[];
  /** Projects whose chapter rewrite was attempted but failed (prior chapter preserved). */
  chaptersFailed: { project: string; error: string }[];
  /** Files written by toc generation (relative to repoRoot). */
  tocFilesWritten: string[];
}

/**
 * Run the digest pipeline phases 3-7 (plan / thread / article / chapter / toc).
 *
 * Side effects:
 *   - Mutates `bookIndex` in place. Caller is responsible for `saveBookIndex`
 *     and for staging/committing both `bookIndex` and the written files.
 *   - Reads session .md from disk (via pipeline.ts).
 *   - Writes article .md, chapter .md, toc .md files into `repoRoot/book/...`.
 *
 * Behavior:
 *   - When `findNewSessionEntries` returns empty AND no thread is stale (article
 *     version drift / no chapter needs rewriting), still runs the toc phase
 *     so a fresh `book/index.md` exists. Phases 4-6 are no-ops.
 *   - Threading throw → propagates (caller decides). Toc is NOT run if threading
 *     throws (book is in mid-state; better to surface the error).
 *   - Article failure → BookEntry.articleStatus="failed" by generateArticle;
 *     orchestrator counts it and continues.
 *   - Chapter failure → counted in report.chaptersFailed; prior chapter.md preserved.
 *
 * Stale-thread detection (spec line 99 "articleVersion 升级"):
 *   - Any BookEntry with articleStatus !== "failed", skip !== true, and
 *     articleVersion !== ARTICLE_VERSION is also fed back through the article
 *     phase as if it were freshly threaded. (Not within scope of `--redo`,
 *     which is 2.9; this is the natural-drift case.)
 */
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
): Promise<DigestReport>;
```

### Tests

- [ ] **Step 1: Write failing test file**

Create `tests/digest/orchestrator.test.ts`:

```ts
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
    const r = await runDigest(runner, repoRoot, idx, book);
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

    const r = await runDigest(runner, repoRoot, idx, book);

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

    const r = await runDigest(runner, repoRoot, idx, book);

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

    const r = await runDigest(runner, repoRoot, idx, book);

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
describe("runDigest — threading failure aborts phases 4-7", () => {
  it("when threading runner returns ok:false, runDigest throws and toc is NOT run", async () => {
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "x");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const { runner } = makeRunner([
      { ok: false, durationMs: 1, error: "thread runner exploded" },
    ]);
    await expect(runDigest(runner, repoRoot, idx, book)).rejects.toThrow(/thread/);
    expect(existsSync(join(repoRoot, "book/index.md"))).toBe(false);
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

    const r = await runDigest(runner, repoRoot, idx, book);

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

    const r = await runDigest(runner, repoRoot, idx, book);

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

    const r = await runDigest(runner, repoRoot, idx, book);

    // No threading call — only article + chapter.
    expect(calls).toHaveLength(2);
    expect(r.articlesOk).toBe(1);
    expect(book.threads["t-stale"]!.articleVersion).toBe(1); // bumped
    expect(book.threads["t-stale"]!.title).toBe("陈旧"); // preserved
    expect(r.chaptersRewritten).toEqual(["proj-a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- orchestrator`
Expected: FAIL with "Cannot find module '../../src/digest/orchestrator.js'".

- [ ] **Step 3: Write `src/digest/orchestrator.ts`**

```ts
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { LlmRunner } from "./runner.js";
import type { IndexFile, IndexEntry } from "../types.js";
import {
  type BookIndex,
  type BookEntry,
  loadBookIndex as _unused1, // import side-effect-free anchor; actual load is caller's job
} from "./book-index.js";
import { makeBatches } from "./batcher.js";
import { runThreading } from "./threading.js";
import {
  ARTICLE_VERSION,
  generateArticle,
  type ArticleInput,
} from "./article.js";
import {
  chapterNeedsRewrite,
  generateChapter,
} from "./chapter.js";
import { generateToc } from "./toc.js";
import {
  findNewSessionEntries,
  buildBatchingInput,
  recordSkippedThreadCandidates,
  buildArticleInputs,
} from "./pipeline.js";

// Marker so the unused import doesn't get tree-shaken or linted away.
void _unused1;

export interface DigestReport {
  newSessions: number;
  threadCandidates: number;
  threadsSkipped: number;
  articlesOk: number;
  articlesSkipped: number;
  articlesFailed: number;
  chaptersRewritten: string[];
  chaptersFailed: { project: string; error: string }[];
  tocFilesWritten: string[];
}

/**
 * Run digest pipeline phases 3-7 (plan / thread / article / chapter / toc).
 * Mutates `bookIndex` in place; caller persists.
 *
 * Failure isolation: thread phase throws → propagates (toc skipped). Article
 * single-thread failure → counted, isolated by generateArticle's contract.
 * Chapter single-project failure → counted, prior chapter preserved by
 * generateChapter's contract.
 */
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
): Promise<DigestReport> {
  // -------------------------------------------------------------- plan
  const newEntries = findNewSessionEntries(indexFile, bookIndex);
  const report: DigestReport = {
    newSessions: newEntries.length,
    threadCandidates: 0,
    threadsSkipped: 0,
    articlesOk: 0,
    articlesSkipped: 0,
    articlesFailed: 0,
    chaptersRewritten: [],
    chaptersFailed: [],
    tocFilesWritten: [],
  };

  // -------------------------------------------------------------- thread
  let articleInputs: ArticleInput[] = [];
  if (newEntries.length > 0) {
    const sessionsForBatching = buildBatchingInput(newEntries, repoRoot);
    const batches = makeBatches(sessionsForBatching);
    const candidates = await runThreading(runner, batches);
    report.threadCandidates = candidates.length;
    report.threadsSkipped = recordSkippedThreadCandidates(bookIndex, candidates, indexFile).length;
    articleInputs = buildArticleInputs(candidates, indexFile, repoRoot);
  }

  // ------------------------------ stale-thread re-generation (article-version drift)
  // Spec line 99: BookEntries whose articleVersion is below current need rewrite.
  // We don't include failed (those are 2.9 --redo) or skip threads.
  const staleInputs = buildStaleArticleInputs(bookIndex, indexFile, repoRoot);
  const allArticleInputs = articleInputs.concat(staleInputs);

  // Track which projects had any article touched, so chapter phase only
  // considers them (in addition to chapterNeedsRewrite's own gate).
  const touchedProjects = new Set<string>();
  for (const input of allArticleInputs) touchedProjects.add(input.project);

  // -------------------------------------------------------------- article
  for (const input of allArticleInputs) {
    const res = await generateArticle(runner, repoRoot, input, bookIndex);
    if (res.status === "ok") report.articlesOk++;
    else if (res.status === "skipped") report.articlesSkipped++;
    else report.articlesFailed++;
  }

  // -------------------------------------------------------------- chapter
  // Consider any project with a touched article OR an existing entry whose hash
  // would change. We only call chapterNeedsRewrite for the touched set — we
  // assume untouched projects' hashes can't have shifted.
  for (const project of Array.from(touchedProjects).sort()) {
    if (!chapterNeedsRewrite(bookIndex, project)) continue;
    const res = await generateChapter(runner, repoRoot, project, bookIndex);
    if (res.status === "ok") report.chaptersRewritten.push(project);
    else if (res.status === "failed") report.chaptersFailed.push({ project, error: res.error });
    // "no-articles" → silent: nothing to do.
  }

  // -------------------------------------------------------------- toc
  const tocResult = generateToc(repoRoot, bookIndex);
  report.tocFilesWritten = tocResult.written;

  return report;
}

/**
 * Find BookEntries that need a stale-version regeneration:
 *   - articleStatus === "ok"
 *   - !skip
 *   - articleVersion !== ARTICLE_VERSION
 *
 * For each, build an ArticleInput from the recorded sessionIds (looked up in
 * indexFile). If any sessionId is missing from indexFile, log + skip the
 * regeneration (the underlying raw is gone; nothing we can do here).
 */
function buildStaleArticleInputs(
  bookIndex: BookIndex,
  indexFile: IndexFile,
  repoRoot: string,
): ArticleInput[] {
  const out: ArticleInput[] = [];
  const lookup = new Map<string, IndexEntry>();
  for (const e of Object.values(indexFile.entries)) lookup.set(e.sessionId, e);

  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus === "failed") continue;
    if (be.articleVersion === ARTICLE_VERSION) continue;

    const entries: IndexEntry[] = [];
    let missing = false;
    for (const sid of be.sessionIds) {
      const ie = lookup.get(sid);
      if (!ie) {
        console.warn(`orchestrator.ts: stale thread ${be.threadId} references unknown sessionId ${sid} — skipping rewrite`);
        missing = true;
        break;
      }
      entries.push(ie);
    }
    if (missing) continue;

    entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

    const bodies: string[] = [];
    for (const e of entries) {
      if (e.relativePath.endsWith(".enc")) {
        throw new Error(`orchestrator.ts: encrypted sessions not supported (got ${e.relativePath})`);
      }
      const body = readFileSync(join(repoRoot, e.relativePath), "utf8");
      bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
    }

    out.push({
      threadId: be.threadId,
      project: be.project,
      title: be.title,
      sessionIds: entries.map((e) => e.sessionId),
      sessionShas: entries.map((e) => e.sourceSha256),
      sessionsMd: bodies.join("\n\n"),
      endedAt: entries[entries.length - 1]!.endedAt,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- orchestrator`
Expected: all 7 orchestrator tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by 7 new tests (was 136 → 143).

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/orchestrator.ts tests/digest/orchestrator.test.ts
git commit -m "feat(digest): add runDigest orchestrator (plan→thread→article→chapter→toc with spec failure isolation)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "Pipeline 阶段 3-7" — `runDigest` walks plan → thread → article → chapter → toc in order.
  - "阶段 4 任意 batch 失败 → 中止 4-7" — `runThreading` throws → propagates → toc skipped (test "threading failure aborts phases 4-7").
  - "阶段 5 单条失败 → 该 thread articleStatus failed, 其它继续" — `generateArticle`'s no-throw contract; orchestrator counts (test "article phase failure isolation").
  - "阶段 6 单章失败 → 保留上一版 chapter.md" — `generateChapter`'s contract; orchestrator counts (test "chapter phase failure is isolated").
  - "阶段 7 toc 机械, 不走 LLM" — `generateToc` always runs unless threading throws.
  - Spec line 99 "articleVersion 升级 重写" — `buildStaleArticleInputs` (test "stale article version forces regeneration").

- **Placeholder scan:** every code step has full code. No TBD / "similar to" / "add validation".

- **Type consistency:**
  - `LlmRunner` from `src/digest/runner.ts`. ✓
  - `IndexFile`/`IndexEntry` from `src/types.ts`. ✓
  - `BookIndex`/`BookEntry` from `src/digest/book-index.ts`. ✓
  - `ArticleInput`/`ARTICLE_VERSION`/`generateArticle` from `src/digest/article.ts`. ✓
  - `chapterNeedsRewrite`/`generateChapter` from `src/digest/chapter.ts`. ✓
  - `generateToc` from `src/digest/toc.ts`. ✓
  - `findNewSessionEntries`/`buildBatchingInput`/`recordSkippedThreadCandidates`/`buildArticleInputs` from `src/digest/pipeline.ts`. ✓
  - `makeBatches` from `src/digest/batcher.ts` (default options OK; spec uses 100k). ✓
  - `runThreading` from `src/digest/threading.ts`. ✓

- **Out of scope (deferred, by design):**
  - `sync.ts` integration + `--no-digest` flag → 2.8.3.
  - Real-CLI integration test → 2.8.3.
  - `memvc digest --redo` (force-rerun all failed threads + force-rewrite all chapters) → 2.9.
  - Encrypted session pipeline support → future sprint.
  - Roadmap update → at end of 2.8.3 (this sub-sprint isn't user-visible).
