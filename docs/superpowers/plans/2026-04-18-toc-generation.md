# Sprint 2.7 — TOC Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mechanical (no-LLM) TOC generator: from a `BookIndex`, produce three artifacts — the book front page `book/index.md` (chapter list with stats), the global timeline `book/_meta/timeline.md` (all non-skipped articles newest-first), and per-chapter timelines `book/<project>/timeline.md`. Pure string concatenation, deterministic, fully unit-testable.

**Architecture:**
- `src/digest/toc.ts` exports one entry point: `generateToc(repoRoot, bookIndex)`. It writes all three kinds of files in one call.
- The function returns `{ written: string[] }` listing the relative paths it wrote, so the pipeline glue (Sprint 2.8) can git-add them precisely.
- Skipped threads (`entry.skip === true`) and failed threads (`entry.articleStatus === "failed"`) are excluded from the timelines and chapter article counts. Failed threads ARE counted separately in the front page so the user sees they exist.
- Sort order is **newest-first** in every timeline (descending by `updatedAt`). The book front page lists chapters in alphabetical project order.
- Per-chapter timeline only includes that chapter's articles. If a chapter has zero non-skipped articles, no per-chapter timeline file is written (no point listing nothing); the chapter still appears on the front page if `bookIndex.chapters[project]` exists.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies. Uses existing `BookIndex` types.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, sections "目录布局" (paths) and "Pipeline → digest.toc" (this is the mechanical step).

---

## File Structure

**New files:**
- `src/digest/toc.ts` — `generateToc()` + helpers `renderBookIndex()` / `renderGlobalTimeline()` / `renderChapterTimeline()`
- `tests/digest/toc.test.ts` — fixture-based: build a sample BookIndex, snapshot the three outputs

**Modified files:** none.

**Untouched:** every existing source file. No CLI wiring, no `sync.ts` change.

---

## Task 1: TOC generator (single task, single commit)

**Files:**
- Create: `src/digest/toc.ts`
- Create: `tests/digest/toc.test.ts`

### Output formats

#### `book/index.md` (book front page)

```markdown
# 笔记本

更新于 <ISO timestamp of latest BookEntry.updatedAt across all threads, or "—" if empty>

共 <N> 章，<M> 篇文章<, X 篇失败 if any>

## 章节

- [<project>](<project>/) — <K> 篇文章
- [<project>](<project>/) — <K> 篇文章
...

## 索引

- [全局时间线](_meta/timeline.md)
```

- Chapters are listed in alphabetical project order.
- "K 篇文章" counts only `articleStatus === "ok"` AND not `skip` for that project.
- The "X 篇失败" suffix only appears when M-failed > 0; otherwise omit the comma + suffix.
- Chapters set: union of `Object.keys(bookIndex.chapters)` AND projects appearing in `bookIndex.threads`. (A project might have articles before its chapter is generated, or vice versa.)

#### `book/_meta/timeline.md` (global timeline)

```markdown
# 全局时间线

| 时间 | 项目 | 标题 | 文章 |
|---|---|---|---|
| <updatedAt> | <project> | <title> | [link](<articlePath relative to book/_meta>) |
...
```

- One row per BookEntry where `articleStatus === "ok"` AND `!skip`.
- Newest-first by `updatedAt`. Stable secondary sort by `threadId` for determinism on ties.
- `articlePath` is stored as repo-root-relative (e.g. `book/edge-memvc/articles/...md`). For the link from `book/_meta/timeline.md` it must be made relative to `book/_meta/`, which is `../<project>/articles/...md`. Use `path.relative(dirname(timelinePath), articlePath)` with POSIX separators forced.
- If there are zero rows, write the file with the header + table head only (no body rows). This is intentional: the index points to it.

#### `book/<project>/timeline.md` (per-chapter timeline)

```markdown
# <project> · 时间线

| 时间 | 标题 | 文章 |
|---|---|---|
| <updatedAt> | <title> | [link](articles/...md) |
...
```

- One row per BookEntry for THIS project where `articleStatus === "ok"` AND `!skip`.
- Newest-first by `updatedAt`. Stable secondary sort by `threadId` for ties.
- Link is `articlePath` relative to `book/<project>/`, which simplifies to `articles/<basename>.md`.
- **Not written** when the project has zero non-skipped, non-failed articles.

### POSIX-relative path helper

Article links must use forward slashes regardless of OS. Use:

```ts
import { relative, dirname, sep } from "node:path";
function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
```

(macOS uses `/` natively, but this avoids surprises if anyone tests on Windows.)

### Tests

- [ ] **Step 1: Write failing tests**

Create `tests/digest/toc.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- toc`
Expected: FAIL with "Cannot find module '../../src/digest/toc.js'".

