# Sprint 2.3 + 2.4 — Batcher & Threading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next two foundation modules of the digest pipeline: a deterministic `Batcher` that packs sessions into ~100k-token batches respecting project + time locality, and a `Threading` module that calls `LlmRunner` per batch with a thread-classification prompt and merges the resulting `ThreadCandidate[]` deterministically across batches via slug normalization. No `sync` wiring yet — that lands in Sprint 2.8.

**Architecture:**
- `src/digest/types.ts` (new) holds shared digest types so batcher and threading don't need to import from `runner.ts` or each other's internals. Defines `ThreadCandidate` (the shape the LLM emits) and `SessionForBatching` (the minimal shape the batcher consumes — derived from `NormalizedSession` / `IndexEntry`).
- `src/digest/batcher.ts` is pure synchronous code: greedy bin-packing with project + time locality. Same project, time-adjacent sessions are grouped first, then packed into batches under a token budget. A single oversized session goes into its own batch.
- `src/digest/threading.ts` calls `LlmRunner` once per batch in parallel (via `Promise.all`), parses each batch's JSON `ThreadCandidate[]`, and merges them with the deterministic algorithm from the spec (slug normalize → equal/prefix collapse → re-merge).
- `assets/prompts/thread.md` is the static prompt copied verbatim from the spec; `threading.ts` reads it from disk via `readFileSync` (no embedding the prompt in code).

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. No new dependencies. Uses existing `LlmRunner` (`src/digest/runner.ts`).

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, sections "Pipeline → digest.thread", "代码结构 → threading.merge 算法", "Batcher", and "Prompt 初版 → thread.md".

---

## File Structure

**New files:**
- `src/digest/types.ts` — `ThreadCandidate`, `SessionForBatching` shared types
- `src/digest/batcher.ts` — `makeBatches(sessions, opts)` greedy packer
- `src/digest/threading.ts` — `runThreading(runner, batches)` + `mergeCandidates(perBatch)` + `normalizeSlug(s)`
- `assets/prompts/thread.md` — Chinese thread-classification prompt (verbatim from spec)
- `tests/digest/batcher.test.ts`
- `tests/digest/threading.test.ts`

**Modified files:** none.

**Untouched:** every existing source file. No CLI wiring, no `sync.ts` change, no config change.

---

## Task 1: Shared digest types

**Files:**
- Create: `src/digest/types.ts`

- [ ] **Step 1: Write `src/digest/types.ts`**

```ts
/**
 * Minimal shape the batcher needs from a session. Built from a
 * NormalizedSession or IndexEntry by the caller (Sprint 2.8 pipeline glue).
 *
 * - `tokenEstimate` is char-count / 3.5 rounded up; the batcher trusts this
 *   and does not re-derive it. Caller computes once, batcher reads.
 * - `endedAt` is ISO 8601; sort key for time-locality grouping.
 */
export interface SessionForBatching {
  sessionId: string;
  project: string;
  endedAt: string;
  tokenEstimate: number;
}

/**
 * What the LLM returns per batch (one element per discovered thread).
 *
 * - `threadId` is a slug (lowercase, hyphenated). Identity across batches
 *   is decided by normalizeSlug + prefix-collapse, not raw equality.
 * - `skip: true` means the LLM judged the thread as having no real content
 *   (greetings, trivia). `reason` is human-readable Chinese.
 * - `sessionIds` is the subset of the input batch's sessions that belong
 *   to this thread. Sessions not mentioned by any candidate are dropped
 *   by the merger (warning logged at the call site, not here).
 */
export interface ThreadCandidate {
  threadId: string;
  sessionIds: string[];
  title: string;
  skip?: boolean;
  reason?: string;
}
```

- [ ] **Step 2: Build to confirm typing**

Run: `npm run build`
Expected: clean exit, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/digest/types.ts
git commit -m "feat(digest): add shared types (ThreadCandidate, SessionForBatching)"
```

---

## Task 2: Batcher

**Files:**
- Create: `src/digest/batcher.ts`
- Create: `tests/digest/batcher.test.ts`

The batcher's job: take a flat list of sessions, sort them so same-project sessions are adjacent and ordered by `endedAt`, then greedily pack into batches under `maxTokens`. A session larger than `maxTokens` always becomes its own single-element batch.

**Default `maxTokens`:** `100_000`. Caller can override.

**Token estimation policy:** caller pre-fills `tokenEstimate`. Batcher does NOT recompute. (Reason: `tokenEstimate` may eventually come from a real tokenizer; we don't want the batcher to silently disagree.)

- [ ] **Step 1: Write failing tests**

Create `tests/digest/batcher.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { makeBatches } from "../../src/digest/batcher.js";
import type { SessionForBatching } from "../../src/digest/types.js";

