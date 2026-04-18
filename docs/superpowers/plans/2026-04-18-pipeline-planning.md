# Sprint 2.8.1 — Pipeline Planning + Threading Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first half of the digest pipeline glue: a pure-logic `pipeline.ts` module that (a) finds new sessions in `index.json` not yet covered by `BookIndex`, (b) reads their markdown bodies and computes token estimates to produce `SessionForBatching[]` for the batcher, (c) records skipped-by-threading candidates as `skip:true` BookEntries, and (d) materializes article inputs for the article phase. All unit-tested with a fake fs / fake runner — no `sync.ts` changes yet.

**Architecture:**
- One new file `src/digest/pipeline.ts` exposes four pure functions (no IO except reading session `.md` files for token-estimate). Every function is independently testable. The functions are composable: `sync.ts` (in 2.8.3) calls them in sequence.
- `pipeline.ts` is the only place that knows how to translate between the existing `IndexFile` / `IndexEntry` types (raw layer, Sprint 1) and the `BookIndex` / `BookEntry` / `ChapterEntry` types + intermediate `SessionForBatching` / `ArticleInput` types (digest layer, Sprint 2.x).
- Skipped-by-threading candidates (LLM said "this thread has no real content") get persisted as BookEntries with `skip:true, articleStatus:"ok", articlePath:""` so the next sync doesn't reconsider them.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, "Pipeline → digest.plan" (line ~95-100) and "digest.thread" (line ~102-110). Spec phrase: 「扫 .memvc/index.json 找新 session」+「分配进相应 thread」.

---

## Where 2.8.1 sits in the sub-sprint sequence

Sprint 2.8 is split into three sub-sprints to avoid a giant unreviewable PR:

- **2.8.1 (this plan):** `pipeline.ts` planning + threading-output translation (no IO except reading session .md). Pure functions, fully unit-testable. Ships green tests, does NOT modify `sync.ts`.
- **2.8.2 (next plan):** Top-level `runDigest(runner, repoRoot, indexFile, bookIndex)` orchestrator that loops `pipeline.ts` outputs through `article.ts` → `chapter.ts` → `toc.ts`. Still no `sync.ts` change — testable end-to-end with a fake runner against a tmp repo.
- **2.8.3 (final plan):** Wire `runDigest` into `commands/sync.ts`, add `--no-digest` flag, integration test that runs `memvc sync` against a fixture repo with a fake runner and asserts `book/` contents.

This file plans only 2.8.1.

---

## File Structure

**New files:**
- `src/digest/pipeline.ts` — four exported functions + small helpers
- `tests/digest/pipeline.test.ts` — fake `IndexFile` / `BookIndex` / fixture session .md files in tmp dirs

**Modified files:** none.

**Untouched:** `src/commands/sync.ts`, every existing test, every existing source file.

---

## Task 1: Pipeline planning module (single TDD task)

**Files:**
- Create: `src/digest/pipeline.ts`
- Create: `tests/digest/pipeline.test.ts`

### Public surface

