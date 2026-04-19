# Threading Per-Batch Retry + Soft-Fail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a single batch's runner reply is malformed (JSON parse error, shape error, or `ok:false`), retry that batch up to N times; if it still fails, drop only that batch (the sessions inside it become "unaccounted-for" and re-surface as `newSessions` next sync), instead of aborting the entire `runThreading` call and wasting all sibling batches' work.

**Architecture:**
- A single per-batch worker function `processBatch(runner, batch, batchIndex, maxAttempts)` does: run → parse → validate → return `ThreadCandidate[]`. On any failure, retry. After `maxAttempts`, return a sentinel `{ failed: true, error: string }` instead of throwing.
- `runThreading` invokes it via the existing `mapWithConcurrency` helper (concurrency cap unchanged), then partitions results into `succeeded: ThreadCandidate[][]` and `failed: { batchIndex, error }[]`. Failed batches are logged via `console.warn`. Only `succeeded` are merged.
- Currently `runThreading` returns `ThreadCandidate[]`. Change return type to `{ candidates: ThreadCandidate[]; failedBatches: { batchIndex: number; error: string }[] }` so the caller (orchestrator) can surface failures in `DigestReport`.
- `DigestReport` gains `threadingBatchesFailed: number` and the orchestrator logs a warning. Sessions in failed batches are simply not in any candidate, so `findNewSessionEntries` will still see them as new on the next sync — automatic retry, no extra bookkeeping.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest.

**Spec reference:** Spec §"失败处理 阶段 4" was originally interpreted as "any batch failure → abort phases 4-7". Re-reading the spec, the actual wording is "任意 batch 失败 → 中止阶段 4-7, 保留阶段 1-2 的 push, 下次 sync 重试". This was a too-strict interpretation: a *parse* error from a single LLM call shouldn't waste 56 successful batches. The retry+drop policy preserves the spirit ("失败可下次 sync 重试") while keeping the rest of the work.

---

## Scope

One bug fix in two tasks:

- **Task 1**: Add per-batch retry helper + change `runThreading` to return both succeeded and failed batches; update existing `runThreading` tests for the new shape.
- **Task 2**: Wire `failedBatches.length` into `DigestReport` and the sync.ts summary log so users can see "N batches failed, will retry next sync".

---

## File Structure