function s(
  sessionId: string,
  project: string,
  endedAt: string,
  tokenEstimate: number,
): SessionForBatching {
  return { sessionId, project, endedAt, tokenEstimate };
}

describe("makeBatches", () => {
  it("returns empty array for empty input", () => {
    expect(makeBatches([], { maxTokens: 100 })).toEqual([]);
  });

  it("packs sessions of the same project into one batch when under budget", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 10),
      s("b", "proj", "2026-04-02T00:00:00Z", 20),
      s("c", "proj", "2026-04-03T00:00:00Z", 30),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(1);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("opens a new batch when adding the next session would exceed maxTokens", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 60),
      s("b", "proj", "2026-04-02T00:00:00Z", 60),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["b"]);
  });

  it("places an oversized session in its own single-element batch", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 10),
      s("big", "proj", "2026-04-02T00:00:00Z", 500),
      s("c", "proj", "2026-04-03T00:00:00Z", 10),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    // a fits with c; big stands alone. Order of batches preserves time order
    // of the FIRST session in each batch.
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a", "c"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["big"]);
  });

  it("groups by project first, then orders within project by endedAt", () => {
    const sessions = [
      s("p2-a", "proj2", "2026-04-01T00:00:00Z", 10),
      s("p1-b", "proj1", "2026-04-02T00:00:00Z", 10),
      s("p1-a", "proj1", "2026-04-01T00:00:00Z", 10),
      s("p2-b", "proj2", "2026-04-02T00:00:00Z", 10),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    // All four fit in one batch but ordering must be: proj1 sessions first
    // (by endedAt), then proj2 sessions (by endedAt). Project order is the
    // order of first appearance in the input.
    expect(batches.length).toBe(1);
    expect(batches[0].map((x) => x.sessionId)).toEqual([
      "p1-a", "p1-b", "p2-a", "p2-b",
    ]);
  });

  it("does not mix two projects in a batch when project boundary is crossed mid-pack", () => {
    // Two projects, each fits on its own; budget allows mixing but we should
    // prefer same-project locality over packing density.
    const sessions = [
      s("p1-a", "proj1", "2026-04-01T00:00:00Z", 40),
      s("p1-b", "proj1", "2026-04-02T00:00:00Z", 40),
      s("p2-a", "proj2", "2026-04-03T00:00:00Z", 40),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["p1-a", "p1-b"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["p2-a"]);
  });

  it("uses a default maxTokens of 100_000 when opts.maxTokens omitted", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 50_000),
      s("b", "proj", "2026-04-02T00:00:00Z", 50_000),
    ];
    const batches = makeBatches(sessions);
    // 50_000 + 50_000 = 100_000, fits exactly under the default.
    expect(batches.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- batcher`
Expected: FAIL with "Cannot find module '../../src/digest/batcher.js'".

- [ ] **Step 3: Write `src/digest/batcher.ts`**

```ts
import type { SessionForBatching } from "./types.js";

export interface BatcherOptions {
  /** Soft cap per batch. A single session larger than this still becomes its own batch. Default 100_000. */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 100_000;

/**
 * Pack sessions into batches respecting two locality rules and one budget rule:
 *
 * 1. Group sessions by project (project order = first-appearance order in input).
 * 2. Within a project, order by endedAt ascending.
 * 3. Within a project, greedily pack into batches whose total tokenEstimate
 *    does not exceed maxTokens. A new batch is started when adding the next
 *    session would overflow OR when the project changes.
 *
 * Rationale (spec §Batcher): same-project + time-adjacent sessions must see
 * each other so the threading LLM can spot cross-session continuity. Crossing
 * the project boundary inside a batch defeats this, so we never do it even
 * when there's spare budget.
 */
export function makeBatches(
  sessions: SessionForBatching[],
  opts: BatcherOptions = {},
): SessionForBatching[][] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (sessions.length === 0) return [];

  // Group by project preserving first-appearance order.
  const projectOrder: string[] = [];
  const byProject = new Map<string, SessionForBatching[]>();
  for (const s of sessions) {
    if (!byProject.has(s.project)) {
      projectOrder.push(s.project);
      byProject.set(s.project, []);
    }
    byProject.get(s.project)!.push(s);
  }

  const batches: SessionForBatching[][] = [];
  for (const project of projectOrder) {
    const list = byProject.get(project)!.slice().sort((a, b) =>
      a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0,
    );

    let current: SessionForBatching[] = [];
    let currentTokens = 0;
    for (const s of list) {
      // Oversized session: flush current, then add as its own batch.
      if (s.tokenEstimate > maxTokens) {
        if (current.length > 0) {
          batches.push(current);
          current = [];
          currentTokens = 0;
        }
        batches.push([s]);
        continue;
      }
      // Would adding overflow? Flush and start a new batch.
      if (currentTokens + s.tokenEstimate > maxTokens) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(s);
      currentTokens += s.tokenEstimate;
    }
    if (current.length > 0) batches.push(current);
  }

  return batches;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- batcher`
Expected: all 7 tests in `batcher.test.ts` pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/digest/batcher.ts tests/digest/batcher.test.ts
git commit -m "feat(digest): add Batcher (greedy pack by project + endedAt under token budget)"
```

---

## Task 3: Thread prompt asset

**Files:**
- Create: `assets/prompts/thread.md`

The prompt is copied verbatim from the spec. `threading.ts` will read this file at runtime so users (or the CI) can override it without recompiling.

- [ ] **Step 1: Write `assets/prompts/thread.md`**

```markdown
你是一个代码工程师的助手。要把一批零散的编码 session 分组成"一件事"（thread）。

规则：
1. 同一个项目 + 话题相关 + 时间相邻（一般 < 7 天）的 session 合并成一个 thread
2. 无意义 session（纯 say-hi、没实质内容、几轮简短问答）标 skip: true
3. threadId 是 slug：小写字母数字短横线；描述"这件事"，如 "fix-copilot-scan"
4. title 是中文短标题，≤ 20 字

输入：SESSION_LIST (JSON)
输出：纯 JSON，不要 markdown 代码块

SCHEMA: [{ "sessionIds": ["..."], "threadId": "...", "title": "...", "skip": false, "reason"?: "..." }]

SESSION_LIST:
{{sessionList}}
```

- [ ] **Step 2: Commit**

```bash
git add assets/prompts/thread.md
git commit -m "feat(digest): add thread-classification prompt asset"
```

---

## Task 4: Threading (runner call + cross-batch merge)

**Files:**
- Create: `src/digest/threading.ts`
- Create: `tests/digest/threading.test.ts`

This module does three things:

1. **Render the prompt:** read `assets/prompts/thread.md`, substitute `{{sessionList}}` with a JSON serialization of one batch.
2. **Parallel runner calls:** `Promise.all` over batches; each batch gets its own `runner.run(...)` call with `outputFormat: "json"`.
3. **Deterministic cross-batch merge:** group `ThreadCandidate[]` from all batches by `threadId`, then collapse near-equivalent slugs (normalize → equal-or-prefix → pick canonical), then merge `sessionIds` (union, preserving input order of first appearance), preserve `skip` if any candidate said skip.

**Failure semantics:**
- If ANY batch's runner call returns `ok:false`, `runThreading` throws an `Error` with the per-batch errors collected. (Spec §"失败处理": "阶段 4（thread）任意 batch 失败 → 中止阶段 4-7". The pipeline glue in Sprint 2.8 catches this and aborts the digest stage gracefully — but at the threading-module boundary, throwing is the right signal.)
- If a batch's `text` is not parseable JSON or is not a `ThreadCandidate[]`, throw with which batch failed.

**`normalizeSlug` rules (from spec):**
- lowercase
- collapse runs of `-` to a single `-`
- strip trailing `-NNN` numeric suffix (e.g. `fix-bug-12` → `fix-bug`)
- trim leading/trailing `-`

**Canonical-slug pick rule:** when two candidates' normalized slugs are equal OR one is a prefix of the other, pick the **longer raw slug** as canonical; tie-broken by **earliest first-appearance index**.

- [ ] **Step 1: Write failing tests**

Create `tests/digest/threading.test.ts` with:

```ts
import { describe, it, expect, vi } from "vitest";
import { runThreading, mergeCandidates, normalizeSlug } from "../../src/digest/threading.js";
import type { ThreadCandidate, SessionForBatching } from "../../src/digest/types.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";

function fakeRunner(replies: RunResult[]): LlmRunner {
  let i = 0;
  return {
    run: async () => {
      const r = replies[i++];
      if (!r) throw new Error("fakeRunner ran out of replies");
      return r;
    },
  };
}

function s(sessionId: string, project = "p", endedAt = "2026-04-01T00:00:00Z"): SessionForBatching {
  return { sessionId, project, endedAt, tokenEstimate: 10 };
}

describe("normalizeSlug", () => {
  it("lowercases", () => {
    expect(normalizeSlug("Fix-Bug")).toBe("fix-bug");
  });
  it("collapses double hyphens", () => {
    expect(normalizeSlug("fix--bug---now")).toBe("fix-bug-now");
  });
  it("strips trailing -NNN numeric suffix", () => {
    expect(normalizeSlug("fix-bug-12")).toBe("fix-bug");
  });
  it("trims leading and trailing hyphens", () => {
    expect(normalizeSlug("-fix-bug-")).toBe("fix-bug");
  });
  it("leaves a slug without trailing digits alone", () => {
    expect(normalizeSlug("fix-bug")).toBe("fix-bug");
  });
});

describe("mergeCandidates", () => {
  it("returns empty array for empty input", () => {
    expect(mergeCandidates([])).toEqual([]);
  });

  it("merges identical threadIds across batches, unioning sessionIds in first-appearance order", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s1", "s2"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s2", "s3"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].threadId).toBe("fix-bug");
    expect(merged[0].sessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("collapses prefix-equivalent slugs onto the longer one", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s1"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug-in-parser", title: "修 parser", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].threadId).toBe("fix-bug-in-parser");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("collapses normalize-equivalent slugs (trailing numbers, double hyphens)", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug-1", title: "a", sessionIds: ["s1"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug-2", title: "b", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    // Both normalize to "fix-bug"; same length → earliest first-appearance wins.
    expect(merged[0].threadId).toBe("fix-bug-1");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("passes skip through when any candidate of a merged group is skip", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "say-hi", title: "打招呼", sessionIds: ["s1"], skip: true, reason: "no content" },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "say-hi", title: "打招呼", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].skip).toBe(true);
    expect(merged[0].reason).toBe("no content");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("keeps unrelated threads as separate entries", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "a", sessionIds: ["s1"] },
      { threadId: "add-feature", title: "b", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA]);
    expect(merged.length).toBe(2);
    expect(merged.map((c) => c.threadId).sort()).toEqual(["add-feature", "fix-bug"]);
  });
});

describe("runThreading", () => {
  it("calls the runner once per batch and returns the merged ThreadCandidate[]", async () => {
    const runner = fakeRunner([
      {
        ok: true,
        text: JSON.stringify([
          { threadId: "t1", title: "T1", sessionIds: ["s1", "s2"] },
        ]),
        durationMs: 1,
      },
      {
        ok: true,
        text: JSON.stringify([
          { threadId: "t1", title: "T1", sessionIds: ["s3"] },
          { threadId: "t2", title: "T2", sessionIds: ["s4"] },
        ]),
        durationMs: 1,
      },
    ]);
    const runSpy = vi.spyOn(runner, "run");

    const batches = [
      [s("s1"), s("s2")],
      [s("s3"), s("s4")],
    ];
    const merged = await runThreading(runner, batches);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(merged.length).toBe(2);
    const t1 = merged.find((c) => c.threadId === "t1")!;
    expect(t1.sessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("throws when any batch's runner call returns ok:false, with all errors", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
      { ok: false, error: "timeout", durationMs: 1 },
    ]);
    const batches = [[s("s1")], [s("s2")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 1.*timeout/i);
  });

  it("throws when a batch returns malformed JSON", async () => {
    const runner = fakeRunner([
      { ok: true, text: "not json at all", durationMs: 1 },
    ]);
    const batches = [[s("s1")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 0.*parse/i);
  });

  it("throws when a batch returns valid JSON but not a ThreadCandidate[] shape", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify({ not: "an array" }), durationMs: 1 },
    ]);
    const batches = [[s("s1")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 0.*shape/i);
  });

  it("calls runner with outputFormat:'json'", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1")]]);
    const opts = runSpy.mock.calls[0][2];
    expect(opts?.outputFormat).toBe("json");
  });

  it("substitutes {{sessionList}} with a JSON array of session metadata", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1", "p", "2026-04-01T00:00:00Z")]]);
    const vars = runSpy.mock.calls[0][1];
    expect(vars.sessionList).toBeDefined();
    const parsed = JSON.parse(vars.sessionList);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      sessionId: "s1",
      project: "p",
      endedAt: "2026-04-01T00:00:00Z",
    });
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- threading`
Expected: FAIL with "Cannot find module '../../src/digest/threading.js'".

- [ ] **Step 3: Write `src/digest/threading.ts`**

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRunner } from "./runner.js";
import type { ThreadCandidate, SessionForBatching } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve repo-rooted assets/prompts/thread.md from this module's compiled location. */
function loadThreadPrompt(): string {
  // src/digest/threading.ts → ../../assets/prompts/thread.md when running ts-node;
  // dist/digest/threading.js → ../../assets/prompts/thread.md when built.
  // Both layouts produce the same relative path.
  const p = join(__dirname, "..", "..", "assets", "prompts", "thread.md");
  return readFileSync(p, "utf8");
}

/**
 * Normalize a thread slug for cross-batch identity comparison.
 * Rules (spec §threading.merge):
 *   - lowercase
 *   - collapse runs of '-' into a single '-'
 *   - strip trailing '-NNN' numeric suffix
 *   - trim leading/trailing '-'
 */
export function normalizeSlug(slug: string): string {
  let s = slug.toLowerCase();
  s = s.replace(/-+/g, "-");
  s = s.replace(/-\d+$/, "");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

/**
 * Merge ThreadCandidate[][] (one per batch) into a single ThreadCandidate[]
 * via the deterministic algorithm in the spec:
 *
 *   1. Flatten all candidates, recording first-appearance index.
 *   2. Group by exact threadId; union sessionIds (preserving first-appearance order),
 *      `skip` is sticky (true if any candidate is skip).
 *   3. Collapse normalize-equivalent or prefix-equivalent groups onto a canonical
 *      group: pick the LONGEST raw threadId; tie-break by earliest first-appearance.
 *   4. Re-merge sessionIds + skip on the canonical group.
 */
export function mergeCandidates(perBatch: ThreadCandidate[][]): ThreadCandidate[] {
  // Step 1+2: group by exact threadId.
  interface Group {
    threadId: string;
    title: string;
    sessionIds: string[];   // ordered, deduped
    skip: boolean;
    reason?: string;
    firstSeen: number;      // index across the flattened stream
  }
  const groups = new Map<string, Group>();
  let idx = 0;
  for (const batch of perBatch) {
    for (const c of batch) {
      let g = groups.get(c.threadId);
      if (!g) {
        g = {
          threadId: c.threadId,
          title: c.title,
          sessionIds: [],
          skip: false,
          firstSeen: idx,
        };
        groups.set(c.threadId, g);
      }
      for (const sid of c.sessionIds) {
        if (!g.sessionIds.includes(sid)) g.sessionIds.push(sid);
      }
      if (c.skip) {
        g.skip = true;
        if (c.reason && !g.reason) g.reason = c.reason;
      }
      idx++;
    }
  }

  // Step 3: build collapse map. For each group, decide its canonical threadId.
  const groupList = Array.from(groups.values());
  const canonicalOf = new Map<string, string>(); // threadId → canonical threadId

  for (const g of groupList) {
    let canonical = g;
    for (const other of groupList) {
      if (other === g) continue;
      if (areEquivalent(g.threadId, other.threadId)) {
        // Pick longer raw; tie-break by earlier firstSeen.
        if (
          other.threadId.length > canonical.threadId.length ||
          (other.threadId.length === canonical.threadId.length &&
            other.firstSeen < canonical.firstSeen)
        ) {
          canonical = other;
        }
      }
    }
    canonicalOf.set(g.threadId, canonical.threadId);
  }

  // Step 4: re-merge into canonical groups.
  const finalGroups = new Map<string, Group>();
  for (const g of groupList) {
    const canonId = canonicalOf.get(g.threadId)!;
    let cg = finalGroups.get(canonId);
    if (!cg) {
      // Seed from the canonical group itself (so title comes from canonical).
      const seed = groups.get(canonId)!;
      cg = {
        threadId: seed.threadId,
        title: seed.title,
        sessionIds: [],
        skip: false,
        firstSeen: seed.firstSeen,
      };
      finalGroups.set(canonId, cg);
    }
    for (const sid of g.sessionIds) {
      if (!cg.sessionIds.includes(sid)) cg.sessionIds.push(sid);
    }
    if (g.skip) {
      cg.skip = true;
      if (g.reason && !cg.reason) cg.reason = g.reason;
    }
  }

  // Emit in firstSeen order for deterministic output.
  const out: ThreadCandidate[] = Array.from(finalGroups.values())
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((g) => {
      const tc: ThreadCandidate = {
        threadId: g.threadId,
        title: g.title,
        sessionIds: g.sessionIds,
      };
      if (g.skip) tc.skip = true;
      if (g.reason) tc.reason = g.reason;
      return tc;
    });
  return out;
}

/** Two raw slugs are equivalent if their normalized forms are equal OR one is a prefix of the other. */
function areEquivalent(a: string, b: string): boolean {
  const na = normalizeSlug(a);
  const nb = normalizeSlug(b);
  if (na === nb) return true;
  if (na.length > 0 && nb.length > 0 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  return false;
}

/**
 * Validate that `data` is a ThreadCandidate[]. Throws otherwise.
 * Permissive: only checks shape of fields we rely on.
 */
function asThreadCandidates(data: unknown, batchIndex: number): ThreadCandidate[] {
  if (!Array.isArray(data)) {
    throw new Error(`threading batch ${batchIndex}: bad shape — expected JSON array`);
  }
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as Record<string, unknown>;
    if (typeof c?.threadId !== "string" || typeof c?.title !== "string" || !Array.isArray(c?.sessionIds)) {
      throw new Error(
        `threading batch ${batchIndex}: bad shape — element ${i} missing threadId/title/sessionIds`,
      );
    }
    for (const sid of c.sessionIds) {
      if (typeof sid !== "string") {
        throw new Error(`threading batch ${batchIndex}: bad shape — sessionIds must be string[]`);
      }
    }
  }
  return data as ThreadCandidate[];
}

/**
 * Drive threading end-to-end:
 *   - render thread prompt with sessionList = JSON of batch's sessions
 *   - call runner per batch in parallel (outputFormat: json)
 *   - parse + validate each batch's result
 *   - cross-batch merge via mergeCandidates
 *
 * Throws on the first sign of trouble (any batch ok:false, parse error, or
 * shape error). Errors include the batch index for diagnosis.
 */
export async function runThreading(
  runner: LlmRunner,
  batches: SessionForBatching[][],
): Promise<ThreadCandidate[]> {
  const prompt = loadThreadPrompt();

  const results = await Promise.all(
    batches.map((batch) =>
      runner.run(
        prompt,
        { sessionList: JSON.stringify(batch.map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          endedAt: s.endedAt,
        }))) },
        { outputFormat: "json" },
      ),
    ),
  );

  const perBatchCandidates: ThreadCandidate[][] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      errors.push(`batch ${i}: ${r.error}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.text);
    } catch (e) {
      throw new Error(`threading batch ${i}: parse error — ${(e as Error).message}`);
    }
    perBatchCandidates.push(asThreadCandidates(parsed, i));
  }
  if (errors.length > 0) {
    throw new Error(`threading runner failed: ${errors.join("; ")}`);
  }

  return mergeCandidates(perBatchCandidates);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- threading`
Expected: all tests in `threading.test.ts` pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: no regressions; suite total grows by the new tests.

- [ ] **Step 6: Build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/digest/threading.ts tests/digest/threading.test.ts
git commit -m "feat(digest): add Threading (per-batch runner call + deterministic cross-batch merge)"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:** Batcher rules (§Batcher) → Task 2. Threading.merge algorithm (§threading.merge) → Task 4 `mergeCandidates`. Prompt asset (§Prompt 初版 → thread.md) → Task 3. Runner call shape (§digest.thread "Promise.all 并发所有 batch") → Task 4 `runThreading`.
- **Placeholder scan:** every code step has full code; no "TBD"; no "similar to above"; no "add validation as needed".
- **Type consistency:** `ThreadCandidate` fields used in tests (`threadId`, `title`, `sessionIds`, `skip`, `reason`) match the `ThreadCandidate` interface defined in Task 1. `SessionForBatching` shape used in batcher tests matches the type defined in Task 1. `LlmRunner` / `RunResult` reused unchanged from Sprint 2.1.
- **Defaults match spec:** `maxTokens` default `100_000` (§Batcher: "约 100k tokens/batch").