```ts
import type { IndexFile, IndexEntry } from "../types.js";
import type { BookIndex } from "./book-index.js";
import type { SessionForBatching, ThreadCandidate } from "./types.js";
import type { ArticleInput } from "./article.js";

/**
 * IndexEntries that the BookIndex hasn't accounted for yet. An entry is
 * "covered" iff its `${tool}:${sessionId}` key (or just `sessionId` — see note)
 * appears in some BookEntry.sessionIds.
 *
 * NOTE on key shape: Sprint 1 keys IndexFile.entries by `${tool}:${sessionId}`,
 * but BookEntry.sessionIds historically stores bare sessionIds. We treat the
 * raw `sessionId` (no tool prefix) as the matching key — sessionIds are
 * source-native UUIDs in practice and don't collide across tools.
 *
 * Returns entries sorted by endedAt ASC (the order downstream batching wants).
 */
export function findNewSessionEntries(
  indexFile: IndexFile,
  bookIndex: BookIndex,
): IndexEntry[];

/**
 * Read each entry's session .md from disk, compute tokenEstimate
 * (char count / 3.5, rounded UP), and produce SessionForBatching[].
 *
 * Reads the plaintext .md (relativePath in IndexEntry); encrypted-mode (.enc)
 * support is out of scope for 2.8.1 — pipeline.ts is invoked only when
 * config.encrypt is false in 2.8.3, and we throw clearly if we encounter a
 * `.enc` path.
 *
 * If a session's .md is missing or unreadable, throws — the caller should
 * abort the digest (a missing source means upstream extract is broken; better
 * to fail loud than silently drop).
 */
export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
): SessionForBatching[];

/**
 * For each ThreadCandidate marked skip:true, persist a BookEntry with
 * skip=true, articleStatus="ok", articlePath="", title=candidate.title,
 * skipReason=candidate.reason, project=session's project (looked up from
 * IndexFile by sessionId).
 *
 * For non-skip candidates, this function does nothing — they're consumed by
 * `buildArticleInputs` next.
 *
 * Returns the list of skipped threadIds (for caller logging).
 */
export function recordSkippedThreadCandidates(
  bookIndex: BookIndex,
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
): string[];

/**
 * For each non-skip ThreadCandidate, produce an ArticleInput by gathering:
 *   - sessionIds from candidate
 *   - project from the first session's IndexEntry (asserts all sessions in the
 *     candidate share the same project — threading respects project locality;
 *     if they don't agree, throws — that means upstream batching/threading
 *     leaked across projects)
 *   - sessionShas: each session's sourceSha256 (SAME ORDER as sessionIds)
 *   - sessionsMd: concatenation of each session's .md body, separated by
 *     "\n\n--- SESSION <shortId> (<endedAt>) ---\n\n", in endedAt ASC order
 *     (the article prompt expects 由旧到新)
 *   - endedAt: max endedAt across the thread's sessions
 *
 * Drops candidates whose sessionIds don't ALL appear in indexFile (returns a
 * shorter list and logs to console.warn — caller is informational only).
 */
export function buildArticleInputs(
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
  repoRoot: string,
): ArticleInput[];
```

### Tests

- [ ] **Step 1: Write failing test file**

