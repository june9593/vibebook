# Sprint 2.9 — `memvc digest --redo` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `memvc digest --redo`, a one-shot command that (a) regenerates every `articleStatus === "failed"` thread by feeding it back through the article phase, and (b) force-rewrites every project's `chapter.md` regardless of `latestArticleHash` (because failed-then-fixed articles often imply chapter content drift). Same failure-isolation rules as the regular pipeline; same on-disk effects (BookIndex updated, `book/` files rewritten); same git push behavior as `sync`.

**Architecture:**
- One new file `src/digest/redo.ts` exposes `runDigestRedo(runner, repoRoot, indexFile, bookIndex)`. Reuses Sprint 2.8 helpers: `buildArticleInputForThread` (from `pipeline.ts`), `generateArticle` (article.ts), `generateChapter` (chapter.ts), `generateToc` (toc.ts). Does NOT call threading or `findNewSessionEntries` — `--redo` is for state recovery, not for picking up new sessions (use `memvc sync` for that).
- One new command file `src/commands/digest.ts` exports `digestCmd({ redo: boolean })`. When invoked without `--redo` it prints a help-style message (we don't yet support a non-redo digest variant — `memvc sync` is the canonical way to run the pipeline).
- Force-rewrite-all-chapters means: skip `chapterNeedsRewrite` and call `generateChapter` for every project that has at least one publishable article. (`generateChapter` already returns `no-articles` when the project has none, so iteration is safe.)
- CLI: a new top-level `digest` subcommand under `memvc`, with `--redo` flag, mirroring the `sync` command's git push behavior.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest, commander.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md` line 295 (`memvc digest --redo 重跑所有 articleStatus="failed" 的 thread 和上一版 chapter`) and line 140 (`所有失败都可通过 memvc digest --redo 重跑`).

---

## File Structure

**New files:**
- `src/digest/redo.ts` — `runDigestRedo()` + `RedoReport` type
- `src/commands/digest.ts` — `digestCmd({ redo })` CLI handler that wraps `runDigestRedo` + git push
- `tests/digest/redo.test.ts` — fake runner against tmp repo: pre-stage a failed BookEntry, run redo, assert fix
- `tests/commands/digest.test.ts` — integration test: end-to-end `digestCmd` against tmp repo with mocked `createRunner`

**Modified files:**
- `src/cli.ts` — register `digest` subcommand
- `docs/superpowers/roadmap.md` — mark 2.9 done

**Untouched:** `src/digest/orchestrator.ts`, `src/commands/sync.ts`, all other digest modules.

---

## Task 1: Redo orchestrator (single TDD task, single commit)

**Files:**
- Create: `src/digest/redo.ts`
- Create: `tests/digest/redo.test.ts`

### Public surface

```ts
import type { LlmRunner } from "./runner.js";
import type { IndexFile } from "../types.js";
import type { BookIndex } from "./book-index.js";

export interface RedoReport {
  /** Failed threads we attempted to regenerate. */
  threadsAttempted: number;
  /** Threads that flipped from failed → ok (article generation succeeded). */
  threadsRecovered: number;
  /** Threads that stayed failed (still failing, or new failure). */
  threadsStillFailed: number;
  /** Threads we couldn't even attempt because their sessionIds aren't in indexFile. */
  threadsUnresolvable: number;
  /** Projects whose chapter.md was rewritten. */
  chaptersRewritten: string[];
  /** Projects whose chapter rewrite was attempted but failed (prior preserved). */
  chaptersFailed: { project: string; error: string }[];
  /** Files written by toc generation (relative to repoRoot). */
  tocFilesWritten: string[];
}

/**
 * Run "redo" pipeline:
 *   1. For every BookEntry with articleStatus === "failed" (and !skip), build
 *      an ArticleInput from its sessionIds and re-call generateArticle.
 *   2. For every project with ≥1 publishable article, call generateChapter
 *      (force; bypasses chapterNeedsRewrite). Failures preserve prior chapter.
 *   3. Run generateToc (always).
 *
 * Mutates `bookIndex` in place. Caller persists with saveBookIndex.
 *
 * Failure isolation:
 *   - Article failure → BookEntry stays articleStatus="failed"; threadsStillFailed++.
 *   - Chapter failure → counted, prior chapter preserved.
 *   - No phase-aborting throws (this is a recovery command — should be tolerant).
 */
export async function runDigestRedo(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
): Promise<RedoReport>;
```

### Tests

- [ ] **Step 1: Write failing test file**

Create `tests/digest/redo.test.ts`:

```ts
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
    const r = await runDigestRedo(runner, repoRoot, idx, book);
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

    const r = await runDigestRedo(runner, repoRoot, idx, book);

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

    const r = await runDigestRedo(runner, repoRoot, idx, book);

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

    const r = await runDigestRedo(runner, repoRoot, idx, book);

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
    const r = await runDigestRedo(runner, repoRoot, idx, book);
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

    const r = await runDigestRedo(runner, repoRoot, idx, book);

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
    const r = await runDigestRedo(runner, repoRoot, idx, book);
    expect(calls).toHaveLength(0);
    expect(r.threadsAttempted).toBe(0);
    expect(book.threads["t-skip"]!.skip).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- redo`
Expected: FAIL with "Cannot find module '../../src/digest/redo.js'".

- [ ] **Step 3: Write `src/digest/redo.ts`**

```ts
import type { LlmRunner } from "./runner.js";
import type { IndexFile } from "../types.js";
import type { BookIndex } from "./book-index.js";
import { generateArticle } from "./article.js";
import { generateChapter } from "./chapter.js";
import { generateToc } from "./toc.js";
import { buildArticleInputForThread } from "./pipeline.js";

export interface RedoReport {
  threadsAttempted: number;
  threadsRecovered: number;
  threadsStillFailed: number;
  threadsUnresolvable: number;
  chaptersRewritten: string[];
  chaptersFailed: { project: string; error: string }[];
  tocFilesWritten: string[];
}

/**
 * Re-run failed threads and force-rewrite every chapter.
 *
 * Phase 1: for every BookEntry with articleStatus === "failed" (and !skip),
 *   build an ArticleInput from its recorded sessionIds (looked up in indexFile)
 *   and call generateArticle. Track recovered / still-failed / unresolvable.
 *
 * Phase 2: for every project that has ≥1 publishable article, call
 *   generateChapter unconditionally (skip the chapterNeedsRewrite gate, since
 *   `--redo` is exactly for force-rewriting). Chapter failures are isolated.
 *
 * Phase 3: generateToc runs always.
 *
 * Mutates `bookIndex` in place. Caller persists with saveBookIndex.
 */
export async function runDigestRedo(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
): Promise<RedoReport> {
  const report: RedoReport = {
    threadsAttempted: 0,
    threadsRecovered: 0,
    threadsStillFailed: 0,
    threadsUnresolvable: 0,
    chaptersRewritten: [],
    chaptersFailed: [],
    tocFilesWritten: [],
  };

  // ----------------------------------------------------- Phase 1: retry failed
  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus !== "failed") continue;

    const input = buildArticleInputForThread(
      be.threadId,
      be.title,
      be.sessionIds,
      indexFile,
      repoRoot,
      "redo.ts",
    );
    if (input === null) {
      // sessionIds couldn't be resolved (pipeline.ts already warned) — leave as failed.
      report.threadsUnresolvable++;
      continue;
    }

    report.threadsAttempted++;
    const res = await generateArticle(runner, repoRoot, input, bookIndex);
    if (res.status === "ok") {
      report.threadsRecovered++;
    } else {
      // Both "failed" and "skipped" outcomes are non-recoveries here.
      // (A SKIP from a previously-failed thread is unusual but possible if
      // the LLM now decides the content isn't worth keeping.)
      report.threadsStillFailed++;
    }
  }

  // ----------------------------------- Phase 2: force-rewrite ALL chapters
  const projects = collectProjectsWithArticles(bookIndex);
  for (const project of projects.sort()) {
    const res = await generateChapter(runner, repoRoot, project, bookIndex);
    if (res.status === "ok") report.chaptersRewritten.push(project);
    else if (res.status === "failed") report.chaptersFailed.push({ project, error: res.error });
    // "no-articles" → silent skip.
  }

  // ----------------------------------------------------- Phase 3: toc
  const tocResult = generateToc(repoRoot, bookIndex);
  report.tocFilesWritten = tocResult.written;

  return report;
}

/**
 * Projects appearing in any non-skip, non-failed BookEntry. Each gets
 * force-rewritten. (Failed-and-still-failed projects with no other articles
 * yield "no-articles" from generateChapter, which is silently skipped.)
 *
 * We include projects whose ONLY threads are still failed, on the chance the
 * project also has a chapters[] entry (legacy). generateChapter handles the
 * empty case cleanly.
 */
function collectProjectsWithArticles(bookIndex: BookIndex): Set<string> {
  const out = new Set<string>();
  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus === "failed") continue;
    out.add(be.project);
  }
  // Also include any project that already has a chapter entry (so a chapter
  // for a project that just became all-failed doesn't get orphaned by the
  // "no publishable articles" filter — generateChapter will then no-op,
  // which is the right outcome).
  for (const p of Object.keys(bookIndex.chapters)) out.add(p);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- redo`
Expected: all 7 redo tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by 7 new tests (was 149 → 156).

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/redo.ts tests/digest/redo.test.ts
git commit -m "feat(digest): add runDigestRedo (retry failed threads + force-rewrite all chapters)"
```

---

## Task 2: CLI command + integration test (single TDD task, single commit)

**Files:**
- Create: `src/commands/digest.ts`
- Modify: `src/cli.ts`
- Create: `tests/commands/digest.test.ts`

### Public surface

```ts
// src/commands/digest.ts
export interface DigestOptions {
  redo?: boolean;
}
export async function digestCmd(opts: DigestOptions): Promise<void>;
```

### Tests

- [ ] **Step 1: Write failing test file**

Create `tests/commands/digest.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigestRedoFromRepo } from "../../src/commands/digest.js";
import { saveBookIndex, loadBookIndex } from "../../src/digest/book-index.js";
import { saveIndex } from "../../src/index-store.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { ARTICLE_VERSION } from "../../src/digest/article.js";

