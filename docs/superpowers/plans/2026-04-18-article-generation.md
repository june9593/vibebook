# Sprint 2.5 — Article Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-thread Article generator: given one thread's metadata + concatenated session markdown, call `LlmRunner` with the article prompt, handle the LLM's "SKIP: <reason>" sentinel, write the resulting markdown to `book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md`, and update the corresponding `BookEntry` (path, version, source-sha, status). No `sync` wiring yet — Sprint 2.8 glues the pipeline together.

**Architecture:**
- `src/digest/article.ts` exports `generateArticle(runner, repoRoot, input, bookIndex)` returning a `GenerateArticleResult`. The function is **single-thread**: the caller (pipeline glue) loops over threads. Per-thread failure isolation is achieved by the function never throwing on LLM/IO errors; instead it returns a `{ status: "failed", error }` and writes a `BookEntry` with `articleStatus: "failed"`.
- The caller is responsible for loading session markdown from disk (we don't want this module coupled to raw_sessions/* path layout). The caller passes the pre-concatenated `sessionsMd` string and per-session source shas.
- A constant `ARTICLE_VERSION = 1` lives in this module. Bumping it later forces regeneration of older articles (the caller's job; this module just stamps the version it wrote).
- Filename format: `YYYY-MM-DD__<threadSlug>__<tid8>.md`. Date is `endedAt` of the thread's newest session (sliced to 10 chars). `tid8` is `threadId.slice(0, 8)` (threadId is a slug, so this is safe ASCII).
- LLM "SKIP: <reason>" sentinel is detected case-sensitively at the start of the trimmed response. When detected, no file is written; the BookEntry is upserted with `skip: true`, `skipReason`, and `articleStatus: "ok"` (skip is a successful classification, not a failure).

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies. Uses existing `LlmRunner` + `BookIndex` modules.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, sections "Pipeline → digest.article", "数据模型 → BookEntry", "Prompt 初版 → article.md", "失败处理".

---

## File Structure

**New files:**
- `src/digest/article.ts` — `generateArticle()` + `ARTICLE_VERSION` + `articleFilename()` helper
- `assets/prompts/article.md` — Chinese article prompt (verbatim from spec)
- `tests/digest/article.test.ts` — mocked runner, asserts file writes + index updates + skip + failure paths

**Modified files:** none.

**Untouched:** every existing source file. No CLI wiring, no `sync.ts` change.

---

## Task 1: Article prompt asset

**Files:**
- Create: `assets/prompts/article.md`

The prompt is copied verbatim from the spec. `article.ts` will read this file at runtime so users can override it without recompiling.

- [ ] **Step 1: Write `assets/prompts/article.md`**

```markdown
你要把下面若干个 session 合成一篇工程博客风格的文章。

要求：
- 用中文
- 结构：标题（# ）；导语 1-2 段讲背景；正文分小节讲"发现的问题 → 尝试的方案 → 最终做法 → 学到的东西"；结尾 "## 附：原始对话" 列出 raw_sessions 相对路径链接
- 避免逐字引用对话；提炼叙事
- 代码片段保留，命令行保留
- 如果内容太杂乱以至于写不成一篇文章，返回单行 "SKIP: <原因>"

THREAD_TITLE: {{title}}
SESSIONS (由旧到新):
{{sessionsMd}}
```

- [ ] **Step 2: Commit**

```bash
git add assets/prompts/article.md
git commit -m "feat(digest): add article-generation prompt asset"
```

---

## Task 2: generateArticle (single-thread, no throw on LLM/IO failure)

**Files:**
- Create: `src/digest/article.ts`
- Create: `tests/digest/article.test.ts`

### Behavior summary

`generateArticle(runner, repoRoot, input, bookIndex)`:

1. Render the article prompt with `{title, sessionsMd}` from `input`.
2. Call `runner.run(...)` with `outputFormat: "text"` (article body is markdown, not JSON).
3. On `runner` failure (`ok: false`):
   - Upsert a `BookEntry` with `articleStatus: "failed"`, `articleError: <error>`, `articlePath: ""`.
   - Return `{ status: "failed", error }`.
4. On `ok:true`, check the trimmed text for the `SKIP:` sentinel:
   - If present, upsert `BookEntry` with `skip: true`, `skipReason: <reason>`, `articleStatus: "ok"`, `articlePath: ""`.
   - Return `{ status: "skipped", skipReason }`.
5. Otherwise, write the markdown to `book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md` (creating directories), upsert `BookEntry` with `articleStatus: "ok"`, `articlePath`, `articleVersion: ARTICLE_VERSION`, `latestSourceSha`, `updatedAt: new Date().toISOString()`.
   - Return `{ status: "ok", articlePath }`.

**Failure isolation rule:** this function never throws for LLM, runner, JSON, or filesystem errors that originate downstream of the call. It catches them, marks `articleStatus: "failed"`, and returns. (Programmer errors — e.g. missing required input field — may still throw via TS type system; we don't add runtime guards for those.)

### Filename helper

`articleFilename(input)` returns the relative path `book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md`:
- `YYYY-MM-DD` = `input.endedAt.slice(0, 10)`
- `<threadSlug>` = `input.threadId` (already a slug per ThreadCandidate contract)
- `<tid8>` = `input.threadId.slice(0, 8)`
- `<project>` = `input.project`

### Why text-mode and not json-mode

The article body IS the response — it's markdown wrapped only by the optional `SKIP:` sentinel. JSON mode would force the LLM to escape every newline and quote in the markdown, which is wasteful and fragile. Text mode passes through the body as-is.

### Tests

- [ ] **Step 1: Write failing tests**

Create `tests/digest/article.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateArticle, ARTICLE_VERSION, articleFilename } from "../../src/digest/article.js";
import { saveBookIndex, loadBookIndex } from "../../src/digest/book-index.js";
import type { BookIndex } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";

function fakeRunner(reply: RunResult): LlmRunner {
  return { run: async () => reply };
}

function emptyIndex(): BookIndex {
  return { version: 1, threads: {}, chapters: {} };
}

function baseInput() {
  return {
    threadId: "fix-auth-bug",
    project: "edge-memvc",
    title: "修 auth 跳转",
    sessionIds: ["s1", "s2"],
    sessionShas: ["sha-s1", "sha-s2"],
    sessionsMd: "## session 1\n...\n## session 2\n...",
    endedAt: "2026-04-15T10:30:00Z",
  };
}

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-article-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("articleFilename", () => {
  it("produces book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md", () => {
    expect(articleFilename(baseInput())).toBe(
      "book/edge-memvc/articles/2026-04-15__fix-auth-bug__fix-auth.md",
    );
  });

  it("uses the first 8 chars of threadId for the tid8 segment, even for short slugs", () => {
    const f = articleFilename({ ...baseInput(), threadId: "fix" });
    expect(f).toBe("book/edge-memvc/articles/2026-04-15__fix__fix.md");
  });
});

describe("generateArticle — happy path", () => {
  it("writes the markdown body verbatim and updates BookIndex with status=ok", async () => {
    const body = "# 修 auth 跳转\n\n背景...\n\n## 附：原始对话\n- raw_sessions/...";
    const runner = fakeRunner({ ok: true, text: body, durationMs: 1 });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx);

    expect(res.status).toBe("ok");
    expect(res.articlePath).toBe(
      "book/edge-memvc/articles/2026-04-15__fix-auth-bug__fix-auth.md",
    );

    const written = readFileSync(join(repoRoot, res.articlePath!), "utf8");
    expect(written).toBe(body);

    const entry = idx.threads["fix-auth-bug"];
    expect(entry).toBeDefined();
    expect(entry.articleStatus).toBe("ok");
    expect(entry.articlePath).toBe(res.articlePath);
    expect(entry.articleVersion).toBe(ARTICLE_VERSION);
    expect(entry.sessionIds).toEqual(["s1", "s2"]);
    expect(entry.title).toBe("修 auth 跳转");
    expect(entry.project).toBe("edge-memvc");
    expect(entry.skip).toBeUndefined();
    expect(entry.articleError).toBeUndefined();
    expect(entry.latestSourceSha).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls the runner with outputFormat:'text' and the rendered prompt vars", async () => {
    let capturedVars: Record<string, string> | undefined;
    let capturedOpts: { outputFormat?: string } | undefined;
    const runner: LlmRunner = {
      run: async (_p, vars, opts) => {
        capturedVars = vars;
        capturedOpts = opts;
        return { ok: true, text: "# t\n\nbody", durationMs: 1 };
      },
    };
    await generateArticle(runner, repoRoot, baseInput(), emptyIndex());
    expect(capturedOpts?.outputFormat).toBe("text");
    expect(capturedVars?.title).toBe("修 auth 跳转");
    expect(capturedVars?.sessionsMd).toBe("## session 1\n...\n## session 2\n...");
  });
});

describe("generateArticle — SKIP sentinel", () => {
  it("does not write a file, marks BookEntry skip:true with skipReason, returns status=skipped", async () => {
    const runner = fakeRunner({
      ok: true,
      text: "SKIP: 内容只有几句寒暄，没有工程价值",
      durationMs: 1,
    });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx);

    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("内容只有几句寒暄，没有工程价值");

    // No article file should exist.
    expect(existsSync(join(repoRoot, "book", "edge-memvc", "articles"))).toBe(false);

    const entry = idx.threads["fix-auth-bug"];
    expect(entry.skip).toBe(true);
    expect(entry.skipReason).toBe("内容只有几句寒暄，没有工程价值");
    expect(entry.articleStatus).toBe("ok");
    expect(entry.articlePath).toBe("");
  });

  it("tolerates leading whitespace before SKIP:", async () => {
    const runner = fakeRunner({ ok: true, text: "  \n  SKIP: 太短", durationMs: 1 });
    const res = await generateArticle(runner, repoRoot, baseInput(), emptyIndex());
    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("太短");
  });

  it("does NOT trigger SKIP when the body merely contains 'SKIP:' mid-text", async () => {
    const runner = fakeRunner({
      ok: true,
      text: "# 标题\n\n这里讨论了 SKIP: 标志的实现",
      durationMs: 1,
    });
    const res = await generateArticle(runner, repoRoot, baseInput(), emptyIndex());
    expect(res.status).toBe("ok");
  });
});

describe("generateArticle — failure path", () => {
  it("on runner ok:false, sets articleStatus=failed + articleError and returns failed (does NOT throw)", async () => {
    const runner = fakeRunner({ ok: false, error: "timeout after 180s", durationMs: 180_000 });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx);

    expect(res.status).toBe("failed");
    expect(res.error).toBe("timeout after 180s");

    const entry = idx.threads["fix-auth-bug"];
    expect(entry.articleStatus).toBe("failed");
    expect(entry.articleError).toBe("timeout after 180s");
    expect(entry.articlePath).toBe("");
  });

  it("on filesystem write error, returns failed and marks BookEntry without throwing", async () => {
    // Force a write error by making the project segment something the FS rejects.
    // Use a NUL byte — illegal in posix paths.
    const runner = fakeRunner({ ok: true, text: "# t\n\nbody", durationMs: 1 });
    const input = { ...baseInput(), project: "bad\0name" };
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, input, idx);

    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/.+/); // non-empty
    const entry = idx.threads["fix-auth-bug"];
    expect(entry.articleStatus).toBe("failed");
  });
});

describe("generateArticle — index persistence integration", () => {
  it("BookEntry survives saveBookIndex → loadBookIndex round-trip", async () => {
    const runner = fakeRunner({ ok: true, text: "# t\n\nbody", durationMs: 1 });
    const idx = emptyIndex();
    await generateArticle(runner, repoRoot, baseInput(), idx);
    saveBookIndex(repoRoot, idx);
    const loaded = loadBookIndex(repoRoot);
    expect(loaded.threads["fix-auth-bug"].articleStatus).toBe("ok");
    expect(loaded.threads["fix-auth-bug"].articleVersion).toBe(ARTICLE_VERSION);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- article`
Expected: FAIL with "Cannot find module '../../src/digest/article.js'".

- [ ] **Step 3: Write `src/digest/article.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { LlmRunner } from "./runner.js";
import { renderPrompt } from "./runner.js";
import {
  type BookIndex,
  type BookEntry,
  upsertThread,
  latestSourceShaFor,
} from "./book-index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bump this when the article prompt or output format changes in a way that
 * makes older articles need regeneration. Stamped onto every BookEntry; the
 * pipeline glue (Sprint 2.8) compares against current to decide what to redo.
 */
export const ARTICLE_VERSION = 1;

function loadArticlePrompt(): string {
  // src/digest/article.ts → ../../assets/prompts/article.md  (and same from dist/)
  const p = join(__dirname, "..", "..", "assets", "prompts", "article.md");
  return readFileSync(p, "utf8");
}

const ARTICLE_PROMPT = loadArticlePrompt();

export interface ArticleInput {
  /** Stable thread id (slug, lowercase-hyphenated). Used as BookIndex key + filename. */
  threadId: string;
  /** Project slug — becomes a directory under book/. */
  project: string;
  /** Human title (Chinese, ≤ 20 chars). Stored on the BookEntry. */
  title: string;
  /** Session ids that belong to this thread. */
  sessionIds: string[];
  /** Source shas for the same sessions, in the same order — used to compute latestSourceSha. */
  sessionShas: string[];
  /** Pre-concatenated markdown of all sessions (caller-loaded; we don't read raw_sessions). */
  sessionsMd: string;
  /** ISO timestamp of the thread's most recent session — drives the YYYY-MM-DD filename prefix. */
  endedAt: string;
}

export type GenerateArticleResult =
  | { status: "ok"; articlePath: string }
  | { status: "skipped"; skipReason: string }
  | { status: "failed"; error: string };

/**
 * Build the relative path the article will be written to.
 * Format: book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md
 */
export function articleFilename(input: ArticleInput): string {
  const date = input.endedAt.slice(0, 10);
  const tid8 = input.threadId.slice(0, 8);
  return join("book", input.project, "articles", `${date}__${input.threadId}__${tid8}.md`);
}

/**
 * Generate one article for one thread.
 *
 * - Calls the runner in text mode (the response IS the markdown body).
 * - Detects the LLM's "SKIP: <reason>" sentinel at the start (after trim) and
 *   marks the BookEntry skip=true without writing a file.
 * - On any runner or IO failure, marks the BookEntry articleStatus="failed"
 *   and returns; never throws (per-thread failure isolation, spec §失败处理).
 *
 * Always upserts a BookEntry into `bookIndex` so the caller can persist with
 * a single saveBookIndex() at the end.
 */
export async function generateArticle(
  runner: LlmRunner,
  repoRoot: string,
  input: ArticleInput,
  bookIndex: BookIndex,
): Promise<GenerateArticleResult> {
  const nowIso = new Date().toISOString();
  const sourceSha = latestSourceShaFor(input.sessionShas);

  let res;
  try {
    res = await runner.run(
      ARTICLE_PROMPT,
      { title: input.title, sessionsMd: input.sessionsMd },
      { outputFormat: "text" },
    );
  } catch (e) {
    // Defensive: a well-behaved runner returns ok:false rather than throwing,
    // but we treat a thrown error the same way to preserve isolation.
    const error = (e as Error).message;
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, error));
    return { status: "failed", error };
  }

  if (!res.ok) {
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, res.error));
    return { status: "failed", error: res.error };
  }

  const trimmed = res.text.trimStart();
  if (trimmed.startsWith("SKIP:")) {
    const skipReason = trimmed.slice("SKIP:".length).split(/\r?\n/, 1)[0]!.trim();
    const entry: BookEntry = {
      threadId: input.threadId,
      project: input.project,
      title: input.title,
      sessionIds: input.sessionIds,
      articlePath: "",
      articleVersion: ARTICLE_VERSION,
      latestSourceSha: sourceSha,
      articleStatus: "ok",
      skip: true,
      skipReason,
      updatedAt: nowIso,
    };
    upsertThread(bookIndex, entry);
    return { status: "skipped", skipReason };
  }

  const articlePath = articleFilename(input);
  try {
    const abs = join(repoRoot, articlePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.text);
  } catch (e) {
    const error = (e as Error).message;
    upsertThread(bookIndex, failedEntry(input, sourceSha, nowIso, error));
    return { status: "failed", error };
  }

  const entry: BookEntry = {
    threadId: input.threadId,
    project: input.project,
    title: input.title,
    sessionIds: input.sessionIds,
    articlePath,
    articleVersion: ARTICLE_VERSION,
    latestSourceSha: sourceSha,
    articleStatus: "ok",
    updatedAt: nowIso,
  };
  upsertThread(bookIndex, entry);
  return { status: "ok", articlePath };
}

function failedEntry(
  input: ArticleInput,
  sourceSha: string,
  nowIso: string,
  error: string,
): BookEntry {
  return {
    threadId: input.threadId,
    project: input.project,
    title: input.title,
    sessionIds: input.sessionIds,
    articlePath: "",
    articleVersion: ARTICLE_VERSION,
    latestSourceSha: sourceSha,
    articleStatus: "failed",
    articleError: error,
    updatedAt: nowIso,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- article`
Expected: all tests in `article.test.ts` pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by the new tests.

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/article.ts tests/digest/article.test.ts
git commit -m "feat(digest): add Article generator (single-thread, SKIP sentinel, no-throw failure)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "digest.article" pipeline section (§Pipeline 5) → `generateArticle` writes to the spec'd path, updates BookEntry fields per §数据模型.
  - SKIP sentinel (§Prompt 初版 → article.md last bullet) → handled in code + 3 tests.
  - Per-thread failure isolation (§失败处理: "阶段 5（article）单条失败 → 该 thread 置 articleStatus: 'failed'，其它 thread 继续") → `generateArticle` never throws on runner/IO error; caller's loop is unaffected.
  - Article version stamping (§BookEntry.articleVersion) → `ARTICLE_VERSION = 1` exported and stamped.
  - latestSourceSha (§BookEntry.latestSourceSha) → computed via existing `latestSourceShaFor()`.

- **Placeholder scan:** every code step has full code; no TBD; no "similar to above"; no "add validation".

- **Type consistency:**
  - `ArticleInput.threadId` matches `ThreadCandidate.threadId` (string slug).
  - `BookEntry` fields written match the interface in `src/digest/book-index.ts` (verified: `threadId`, `project`, `title`, `sessionIds`, `articlePath`, `articleVersion`, `latestSourceSha`, `articleStatus`, `articleError?`, `skip?`, `skipReason?`, `updatedAt`).
  - `RunOptions.outputFormat: "text"` is supported by `LlmRunner` (Sprint 2.1 added it).
  - `latestSourceShaFor(string[])` signature matches `book-index.ts`.

- **Out of scope (deferred to later sprints, by design):**
  - Loading session markdown from disk → caller's job (Sprint 2.8).
  - Iterating over multiple threads → caller's job (Sprint 2.8).
  - Deciding whether to regen (compare `articleVersion` / `latestSourceSha`) → caller's job (Sprint 2.8).
  - The `## 附：原始对话` raw_sessions links → the prompt asks the LLM to produce them; we don't post-process.