Create `tests/digest/pipeline.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findNewSessionEntries,
  buildBatchingInput,
  recordSkippedThreadCandidates,
  buildArticleInputs,
} from "../../src/digest/pipeline.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex, BookEntry } from "../../src/digest/book-index.js";
import type { ThreadCandidate } from "../../src/digest/types.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-pipeline-"));
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
    nameSlug: "first-session",
    displayName: "First session",
    relativePath: "raw_sessions/claude/proj-a/2026-04-15/first-session__sid-1.md",
    sourcePath: "/tmp/orig/first.jsonl",
    sourceMtimeMs: 1_000_000,
    sourceSha256: "shaA",
    ...over,
  };
}

function be(over: Partial<BookEntry> = {}): BookEntry {
  return {
    threadId: "t1",
    project: "proj-a",
    title: "标题",
    sessionIds: ["sid-1"],
    articlePath: "book/proj-a/articles/2026-04-15__t1__t1.md",
    articleVersion: 1,
    latestSourceSha: "deadbeef",
    articleStatus: "ok",
    updatedAt: "2026-04-15T10:00:00Z",
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

// =====================================================================
describe("findNewSessionEntries", () => {
  it("returns empty when every IndexEntry sessionId appears in some BookEntry", () => {
    const e = ie({ sessionId: "sid-1" });
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: { t1: be({ sessionIds: ["sid-1"] }) },
      chapters: {},
    };
    expect(findNewSessionEntries(idx, book)).toEqual([]);
  });

  it("returns entries whose sessionId is NOT in any BookEntry.sessionIds", () => {
    const e1 = ie({ sessionId: "sid-1", endedAt: "2026-04-15T10:00:00Z" });
    const e2 = ie({ sessionId: "sid-2", endedAt: "2026-04-16T10:00:00Z" });
    const idx = makeIndex([e1, e2]);
    const book: BookIndex = {
      version: 1,
      threads: { t1: be({ sessionIds: ["sid-1"] }) },
      chapters: {},
    };
    const got = findNewSessionEntries(idx, book);
    expect(got.map((x) => x.sessionId)).toEqual(["sid-2"]);
  });

  it("returns all entries when bookIndex is empty", () => {
    const e1 = ie({ sessionId: "sid-1", endedAt: "2026-04-15T10:00:00Z" });
    const e2 = ie({ sessionId: "sid-2", endedAt: "2026-04-14T10:00:00Z" });
    const idx = makeIndex([e1, e2]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const got = findNewSessionEntries(idx, book);
    // Sorted by endedAt ASC.
    expect(got.map((x) => x.sessionId)).toEqual(["sid-2", "sid-1"]);
  });

  it("considers an IndexEntry covered if ANY thread's sessionIds contain it (not just one project)", () => {
    const e1 = ie({ sessionId: "sid-1" });
    const idx = makeIndex([e1]);
    const book: BookIndex = {
      version: 1,
      threads: {
        ta: be({ threadId: "ta", project: "proj-a", sessionIds: ["other"] }),
        tb: be({ threadId: "tb", project: "proj-b", sessionIds: ["sid-1"] }),
      },
      chapters: {},
    };
    expect(findNewSessionEntries(idx, book)).toEqual([]);
  });
});

// =====================================================================
describe("buildBatchingInput", () => {
  it("reads each session's .md, sets project/endedAt, and computes ceil(charCount/3.5) tokens", () => {
    const body = "x".repeat(35); // 35 chars → ceil(35/3.5) = 10 tokens
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/x.md" });
    writeSessionMd(e.relativePath, body);
    const got = buildBatchingInput([e], repoRoot);
    expect(got).toEqual([
      {
        sessionId: e.sessionId,
        project: e.project,
        endedAt: e.endedAt,
        tokenEstimate: 10,
      },
    ]);
  });

  it("rounds up partial token estimates", () => {
    const body = "x".repeat(36); // 36/3.5 = 10.28 → 11
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/y.md" });
    writeSessionMd(e.relativePath, body);
    const got = buildBatchingInput([e], repoRoot);
    expect(got[0]!.tokenEstimate).toBe(11);
  });

  it("processes multiple entries preserving input order", () => {
    const e1 = ie({ sessionId: "s1", relativePath: "raw_sessions/c/p/2026-04-15/a.md" });
    const e2 = ie({ sessionId: "s2", relativePath: "raw_sessions/c/p/2026-04-15/b.md" });
    writeSessionMd(e1.relativePath, "aa");
    writeSessionMd(e2.relativePath, "bbb");
    const got = buildBatchingInput([e1, e2], repoRoot);
    expect(got.map((x) => x.sessionId)).toEqual(["s1", "s2"]);
  });

  it("throws when relativePath ends with .enc (encryption is out of scope for 2.8.1)", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/secret.md.enc" });
    expect(() => buildBatchingInput([e], repoRoot)).toThrow(/encrypted/);
  });

  it("throws clearly when a session's .md is missing on disk", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/missing.md" });
    expect(() => buildBatchingInput([e], repoRoot)).toThrow(/missing\.md/);
  });
});

// =====================================================================
describe("recordSkippedThreadCandidates", () => {
  it("upserts a skip:true BookEntry for each skip candidate, leaves non-skip alone", () => {
    const idx = makeIndex([
      ie({ sessionId: "sid-1", project: "proj-a" }),
      ie({ sessionId: "sid-2", project: "proj-a" }),
    ]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const cands: ThreadCandidate[] = [
      { threadId: "skip-thread", title: "略过", sessionIds: ["sid-1"], skip: true, reason: "太短" },
      { threadId: "keep-thread", title: "保留", sessionIds: ["sid-2"] },
    ];
    const skipped = recordSkippedThreadCandidates(book, cands, idx);
    expect(skipped).toEqual(["skip-thread"]);
    expect(book.threads["skip-thread"]).toMatchObject({
      threadId: "skip-thread",
      project: "proj-a",
      title: "略过",
      sessionIds: ["sid-1"],
      articlePath: "",
      articleStatus: "ok",
      skip: true,
      skipReason: "太短",
    });
    expect(book.threads["keep-thread"]).toBeUndefined();
  });

  it("skip BookEntry's project is taken from the first session's IndexEntry", () => {
    const idx = makeIndex([ie({ sessionId: "sid-1", project: "from-index" })]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    recordSkippedThreadCandidates(
      book,
      [{ threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "x" }],
      idx,
    );
    expect(book.threads["t"]!.project).toBe("from-index");
  });

  it("skip BookEntry has updatedAt set to an ISO string", () => {
    const idx = makeIndex([ie({ sessionId: "sid-1" })]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    recordSkippedThreadCandidates(
      book,
      [{ threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "" }],
      idx,
    );
    expect(book.threads["t"]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// =====================================================================
describe("buildArticleInputs", () => {
  it("produces an ArticleInput per non-skip candidate, joining session bodies in endedAt ASC order", () => {
    const eOld = ie({
      sessionId: "old", shortId: "old",
      relativePath: "raw_sessions/c/p/2026-04-10/old.md",
      sourceSha256: "shaOld",
      endedAt: "2026-04-10T10:00:00Z",
    });
    const eNew = ie({
      sessionId: "new", shortId: "new",
      relativePath: "raw_sessions/c/p/2026-04-15/new.md",
      sourceSha256: "shaNew",
      endedAt: "2026-04-15T10:00:00Z",
    });
    writeSessionMd(eOld.relativePath, "OLD BODY");
    writeSessionMd(eNew.relativePath, "NEW BODY");
    const idx = makeIndex([eOld, eNew]);
    const cands: ThreadCandidate[] = [
      { threadId: "t1", title: "题", sessionIds: ["new", "old"] }, // intentionally out of order
    ];
    const got = buildArticleInputs(cands, idx, repoRoot);
    expect(got).toHaveLength(1);
    const input = got[0]!;
    expect(input.threadId).toBe("t1");
    expect(input.project).toBe("proj-a");
    expect(input.title).toBe("题");
    // sessionIds reordered to endedAt ASC.
    expect(input.sessionIds).toEqual(["old", "new"]);
    expect(input.sessionShas).toEqual(["shaOld", "shaNew"]);
    // sessionsMd: old comes first, joined with separator referencing the session.
    expect(input.sessionsMd.indexOf("OLD BODY")).toBeLessThan(input.sessionsMd.indexOf("NEW BODY"));
    expect(input.sessionsMd).toMatch(/--- SESSION old/);
    expect(input.sessionsMd).toMatch(/--- SESSION new/);
    // endedAt = max.
    expect(input.endedAt).toBe("2026-04-15T10:00:00Z");
  });

  it("excludes skip candidates", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/x/y.md" });
    writeSessionMd(e.relativePath, "body");
    const idx = makeIndex([e]);
    const cands: ThreadCandidate[] = [
      { threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "x" },
    ];
    expect(buildArticleInputs(cands, idx, repoRoot)).toEqual([]);
  });

  it("throws when a candidate's sessions span multiple projects", () => {
    const eA = ie({ sessionId: "a", project: "proj-a", relativePath: "raw_sessions/c/a/x/a.md" });
    const eB = ie({ sessionId: "b", project: "proj-b", relativePath: "raw_sessions/c/b/x/b.md" });
    writeSessionMd(eA.relativePath, "a");
    writeSessionMd(eB.relativePath, "b");
    const idx = makeIndex([eA, eB]);
    const cands: ThreadCandidate[] = [
      { threadId: "mixed", title: "", sessionIds: ["a", "b"] },
    ];
    expect(() => buildArticleInputs(cands, idx, repoRoot)).toThrow(/multiple projects/);
  });

  it("warns and drops candidates whose sessionIds aren't all in indexFile", () => {
    const e = ie({ sessionId: "real", relativePath: "raw_sessions/c/p/x/r.md" });
    writeSessionMd(e.relativePath, "x");
    const idx = makeIndex([e]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cands: ThreadCandidate[] = [
      { threadId: "ghost", title: "", sessionIds: ["real", "missing-from-index"] },
    ];
    const got = buildArticleInputs(cands, idx, repoRoot);
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost/));
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pipeline`
Expected: FAIL with "Cannot find module '../../src/digest/pipeline.js'".