- [ ] **Step 3: Write `src/digest/toc.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { BookIndex, BookEntry } from "./book-index.js";

export interface GenerateTocResult {
  /** Repo-root-relative paths of every file written, suitable for git add. */
  written: string[];
}

/**
 * Mechanically (no LLM) generate the book TOC artifacts from a BookIndex:
 *   - book/index.md           — front page with chapter list
 *   - book/_meta/timeline.md  — global timeline (all ok+non-skipped articles, newest-first)
 *   - book/<project>/timeline.md — per-chapter timeline (only when the chapter has ≥1 ok+non-skipped article)
 *
 * Pure string concatenation — deterministic, easy to test, no IO except writes.
 * Spec §"Pipeline → digest.toc": this step always runs at the end of digest;
 * the pipeline glue is responsible for invoking generateToc once after articles + chapters.
 */
export function generateToc(repoRoot: string, bookIndex: BookIndex): GenerateTocResult {
  const written: string[] = [];

  // Project set: union of chapters keys and projects appearing in threads.
  const projectSet = new Set<string>();
  for (const p of Object.keys(bookIndex.chapters)) projectSet.add(p);
  for (const e of Object.values(bookIndex.threads)) projectSet.add(e.project);
  const projects = Array.from(projectSet).sort();

  // Bucket entries per project, filtering for "publishable" (ok && !skip).
  const okEntriesByProject = new Map<string, BookEntry[]>();
  for (const p of projects) okEntriesByProject.set(p, []);
  let totalOk = 0;
  let totalFailed = 0;
  for (const e of Object.values(bookIndex.threads)) {
    if (e.articleStatus === "failed") {
      totalFailed += 1;
      continue;
    }
    if (e.skip) continue;
    okEntriesByProject.get(e.project)!.push(e);
    totalOk += 1;
  }

  // Front page.
  const frontPath = "book/index.md";
  writeFile(repoRoot, frontPath, renderBookIndex({
    projects,
    okCounts: new Map(Array.from(okEntriesByProject, ([p, list]) => [p, list.length])),
    totalOk,
    totalFailed,
    latestUpdate: latestUpdate(bookIndex),
  }));
  written.push(frontPath);

  // Global timeline.
  const globalPath = "book/_meta/timeline.md";
  const allOk = ([] as BookEntry[]).concat(...okEntriesByProject.values());
  writeFile(repoRoot, globalPath, renderGlobalTimeline(allOk, globalPath));
  written.push(globalPath);

  // Per-chapter timelines.
  for (const p of projects) {
    const list = okEntriesByProject.get(p)!;
    if (list.length === 0) continue;
    const chPath = `book/${p}/timeline.md`;
    writeFile(repoRoot, chPath, renderChapterTimeline(p, list, chPath));
    written.push(chPath);
  }

  return { written };
}

/** ISO timestamp of the most recent updatedAt across all threads, or "—". */
function latestUpdate(bookIndex: BookIndex): string {
  let best: string | undefined;
  for (const e of Object.values(bookIndex.threads)) {
    if (!best || e.updatedAt > best) best = e.updatedAt;
  }
  return best ?? "—";
}

interface FrontPageInput {
  projects: string[];
  okCounts: Map<string, number>;
  totalOk: number;
  totalFailed: number;
  latestUpdate: string;
}

function renderBookIndex(input: FrontPageInput): string {
  const lines: string[] = [];
  lines.push("# 笔记本", "");
  lines.push(`更新于 ${input.latestUpdate}`, "");
  const failedSuffix = input.totalFailed > 0 ? `, ${input.totalFailed} 篇失败` : "";
  lines.push(`共 ${input.projects.length} 章，${input.totalOk} 篇文章${failedSuffix}`, "");
  lines.push("## 章节", "");
  if (input.projects.length === 0) {
    lines.push("（暂无）", "");
  } else {
    for (const p of input.projects) {
      lines.push(`- [${p}](${p}/) — ${input.okCounts.get(p) ?? 0} 篇文章`);
    }
    lines.push("");
  }
  lines.push("## 索引", "");
  lines.push("- [全局时间线](_meta/timeline.md)", "");
  return lines.join("\n");
}

function renderGlobalTimeline(entries: BookEntry[], timelinePath: string): string {
  const sorted = entries.slice().sort(timelineSort);
  const lines: string[] = [];
  lines.push("# 全局时间线", "");
  lines.push("| 时间 | 项目 | 标题 | 文章 |");
  lines.push("|---|---|---|---|");
  for (const e of sorted) {
    const link = relPosix(dirname(timelinePath), e.articlePath);
    lines.push(`| ${e.updatedAt} | ${e.project} | ${e.title} | [link](${link}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderChapterTimeline(project: string, entries: BookEntry[], timelinePath: string): string {
  const sorted = entries.slice().sort(timelineSort);
  const lines: string[] = [];
  lines.push(`# ${project} · 时间线`, "");
  lines.push("| 时间 | 标题 | 文章 |");
  lines.push("|---|---|---|");
  for (const e of sorted) {
    const link = relPosix(dirname(timelinePath), e.articlePath);
    lines.push(`| ${e.updatedAt} | ${e.title} | [link](${link}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Newest first by updatedAt; tie-broken by threadId ASC for determinism. */
function timelineSort(a: BookEntry, b: BookEntry): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/** path.relative with POSIX separators forced — links in markdown must use '/'. */
function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function writeFile(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- toc`
Expected: all tests in `toc.test.ts` pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by the new tests.

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/toc.ts tests/digest/toc.test.ts
git commit -m "feat(digest): add mechanical TOC generator (front page + global + per-chapter timelines)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "目录布局" paths (book/index.md, book/_meta/timeline.md, book/<proj>/timeline.md) → all three rendered.
  - "Pipeline → digest.toc" requires mechanical (no-LLM) generation → no runner import.
  - Skipped threads not in timelines → filter at top of `generateToc`.

- **Placeholder scan:** every code step has full code; no TBD; no "similar to above"; no "add validation".

- **Type consistency:**
  - `BookEntry` field reads (`articleStatus`, `skip`, `articlePath`, `project`, `title`, `updatedAt`, `threadId`) all exist in the `BookEntry` interface in `src/digest/book-index.ts`.
  - `BookIndex.chapters` is `Record<string, ChapterEntry>` — we read keys but not values, so no field mismatch risk.
  - Return type `{ written: string[] }` is a fresh contract, used only here.

- **Out of scope (deferred to later sprints, by design):**
  - Loop-and-call orchestration (TOC + chapter + article ordering) → Sprint 2.8 pipeline glue.
  - Detecting which TOC files git changed and committing only those → caller's job.
  - Tag/cross-reference views (`book/tags/<tag>.md`) → Sprint 7.
  - Static-site generation (MkDocs / VitePress) → Sprint 6.