describe("runDigestRedoFromRepo (integration)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-cmd-redo-"));
  });

  it("loads IndexFile + BookIndex from disk, runs redo, persists BookIndex", async () => {
    // Stage: a session on disk + IndexFile + BookEntry marked failed.
    const ie: IndexEntry = {
      sessionId: "sid-1", shortId: "sid-1", tool: "claude" as Tool,
      project: "proj-a",
      startedAt: "2026-04-15T09:00:00Z", endedAt: "2026-04-15T10:00:00Z",
      nameSlug: "first", displayName: "First",
      relativePath: "raw_sessions/c/proj-a/2026-04-15/first__sid-1.md",
      sourcePath: "/tmp/x.jsonl", sourceMtimeMs: 1, sourceSha256: "shaA",
    };
    mkdirSync(join(repo, "raw_sessions/c/proj-a/2026-04-15"), { recursive: true });
    writeFileSync(join(repo, ie.relativePath), "session body");
    const idx: IndexFile = { version: 1, entries: { [`claude:sid-1`]: ie } };
    saveIndex(repo, idx);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-fail": {
          threadId: "t-fail", project: "proj-a", title: "失败",
          sessionIds: ["sid-1"],
          articlePath: "", articleVersion: ARTICLE_VERSION, latestSourceSha: "shaA",
          articleStatus: "failed", updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };
    saveBookIndex(repo, book);

    const queue: RunResult[] = [
      { ok: true, durationMs: 1, text: "# 失败\n\n这次成功。" },
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ];
    const fakeRunner: LlmRunner = {
      async run() {
        const n = queue.shift();
        if (!n) throw new Error("exhausted");
        return n;
      },
    };

    const report = await runDigestRedoFromRepo({
      repoPath: repo,
      runnerConfig: { runner: "claude-cli", runnerModel: "" },
      runner: fakeRunner, // injection point used only by tests
    });

    expect(report.threadsRecovered).toBe(1);
    expect(report.chaptersRewritten).toEqual(["proj-a"]);
    // BookIndex was persisted.
    const reloaded = loadBookIndex(repo);
    expect(reloaded.threads["t-fail"]!.articleStatus).toBe("ok");
    expect(reloaded.chapters["proj-a"]).toBeDefined();
    // Files exist.
    expect(existsSync(join(repo, "book/proj-a/chapter.md"))).toBe(true);
    expect(existsSync(join(repo, "book/index.md"))).toBe(true);
  });

  it("returns a report with threadsRecovered=0 when there are no failed threads", async () => {
    saveIndex(repo, { version: 1, entries: {} });
    saveBookIndex(repo, { version: 1, threads: {}, chapters: {} });

    const fakeRunner: LlmRunner = { async run() { throw new Error("not called"); } };
    const report = await runDigestRedoFromRepo({
      repoPath: repo,
      runnerConfig: { runner: "claude-cli", runnerModel: "" },
      runner: fakeRunner,
    });
    expect(report.threadsAttempted).toBe(0);
    expect(report.tocFilesWritten).toContain("book/index.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/commands/digest.test.ts`
Expected: FAIL with "Cannot find module '../../src/commands/digest.js'".

- [ ] **Step 3: Write `src/commands/digest.ts`**

```ts
import chalk from "chalk";
import { readConfig, type Config } from "../config.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
import { loadIndex } from "../index-store.js";
import { loadBookIndex, saveBookIndex } from "../digest/book-index.js";
import { createRunner, type LlmRunner } from "../digest/runner.js";
import { runDigestRedo, type RedoReport } from "../digest/redo.js";

export interface DigestOptions {
  /** When true, run the --redo recovery pipeline. */
  redo?: boolean;
}

/**
 * `memvc digest --redo` entrypoint: reads config, loads indexes from disk,
 * runs the redo pipeline, persists, and (when push is configured) commits +
 * pushes the book changes onto the device branch.
 *
 * Without `--redo` we currently print a help message — `memvc sync` is the
 * canonical way to drive the pipeline for new content.
 */
export async function digestCmd(opts: DigestOptions): Promise<void> {
  if (!opts.redo) {
    console.log(chalk.yellow(
      "Nothing to do without --redo. Use `memvc sync` for the regular pipeline,\n" +
      "or `memvc digest --redo` to retry failed articles + force-rewrite all chapters.",
    ));
    return;
  }

  const cfg = readConfig();
  if (cfg.encrypt) {
    console.log(chalk.yellow("Digest --redo skipped: encrypted raw is not yet supported."));
    return;
  }

  console.log(chalk.gray("Running digest --redo..."));
  const report = await runDigestRedoFromRepo({
    repoPath: cfg.repoPath,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
  });
  console.log(chalk.bold(
    `\n--redo: ${report.threadsRecovered} recovered / ${report.threadsStillFailed} still failed / ${report.threadsUnresolvable} unresolvable; ${report.chaptersRewritten.length} chapters rewritten`,
  ));
  if (report.chaptersFailed.length > 0) {
    for (const f of report.chaptersFailed) {
      console.log(chalk.red(`  ! chapter ${f.project} failed: ${f.error}`));
    }
  }

  // git push
  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* may be offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = [
      ".memvc/index.book.json",
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      // Stage every project's articles dir so any newly-written article files
      // get added (analogous to sync.ts's collectDigestPaths).
      ...uniqueProjects(report).map((p) => `book/${p}/articles`),
    ];
    const r = await commitAndPush(
      git,
      `memvc digest --redo: ${report.threadsRecovered} recovered, ${report.chaptersRewritten.length} chapters`,
      paths,
      cfg.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    if (r.committed) {
      console.log(chalk.cyan(r.pushed ? "Pushed (book)." : "Committed book (push failed)."));
    } else {
      console.log(chalk.gray("Nothing to commit."));
    }
  }
}

/**
 * Loads from-disk inputs and runs runDigestRedo. Test-injectable via `runner`
 * (when omitted, we build one from `runnerConfig`).
 */
export async function runDigestRedoFromRepo(args: {
  repoPath: string;
  runnerConfig: Pick<Config, "runner" | "runnerModel">;
  /** Test-only override for createRunner. */
  runner?: LlmRunner;
}): Promise<RedoReport> {
  const idx = loadIndex(args.repoPath);
  const book = loadBookIndex(args.repoPath);
  const runner = args.runner ?? createRunner(args.runnerConfig);
  const report = await runDigestRedo(runner, args.repoPath, idx, book);
  saveBookIndex(args.repoPath, book);
  return report;
}

function uniqueProjects(report: RedoReport): string[] {
  const out = new Set<string>(report.chaptersRewritten);
  // Pull project names from per-chapter timeline paths in tocFilesWritten.
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}
```

- [ ] **Step 4: Modify `src/cli.ts` — register `digest` command**

Add this block AFTER the existing `sync` command block (between the `sync` and `list` commands):

```ts
  program
    .command("digest")
    .description("Run digest pipeline operations (currently only --redo is supported)")
    .option("--redo", "retry all failed threads and force-rewrite every chapter")
    .action(async (opts: { redo?: boolean }) => {
      const { digestCmd } = await import("./commands/digest.js");
      await digestCmd({ redo: opts.redo });
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/commands/digest.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by 2 more tests (was 156 → 158).

- [ ] **Step 7: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 8: Commit**

```bash
git add src/commands/digest.ts src/cli.ts tests/commands/digest.test.ts
git commit -m "feat(cli): add 'memvc digest --redo' command (retry failed + force-rewrite chapters)"
```

---

## Task 3: Roadmap update

**Files:**
- Modify: `docs/superpowers/roadmap.md`

- [ ] **Step 1: Mark Sprint 2.9 done**

Under the existing 2.7/2.8 ✅ entries in the "Current Baseline" section, add:

```diff
 - ✅ **Sprint 2.8**：sync 接入 digest pipeline（runDigest orchestrator；--no-digest flag；book 分支二次 commit）
+- ✅ **Sprint 2.9**：`memvc digest --redo` 命令（重跑 failed thread；强制重写所有 chapter）
```

In the same file, find `- **2.9 \`memvc digest --redo\` 命令**` and append ` ✓`:

```diff
-- **2.9 `memvc digest --redo` 命令**
+- **2.9 `memvc digest --redo` 命令** ✓
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/roadmap.md
git commit -m "docs(roadmap): mark Sprint 2.9 done (Sprint 2 complete)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "重跑所有 articleStatus=failed 的 thread" → Phase 1 of `runDigestRedo`, tested.
  - "强制重写上一版 chapter" → Phase 2 force-rewrite (skips `chapterNeedsRewrite`), tested.
  - "失败处理 ... 都可通过 memvc digest --redo 重跑" → entry-point command with same git push semantics as `sync`.

- **Placeholder scan:** every code step has full code; no TBD; no "similar to"; no "add validation".

- **Type consistency:**
  - `LlmRunner`, `createRunner`, `RunResult` from `src/digest/runner.ts`. ✓
  - `IndexFile`, `IndexEntry`, `Tool` from `src/types.ts`. ✓
  - `BookIndex`, `BookEntry`, `loadBookIndex`, `saveBookIndex` from `src/digest/book-index.ts`. ✓
  - `ARTICLE_VERSION`, `generateArticle` from `src/digest/article.ts`. ✓
  - `generateChapter` from `src/digest/chapter.ts` — returns `ok | no-articles | failed`. ✓
  - `generateToc` from `src/digest/toc.ts` — returns `{written: string[]}`. ✓
  - `buildArticleInputForThread` from `src/digest/pipeline.ts` — returns `ArticleInput | null`, takes `(threadId, title, sessionIds, indexFile, repoRoot, contextLabel)`. ✓
  - `loadIndex` from `src/index-store.ts`. ✓
  - `Config`, `readConfig` from `src/config.ts`. ✓
  - `ensureRepo`, `commitAndPush`, `ensureDeviceBranch` from `src/git-ops.ts`. ✓

- **Decision log (rationale for non-obvious choices):**
  - Force-chapter even when `chapterNeedsRewrite` says no, because failed-then-fixed articles plausibly imply chapter content drift, AND because users invoking `--redo` are already paying for LLM calls — a stale chapter is more painful than a redundant rewrite.
  - "skipped" article retry counted as `threadsStillFailed` (not as recovered). This is technically inaccurate (the retry didn't fail; the LLM chose to skip), but adding a fourth bucket for the rare case adds API complexity. Documented in the function comment.
  - `digestCmd` without `--redo` prints a help message rather than running the regular pipeline — that's `memvc sync`'s job; we don't want two commands doing the same thing.
  - Tests use the `runner` injection field rather than `vi.spyOn(createRunner)` — the latter has subtle ESM caching quirks (we hit them in 2.8.3) and a clean injection point in `runDigestRedoFromRepo` is simpler.

- **Out of scope (deferred, by design):**
  - Selective `--redo --thread <id>` / `--redo --project <p>` flags → potential future sprint.
  - Encrypted-mode support → blocked on broader encrypted-pipeline support.
  - Dual-branch (raw + book) push → Sprint 3.
  - Anthropic-API / GitHub-Models runner integration → Sprint 5.