- [ ] **Step 3: Write `src/digest/pipeline.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexFile, IndexEntry } from "../types.js";
import {
  type BookIndex,
  type BookEntry,
  upsertThread,
} from "./book-index.js";
import type { SessionForBatching, ThreadCandidate } from "./types.js";
import { ARTICLE_VERSION, type ArticleInput } from "./article.js";

/**
 * IndexEntries that the BookIndex hasn't accounted for yet. An entry is
 * "covered" iff its sessionId appears in some BookEntry.sessionIds.
 *
 * Result is sorted by endedAt ASC — the order downstream batching/article
 * generation expects.
 */
export function findNewSessionEntries(
  indexFile: IndexFile,
  bookIndex: BookIndex,
): IndexEntry[] {
  const covered = new Set<string>();
  for (const be of Object.values(bookIndex.threads)) {
    for (const sid of be.sessionIds) covered.add(sid);
  }
  const out: IndexEntry[] = [];
  for (const e of Object.values(indexFile.entries)) {
    if (!covered.has(e.sessionId)) out.push(e);
  }
  out.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  return out;
}

/**
 * Read each entry's session .md from disk and produce SessionForBatching[].
 * Tokens estimated as ceil(chars / 3.5).
 *
 * Throws on a missing/unreadable .md (upstream extract is broken — fail loud)
 * and on .enc paths (encryption + digest pipeline isn't supported in 2.8.x).
 */
export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
): SessionForBatching[] {
  const out: SessionForBatching[] = [];
  for (const e of entries) {
    if (e.relativePath.endsWith(".enc")) {
      throw new Error(
        `pipeline.ts: encrypted sessions not supported in digest pipeline (got ${e.relativePath})`,
      );
    }
    let body: string;
    try {
      body = readFileSync(join(repoRoot, e.relativePath), "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pipeline.ts: cannot read session ${e.relativePath}: ${msg}`);
    }
    out.push({
      sessionId: e.sessionId,
      project: e.project,
      endedAt: e.endedAt,
      tokenEstimate: Math.ceil(body.length / 3.5),
    });
  }
  return out;
}