**Modified files:**
- `src/digest/threading.ts` — add retry loop + change `runThreading` return shape
- `src/digest/orchestrator.ts` — update `DigestReport` + handle new return shape
- `src/commands/sync.ts` — surface `threadingBatchesFailed` in the summary log line
- `src/config.ts` — add `threadingMaxAttempts: z.number().int().positive().default(3)` (so users can tune retry count)
- `src/commands/init.ts` — leave as-is; Zod default fills in
- `tests/digest/threading.test.ts` — adjust existing "throws on parse/shape/ok:false" tests to assert new behavior (logs warning, returns `failedBatches`); add new tests for retry-then-succeed and retry-exhaust paths
- `tests/digest/orchestrator.test.ts` — adjust the existing "threading failure aborts phases 4-7" test (this test's premise changes — threading no longer aborts; we replace it with a "threading partial failure: succeeded batches still produce articles" test)

**New files:** none.

**Untouched:** `src/digest/concurrency.ts`, `src/digest/article.ts`, `src/digest/chapter.ts`, `src/digest/pipeline.ts`, `src/digest/redo.ts`, `src/commands/digest.ts`.

---

## Task 1: Per-batch retry + soft-fail in `runThreading`

**Files:**
- Modify: `src/digest/threading.ts`
- Modify: `src/config.ts`
- Modify: `tests/digest/threading.test.ts`

### Step 1.1 — Add `threadingMaxAttempts` to config schema

- [ ] **Edit `src/config.ts`**

Add a sibling export and schema field next to `DEFAULT_THREADING_CONCURRENCY`:

```ts
/** Default attempts per threading batch before soft-failing it. */
export const DEFAULT_THREADING_MAX_ATTEMPTS = 3;
```

Add to the schema:

```ts
threadingMaxAttempts: z.number().int().positive().default(DEFAULT_THREADING_MAX_ATTEMPTS),
```

The full schema after the change:

```ts
const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api", "github-models"]).default("claude-cli"),
  runnerModel: z.string().default(""),
  threadingConcurrency: z.number().int().positive().default(DEFAULT_THREADING_CONCURRENCY),
  threadingMaxAttempts: z.number().int().positive().default(DEFAULT_THREADING_MAX_ATTEMPTS),
});
```

### Step 1.2 — Rewrite `runThreading` with retry + soft-fail

- [ ] **Replace the bottom half of `src/digest/threading.ts` (everything from `export async function runThreading` to end of file)**

```ts
export interface ThreadingResult {
  /** Merged ThreadCandidate[] from all batches that succeeded. */
  candidates: ThreadCandidate[];
  /** Per-batch failures after all retry attempts. Their sessions remain
   *  unaccounted-for in BookIndex and will be re-batched on the next sync. */
  failedBatches: { batchIndex: number; error: string }[];
}

/**
 * Drive threading end-to-end with per-batch retry + soft-fail:
 *   - render thread prompt with sessionList = JSON of batch's sessions
 *   - run via mapWithConcurrency with the cap
 *   - per batch: try up to `maxAttempts` times; on each attempt, call runner →
 *     parse → validate. If any of these fail, retry. If all attempts fail,
 *     soft-fail (record + warn + skip).
 *   - cross-batch merge via mergeCandidates over the succeeded subset
 *
 * Returns BOTH the merged candidates AND the per-batch failures so the caller
 * can surface them in its report. Sessions in failed batches will reappear in
 * findNewSessionEntries on the next sync (they were never written to BookIndex).
 */
export async function runThreading(
  runner: LlmRunner,
  batches: SessionForBatching[][],
  concurrency = DEFAULT_THREADING_CONCURRENCY,
  maxAttempts = DEFAULT_THREADING_MAX_ATTEMPTS,
): Promise<ThreadingResult> {
  type BatchOutcome =
    | { ok: true; candidates: ThreadCandidate[] }
    | { ok: false; error: string };

  const outcomes = await mapWithConcurrency(batches, concurrency, (batch, i) =>
    processBatch(runner, batch, i, maxAttempts),
  );

  const perBatchCandidates: ThreadCandidate[][] = [];
  const failedBatches: { batchIndex: number; error: string }[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]!;
    if (o.ok) {
      perBatchCandidates.push(o.candidates);
    } else {
      failedBatches.push({ batchIndex: i, error: o.error });
      console.warn(`threading batch ${i} failed after ${maxAttempts} attempts: ${o.error}`);
    }
  }

  return {
    candidates: mergeCandidates(perBatchCandidates),
    failedBatches,
  };

  /** Per-batch helper: run + parse + validate, with retry. Returns an outcome
   *  discriminated union; never throws. */
  async function processBatch(
    runner: LlmRunner,
    batch: SessionForBatching[],
    batchIndex: number,
    maxAttempts: number,
  ): Promise<BatchOutcome> {
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = await runner.run(
        THREAD_PROMPT,
        { sessionList: JSON.stringify(batch.map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          endedAt: s.endedAt,
        }))) },
        { outputFormat: "json" },
      );
      if (!r.ok) {
        lastError = r.error;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.text);
      } catch (e) {
        lastError = `parse error — ${(e as Error).message}`;
        continue;
      }
      try {
        const candidates = asThreadCandidates(parsed, batchIndex);
        return { ok: true, candidates };
      } catch (e) {
        lastError = (e as Error).message;
        continue;
      }
    }
    return { ok: false, error: lastError };
  }
}
```

(Note: this reuses the existing `asThreadCandidates` validator; remove its `throw new Error` style — it already throws, and we catch it inside `processBatch`. No change needed to `asThreadCandidates` itself.)

### Step 1.3 — Update `runThreading` tests for the new return shape

- [ ] **Edit `tests/digest/threading.test.ts`**

(a) The existing tests `"throws when any batch's runner call returns ok:false, with all errors"`, `"throws on JSON parse error, with batch index"`, `"throws on shape error, with batch index"` must be updated. Each now asserts: with `maxAttempts: 1` (so no retry), the batch soft-fails — `runThreading` resolves, `result.candidates` is `[]` for those failures, `result.failedBatches` contains one entry with the right error fragment, and `console.warn` was called.

Replace those three tests with:

```ts
  it("with maxAttempts=1: ok:false batch soft-fails (recorded in failedBatches, warns, no throw)", async () => {
    const runner = fakeRunner([
      { ok: true, text: "[]", durationMs: 1 },
      { ok: false, error: "timeout", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s1")], [s("s2")]], 4, 1);
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toEqual([{ batchIndex: 1, error: "timeout" }]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/batch 1.*timeout/));
    } finally {
      warn.mockRestore();
    }
  });

  it("with maxAttempts=1: parse error soft-fails", async () => {
    const runner = fakeRunner([
      { ok: true, text: "not-json{", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")]], 4, 1);
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/parse error/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("with maxAttempts=1: shape error soft-fails", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([{ wrong: "shape" }]), durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")]], 4, 1);
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/missing threadId/);
    } finally {
      warn.mockRestore();
    }
  });
```

(b) The existing test `"calls the runner once per batch and returns the merged ThreadCandidate[]"` must be updated to expect the new return shape. Find the assertion `expect(merged).toEqual(...)` and change `merged` to `result.candidates`. The full updated test:

```ts
  it("calls the runner once per batch and returns the merged result", async () => {
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
    const result = await runThreading(runner, batches);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(result.failedBatches).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.threadId).sort()).toEqual(["t1", "t2"]);
    expect(result.candidates.find((c) => c.threadId === "t1")!.sessionIds.sort()).toEqual(["s1", "s2", "s3"]);
  });
```

(c) The existing `"calls runner with outputFormat:'json'"` test stays unchanged but its return-value assertion (if any) needs `.candidates` access. Look for it and adjust if needed.

(d) Add new tests for retry behavior. Append inside the `describe("runThreading", ...)` block:

```ts
  it("retries a batch that fails first then succeeds, returning candidates from the successful attempt", async () => {
    const runner = fakeRunner([
      { ok: false, error: "transient", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-ok", title: "ok", sessionIds: ["s1"] },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(runner, [[s("s1")]], 4, 3);
    expect(r.failedBatches).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.threadId).toBe("t-ok");
  });

  it("with maxAttempts=3: retries on parse error, succeeds on third attempt", async () => {
    const runner = fakeRunner([
      { ok: true, text: "garbage{", durationMs: 1 },
      { ok: true, text: "still-bad", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-late", title: "late", sessionIds: ["s1"] },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(runner, [[s("s1")]], 4, 3);
    expect(r.failedBatches).toEqual([]);
    expect(r.candidates[0]!.threadId).toBe("t-late");
  });

  it("with maxAttempts=2: gives up after 2 failed attempts and records last error", async () => {
    const runner = fakeRunner([
      { ok: true, text: "garbage1", durationMs: 1 },
      { ok: true, text: "garbage2", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s1")]], 4, 2);
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/parse error/);
    } finally {
      warn.mockRestore();
    }
  });

  it("partial failure: one batch fails, others succeed; merged candidates come only from successful batches", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([
        { threadId: "t-good", title: "G", sessionIds: ["s0"] },
      ]), durationMs: 1 },
      { ok: true, text: "garbage", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-also-good", title: "A", sessionIds: ["s2"] },
      ]), durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")], [s("s1")], [s("s2")]], 4, 1);
      expect(r.failedBatches).toEqual([{ batchIndex: 1, error: expect.stringMatching(/parse error/) }]);
      expect(r.candidates.map((c) => c.threadId).sort()).toEqual(["t-also-good", "t-good"]);
    } finally {
      warn.mockRestore();
    }
  });
```

### Step 1.4 — Run + commit

- [ ] **Run `npm test -- threading`** — all green; expect 4 new tests added + 4 existing tests updated/replaced.
- [ ] **Run `npm test`** — full suite green. Was 170; net +4 from this task → 174 (some tests were *replaced* not added, so net is just the 4 retry tests — adjust expectation if your count differs).
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/threading.ts src/config.ts tests/digest/threading.test.ts
git commit -m "feat(digest): per-batch retry + soft-fail in runThreading (don't waste sibling batches on one parse error)"
```

---

## Task 2: Surface failed batches in DigestReport + sync log

**Files:**
- Modify: `src/digest/orchestrator.ts`
- Modify: `src/commands/sync.ts`
- Modify: `tests/digest/orchestrator.test.ts`

### Step 2.1 — `src/digest/orchestrator.ts`

- [ ] **Update `DigestReport` and `runDigest` to handle the new return shape**

(a) Add to `DigestReport`:

```ts
/** Number of threading batches that soft-failed after all retries. Their
 *  sessions are NOT in BookIndex yet and will be re-batched next sync. */
threadingBatchesFailed: number;
```

Place it right after `threadCandidates`. Initialize to 0 in the report constructor.

(b) Find `const candidates = await runThreading(runner, batches, concurrency);` and change to:

```ts
const threadingResult = await runThreading(runner, batches, concurrency);
const candidates = threadingResult.candidates;
report.threadingBatchesFailed = threadingResult.failedBatches.length;
```

(c) Add `maxAttempts` as a 7th param to `runDigest`. The full new signature:

```ts
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null,
  concurrency = DEFAULT_THREADING_CONCURRENCY,
  maxAttempts = DEFAULT_THREADING_MAX_ATTEMPTS,
): Promise<DigestReport> {
```

Add `DEFAULT_THREADING_MAX_ATTEMPTS` to the existing `from "../config.js"` import.

Pass it through:

```ts
const threadingResult = await runThreading(runner, batches, concurrency, maxAttempts);
```

### Step 2.2 — `src/commands/sync.ts`

- [ ] **Plumb maxAttempts + surface failed-batch count in summary log**

(a) `SyncOptions` gains `threadingMaxAttempts?: number`.

(b) The `runDigest(...)` call passes `opts.threadingMaxAttempts ?? DEFAULT_THREADING_MAX_ATTEMPTS` as the 7th arg. Add `DEFAULT_THREADING_MAX_ATTEMPTS` to the existing config import.

(c) `syncCmd`'s `runSync({...})` passes `threadingMaxAttempts: cfg.threadingMaxAttempts`.

(d) Update the in-line digest summary log. Currently:

```ts
console.log(chalk.gray(
  `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]`,
));
```

Change to (append failed-batch count when > 0):

```ts
const failedBatchSuffix = digestReport.threadingBatchesFailed > 0
  ? `; ${digestReport.threadingBatchesFailed} threading batch${digestReport.threadingBatchesFailed === 1 ? "" : "es"} failed (will retry next sync)`
  : "";
console.log(chalk.gray(
  `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]${failedBatchSuffix}`,
));
```

### Step 2.3 — `tests/digest/orchestrator.test.ts`

- [ ] **Replace the "threading failure aborts phases 4-7" test**

Find the existing test `"when threading runner returns ok:false, runDigest throws and toc is NOT run"` (it's inside the `describe("runDigest — threading failure aborts phases 4-7")` block). The premise has changed: threading no longer aborts — it soft-fails. **Replace the entire describe block** with:

```ts
describe("runDigest — threading partial failure", () => {
  it("when threading runner returns ok:false, the batch soft-fails; toc still runs; report flags failed batches", async () => {
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "x");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const { runner } = makeRunner([
      // Threading: return ok:false 3 times (default maxAttempts=3 will exhaust).
      { ok: false, durationMs: 1, error: "thread runner exploded" },
      { ok: false, durationMs: 1, error: "thread runner exploded" },
      { ok: false, durationMs: 1, error: "thread runner exploded" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runDigest(runner, repoRoot, idx, book, null);
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
```

Note: this test relies on the default `maxAttempts = 3`. The runner needs 3 canned ok:false replies. If the test framework prints those 3 warns, that's fine — they're spied/silenced.

### Step 2.4 — Run + commit

- [ ] **Run `npm test`** — full suite green. Net change vs Task 1: existing test replaced (no count change) → still 174.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/orchestrator.ts src/commands/sync.ts tests/digest/orchestrator.test.ts
git commit -m "feat(digest): surface threading batch failures in DigestReport + sync summary log"
```

---

## Task 3: Smoke test (no commit)

- [ ] **Step 3.1: Manual smoke**

```bash
cd /Users/yueliu/edge/memvc
npm run build
export MEMVC_PASSPHRASE='your-passphrase'
memvc sync
```

Expected: even if a batch hits a JSON parse error, sync now finishes. The summary line shows e.g. `digest: +43 articles, 2 skip, 0 fail; chapters [proj-a, proj-b]; 1 threading batch failed (will retry next sync)`. The 1 failed batch's sessions stay in `index.json` but are absent from `BookIndex.threads`, so the next `memvc sync` retries them.

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - Spec line "失败处理 阶段 4 任意 batch 失败 → 中止 4-7" — re-interpreted: a runner-level failure (rate limit, network) was the original concern; a parse error from a single LLM hallucination is treated more leniently. The "下次 sync 重试" guarantee is preserved because failed-batch sessions remain unaccounted in BookIndex.
  - DigestReport gains a clear surface for the partial-failure mode so users aren't surprised.

- **Placeholder scan:** every code step has full code; no TBD; no "similar to"; no "add validation".

- **Type consistency:**
  - New `ThreadingResult` interface returned from `runThreading` (was `ThreadCandidate[]`).
  - `runDigest` now has 7 params: `runner, repoRoot, indexFile, bookIndex, key, concurrency, maxAttempts`. Both new ones default via `DEFAULT_THREADING_*` constants from config.
  - `DigestReport` gains `threadingBatchesFailed: number`. All existing tests that construct `DigestReport` literals need this added — but no test does that (the field is set by `runDigest`, asserted by the new orchestrator test only).
  - `Config.threadingMaxAttempts` defaults via Zod, no migration.

- **Why retry-then-soft-fail (not just retry, not just soft-fail):**
  - Retry-only: doesn't help when the LLM consistently hallucinates on a particular batch (e.g., session content that confuses it). Sync still aborts.
  - Soft-fail-only: wastes one batch on transient runner errors that would self-heal on retry.
  - Together: cheap retries (3 by default) catch transient issues; persistent failures don't poison the rest.

- **Why default maxAttempts=3:**
  - Conservative. Most LLM hallucinations are intermittent; 3 attempts has empirically high recovery rate. User can tune via `~/.memvc/config.json` `"threadingMaxAttempts": 5`.

- **Out of scope (deliberately):**
  - Smarter retry (e.g., shorter prompt on retry, or "previous attempt produced this error: ..." injected into prompt) — would require touching `assets/prompts/thread.md`, more complex.
  - Per-runner retry policies — anthropic-api typically doesn't fail on parse but may rate-limit; future Sprint 5 will revisit.
  - Backoff between retries — not adding now; the retries are sequential per batch (the worker pool isn't blocked) so the back-pressure is natural.
  - Reporting *which* sessions were in failed batches — caller can compute via `findNewSessionEntries` next sync; not worth adding to the report.
  - Test for `mapWithConcurrency` interaction (concurrency cap × retry) — covered transitively by the existing concurrency cap test + new partial-failure test.
