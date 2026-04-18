# Sprint 2.6 — Chapter Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the project-level "chapter preface" generator: for each project whose articles have changed, call the LLM with the chapter prompt over all current ok+non-skipped articles for that project, full-rewrite `book/<project>/chapter.md`, and update `BookIndex.chapters[project]` with version + timestamp + `latestArticleHash`.

**Architecture:**
- `src/digest/chapter.ts` exports two entry points: `chapterNeedsRewrite(bookIndex, project)` (pure, computes the current article-hash for that project and compares to `chapters[project]?.latestArticleHash`) and `generateChapter(runner, repoRoot, project, bookIndex)` (calls the runner, writes `book/<project>/chapter.md`, updates `bookIndex.chapters[project]`).
- Failure isolation per spec §阶段 6: the runner failing for one chapter leaves the previous `chapter.md` and the previous `ChapterEntry` untouched and returns `{ status: "failed", error }`. Never throws.
- `latestArticleHash` is a SHA-256 over the project's ok+non-skipped article list, sorted by `threadId` ASC for determinism, hashing each entry's `threadId + articleVersion + latestSourceSha`. This catches both content changes (sessions changed) and prompt-version bumps (article regenerated).
- Prompt is loaded once at module load (matches `article.ts` pattern).

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, sections "Pipeline → digest.chapter" (line 121-124) and "失败处理 阶段 6" (line 139), plus the chapter prompt at the §"chapter.md" section.

---

## File Structure

**New files:**
- `assets/prompts/chapter.md` — verbatim from spec §"chapter.md" prompt
- `src/digest/chapter.ts` — `CHAPTER_VERSION`, `chapterNeedsRewrite()`, `computeChapterArticleHash()`, `generateChapter()`
- `tests/digest/chapter.test.ts` — fake runner, tmp repo, covers no-rewrite-when-unchanged / full rewrite / failure-preserves-prior / hash determinism / skipped-and-failed-articles-excluded

**Modified files:** none.

**Untouched:** `src/digest/article.ts`, `src/digest/toc.ts`, `src/commands/sync.ts`. The pipeline glue that decides "which projects to chapterize" is Sprint 2.8.

---

## Task 1: Chapter prompt asset

**Files:**
- Create: `assets/prompts/chapter.md`

- [ ] **Step 1: Write the prompt file**

Create `assets/prompts/chapter.md` with exactly this content (verbatim from the spec):

```
你要为一个项目写"章前言"，介绍这个项目以及我在上面做过的主要事情。

要求：
- 用中文
- 结构：# <项目名>；一段项目是什么；"## 主要工作" 小节分点列出每一篇文章讲了啥；"## 发现 / 坑" 小节汇总踩过的坑与结论
- 简洁，≤ 800 字

ARTICLES (新到旧):
{{articles}}
```

- [ ] **Step 2: Commit**

```bash
git add assets/prompts/chapter.md
git commit -m "feat(digest): add chapter-generation prompt asset"
```

---

## Task 2: Chapter generator (single commit, TDD)

**Files:**
- Create: `src/digest/chapter.ts`
- Create: `tests/digest/chapter.test.ts`

### Public surface

```ts
export const CHAPTER_VERSION: number;

export interface ChapterArticleSummary {
  /** Stable identifier for hashing — caller passes BookEntry data through. */
  threadId: string;
  articleVersion: number;
  latestSourceSha: string;
}

export type GenerateChapterResult =
  | { status: "ok"; chapterPath: string }
  | { status: "no-articles" }
  | { status: "failed"; error: string };

/**
 * SHA-256 over the project's publishable articles (sorted by threadId ASC),
 * hashing `threadId + "\0" + articleVersion + "\0" + latestSourceSha` per entry.
 * Identical projects always hash equal regardless of insertion order.
 */
export function computeChapterArticleHash(articles: ChapterArticleSummary[]): string;

/**
 * True iff the project's current article hash differs from
 * `bookIndex.chapters[project]?.latestArticleHash`. Treats a missing chapter
 * entry as "needs rewrite" (so a brand-new project is chapterized).
 *
 * Returns false if the project has zero publishable articles AND no chapter
 * entry exists yet — there's nothing to write.
 */
export function chapterNeedsRewrite(bookIndex: BookIndex, project: string): boolean;

/**
 * Full-rewrite `book/<project>/chapter.md` from the project's publishable
 * articles. Always upserts a fresh ChapterEntry into bookIndex on success.
 * On failure, leaves the previous chapter.md AND the previous ChapterEntry
 * untouched and returns `{status: "failed", error}` (spec §阶段 6).
 *
 * Returns `{status: "no-articles"}` when the project has zero publishable
 * articles — no file is written, no entry is upserted.
 */
export async function generateChapter(
  runner: LlmRunner,
  repoRoot: string,
  project: string,
  bookIndex: BookIndex,
): Promise<GenerateChapterResult>;
```