/**
 * Persist skip:true BookEntries for each skip candidate so future syncs
 * don't reconsider them. Returns the list of skipped threadIds.
 */
export function recordSkippedThreadCandidates(
  bookIndex: BookIndex,
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
): string[] {
  const skipped: string[] = [];
  const nowIso = new Date().toISOString();
  const sessionLookup = sessionLookupBySid(indexFile);
  for (const c of candidates) {
    if (!c.skip) continue;
    const firstSid = c.sessionIds[0];
    const ie = firstSid ? sessionLookup.get(firstSid) : undefined;
    const project = ie?.project ?? "unknown";
    const entry: BookEntry = {
      threadId: c.threadId,
      project,
      title: c.title,
      sessionIds: c.sessionIds,
      articlePath: "",
      articleVersion: ARTICLE_VERSION,
      latestSourceSha: "",
      articleStatus: "ok",
      skip: true,
      skipReason: c.reason ?? "",
      updatedAt: nowIso,
    };
    upsertThread(bookIndex, entry);
    skipped.push(c.threadId);
  }
  return skipped;
}

/**
 * For each non-skip candidate, gather the session bodies and emit an ArticleInput.
 *
 * - Sessions inside one candidate are reordered to endedAt ASC (the article
 *   prompt expects 由旧到新). sessionShas is reordered to match.
 * - Joined sessionsMd uses "--- SESSION <shortId> (<endedAt>) ---" separators.
 * - Asserts all sessions in a candidate share one project; throws otherwise.
 * - Drops candidates whose sessionIds aren't all in indexFile and console.warns.
 */
export function buildArticleInputs(
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
  repoRoot: string,
): ArticleInput[] {
  const sessionLookup = sessionLookupBySid(indexFile);
  const out: ArticleInput[] = [];
  for (const c of candidates) {
    if (c.skip) continue;
    const entries: IndexEntry[] = [];
    let missing = false;
    for (const sid of c.sessionIds) {
      const ie = sessionLookup.get(sid);
      if (!ie) {
        console.warn(
          `pipeline.ts: candidate ${c.threadId} references unknown sessionId ${sid} — dropping candidate`,
        );
        missing = true;
        break;
      }
      entries.push(ie);
    }
    if (missing) continue;

    const projects = new Set(entries.map((e) => e.project));
    if (projects.size > 1) {
      throw new Error(
        `pipeline.ts: candidate ${c.threadId} spans multiple projects (${[...projects].join(", ")})`,
      );
    }
    const project = entries[0]!.project;

    entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

    const bodies: string[] = [];
    for (const e of entries) {
      if (e.relativePath.endsWith(".enc")) {
        throw new Error(
          `pipeline.ts: encrypted sessions not supported in digest pipeline (got ${e.relativePath})`,
        );
      }
      let body: string;
      try {
        body = readFileSync(join(repoRoot, e.relativePath), "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`pipeline.ts: cannot read session ${e.relativePath}: ${msg}`);
      }
      bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
    }

    out.push({
      threadId: c.threadId,
      project,
      title: c.title,
      sessionIds: entries.map((e) => e.sessionId),
      sessionShas: entries.map((e) => e.sourceSha256),
      sessionsMd: bodies.join("\n\n"),
      endedAt: entries[entries.length - 1]!.endedAt,
    });
  }
  return out;
}

/** Build a sessionId → IndexEntry map. We do NOT key by tool because
 *  threading candidates carry only sessionId (no tool). In practice
 *  sessionIds are source-native UUIDs and don't collide. */
function sessionLookupBySid(indexFile: IndexFile): Map<string, IndexEntry> {
  const m = new Map<string, IndexEntry>();
  for (const e of Object.values(indexFile.entries)) m.set(e.sessionId, e);
  return m;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pipeline`
Expected: all pipeline tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by 14 new tests (was 119 → 133).

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/pipeline.ts tests/digest/pipeline.test.ts
git commit -m "feat(digest): add pipeline planning module (findNewSessions, buildBatchingInput, recordSkipped, buildArticleInputs)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "扫 .memvc/index.json 找新 session" → `findNewSessionEntries`.
  - "把 newSessions 分配进相应 thread" → `buildArticleInputs` (sessionIds carried into ArticleInput; article phase upserts the BookEntry).
  - Skip handling at threading layer → `recordSkippedThreadCandidates` persists `skip:true` so the LLM cost isn't paid again.
  - Project locality assumption → enforced by "spans multiple projects" throw.

- **Placeholder scan:** every code step has full code. No TBD / "similar to" / "add validation".

- **Type consistency:**
  - `IndexEntry`, `IndexFile`, `Tool` from `src/types.ts`. Confirmed shape (`sessionId`, `tool`, `project`, `endedAt`, `relativePath`, `sourceSha256`, `shortId`).
  - `BookEntry`, `BookIndex`, `upsertThread` from `src/digest/book-index.ts`. Confirmed `articleStatus: "ok" | "failed"`, `skip?`, `skipReason?`.
  - `SessionForBatching` from `src/digest/types.ts`. Fields: `sessionId`, `project`, `endedAt`, `tokenEstimate`. Match.
  - `ThreadCandidate` from `src/digest/types.ts`. Fields: `threadId`, `sessionIds`, `title`, `skip?`, `reason?`. Match.
  - `ArticleInput` from `src/digest/article.ts`. Fields: `threadId`, `project`, `title`, `sessionIds`, `sessionShas`, `sessionsMd`, `endedAt`. Match.
  - `ARTICLE_VERSION` re-exported from `article.ts` — used to stamp skip BookEntries (consistent with how the article phase stamps them).

- **Out of scope (deferred):**
  - Calling the runner / batcher / threading / article / chapter / toc — that's 2.8.2's `runDigest` orchestrator.
  - `sync.ts` modifications and `--no-digest` flag — that's 2.8.3.
  - Encrypted session support — explicitly thrown; deferred to a future sprint that must rebuild the runner contract.
  - "articleVersion 升级" stale-thread detection (spec line 99) — handled by `runDigest` in 2.8.2 by comparing `BookEntry.articleVersion` to the constant.

---

## Roadmap update (do not perform in this plan; do at end of 2.8.3)

Don't update `docs/superpowers/roadmap.md` until the full 2.8 (2.8.1 + 2.8.2 + 2.8.3) lands. 2.8.1 alone isn't user-visible.