### Tests

- [ ] **Step 1: Write failing test file**

Create `tests/digest/chapter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chapter`
Expected: FAIL with "Cannot find module '../../src/digest/chapter.js'".

- [ ] **Step 3: Write `src/digest/chapter.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { LlmRunner } from "./runner.js";
import {
  type BookIndex,
  type BookEntry,
  type ChapterEntry,
  upsertChapter,
} from "./book-index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bump when the chapter prompt or output format changes in a way that should
 * force regeneration of every chapter.md. (Currently unused by chapterNeedsRewrite —
 * version drift is reflected via latestArticleHash through articleVersion.)
 */
export const CHAPTER_VERSION = 1;

function loadChapterPrompt(): string {
  // src/digest/chapter.ts → ../../assets/prompts/chapter.md (and same from dist/)
  const p = join(__dirname, "..", "..", "assets", "prompts", "chapter.md");
  return readFileSync(p, "utf8");
}

const CHAPTER_PROMPT = loadChapterPrompt();

export interface ChapterArticleSummary {
  threadId: string;
  articleVersion: number;
  latestSourceSha: string;
}

export type GenerateChapterResult =
  | { status: "ok"; chapterPath: string }
  | { status: "no-articles" }
  | { status: "failed"; error: string };

/**
 * SHA-256 over the project's publishable articles, sorted by threadId ASC.
 * Per entry: threadId + "\0" + articleVersion + "\0" + latestSourceSha + "\0".
 * Domain prefix prevents collisions with other hashes in the codebase.
 */
export function computeChapterArticleHash(articles: ChapterArticleSummary[]): string {
  const sorted = articles.slice().sort((a, b) =>
    a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0,
  );
  const h = createHash("sha256");
  h.update("memvc:book:chapter:v1");
  for (const a of sorted) {
    h.update("\0");
    h.update(a.threadId);
    h.update("\0");
    h.update(String(a.articleVersion));
    h.update("\0");
    h.update(a.latestSourceSha);
  }
  return h.digest("hex");
}

/** Filter the BookIndex to publishable BookEntries for one project. */
function publishableArticlesFor(bookIndex: BookIndex, project: string): BookEntry[] {
  const out: BookEntry[] = [];
  for (const e of Object.values(bookIndex.threads)) {
    if (e.project !== project) continue;
    if (e.articleStatus === "failed") continue;
    if (e.skip) continue;
    if (!e.articlePath) continue;
    out.push(e);
  }
  return out;
}

function summaryFor(e: BookEntry): ChapterArticleSummary {
  return {
    threadId: e.threadId,
    articleVersion: e.articleVersion,
    latestSourceSha: e.latestSourceSha,
  };
}

export function chapterNeedsRewrite(bookIndex: BookIndex, project: string): boolean {
  const articles = publishableArticlesFor(bookIndex, project);
  const existing = bookIndex.chapters[project];
  if (articles.length === 0) {
    // Nothing to write and no prior chapter — leave it alone.
    return existing !== undefined ? false : false;
  }
  if (!existing) return true;
  const currentHash = computeChapterArticleHash(articles.map(summaryFor));
  return currentHash !== existing.latestArticleHash;
}

/**
 * Render the {{articles}} variable: each publishable article's body, newest
 * first, separated by a header line so the LLM can tell them apart.
 */
function renderArticlesVar(repoRoot: string, articles: BookEntry[]): string {
  const sorted = articles.slice().sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
  });
  const parts: string[] = [];
  for (const e of sorted) {
    const body = readFileSync(join(repoRoot, e.articlePath), "utf8");
    parts.push(`--- ARTICLE ${e.threadId} (${e.updatedAt}) ---\n${body}`);
  }
  return parts.join("\n\n");
}

export async function generateChapter(
  runner: LlmRunner,
  repoRoot: string,
  project: string,
  bookIndex: BookIndex,
): Promise<GenerateChapterResult> {
  const articles = publishableArticlesFor(bookIndex, project);
  if (articles.length === 0) return { status: "no-articles" };

  let articlesVar: string;
  try {
    articlesVar = renderArticlesVar(repoRoot, articles);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  let res;
  try {
    res = await runner.run(
      CHAPTER_PROMPT,
      { articles: articlesVar },
      { outputFormat: "text" },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  if (!res.ok) return { status: "failed", error: res.error };

  const chapterPath = join("book", project, "chapter.md");
  try {
    const abs = join(repoRoot, chapterPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.text);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: "failed", error };
  }

  const entry: ChapterEntry = {
    chapterVersion: CHAPTER_VERSION,
    lastFullRewrite: new Date().toISOString(),
    latestArticleHash: computeChapterArticleHash(articles.map(summaryFor)),
  };
  upsertChapter(bookIndex, project, entry);
  return { status: "ok", chapterPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chapter`
Expected: all chapter tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by the new tests (was 102 → 102 + new).

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/chapter.ts tests/digest/chapter.test.ts
git commit -m "feat(digest): add Chapter generator (full rewrite, latestArticleHash gate, failure preserves prior)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "Pipeline → digest.chapter (only for projects whose articles changed)" → `chapterNeedsRewrite()` is the gate; the caller (Sprint 2.8) loops over projects and calls only when true.
  - "全量重写 chapter.md" → `generateChapter()` overwrites `book/<project>/chapter.md`.
  - "更新 BookIndex.chapters[proj].lastFullRewrite" → done on success, with `chapterVersion` and `latestArticleHash` too.
  - "阶段 6 失败 → 保留上一版 chapter.md, 打印 warning" → file/entry untouched on failure; warning is the caller's job (returning `failed` is the contract).
  - Spec prompt verbatim → Task 1 stores it.
  - "ARTICLES (新到旧)" — newest-first sort by `updatedAt` with stable threadId tiebreak in `renderArticlesVar`.

- **Placeholder scan:** every code step has full code. No "TBD" / "similar to" / "add validation".

- **Type consistency:**
  - `BookEntry` field reads (`project`, `articleStatus`, `skip`, `articlePath`, `articleVersion`, `latestSourceSha`, `threadId`, `updatedAt`) all exist in `src/digest/book-index.ts`.
  - `ChapterEntry` write fields (`chapterVersion`, `lastFullRewrite`, `latestArticleHash`) match the interface.
  - `upsertChapter(idx, project, entry)` signature matches `src/digest/book-index.ts:58`.
  - `LlmRunner.run(prompt, vars, opts)` signature matches `src/digest/runner.ts:16`.
  - `RunResult` discriminated union (`ok: true|false`) matches `src/digest/runner.ts:6-8`.

- **Sibling pattern parity with `article.ts`:**
  - Same module-load prompt cache (`const CHAPTER_PROMPT = loadChapterPrompt();`).
  - Same `e instanceof Error ? e.message : String(e)` pattern in three catch blocks.
  - Same `outputFormat: "text"` for runner call (response IS the markdown body).

- **Out of scope (deferred, by design):**
  - Pipeline glue (which projects to chapterize, in what order) → Sprint 2.8.
  - Incremental chapter rewrite (only changed sub-sections) → Sprint 7.1.
  - `memvc digest --redo` invocation that force-rewrites all chapters → Sprint 2.9.
  - Multi-device chapter merge on `main` → Sprint 4.
