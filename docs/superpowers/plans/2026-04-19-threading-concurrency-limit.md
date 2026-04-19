# Threading Concurrency Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap how many `runner.run` calls execute simultaneously inside `runThreading` so a sync that produces 50+ batches doesn't fork 50+ `claude -p` subprocesses at once and overwhelm the local CLI / system. Default cap is 4; configurable via existing `Config` so power users can tune.

**Architecture:**
- Add a tiny generic `mapWithConcurrency(items, limit, worker)` helper in a new `src/digest/concurrency.ts` (8-line worker-pool pattern). No external deps.
- `runThreading` accepts an optional `concurrency: number` parameter (default 4) and routes its current `Promise.all(batches.map(runner.run))` through the helper.
- `runDigest` (and `runDigestRedo` if it ever fans out — it doesn't today) reads the concurrency from a new `Config.threadingConcurrency` field and passes it down.
- Article phase ALSO fans out per-thread (one `generateArticle` call per thread). Currently it's sequential (`for ... await`), so it's not the immediate culprit, but we keep that sequential for now — articles are smaller, lower-priority for parallelism, and the current code already serializes them. Out of scope for this fix.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest.

**Spec reference:** Bug surfaced 2026-04-19: `memvc sync` at scale (310 new sessions → 57 batches) saturated the local `claude` CLI and produced cascading exit-code-1 failures. No spec change needed; this is operational hardening.

---

## Scope

One focused fix in two tasks:

- **Task 1**: `concurrency.ts` worker-pool helper + tests.
- **Task 2**: Wire it into `runThreading`; expose tunable via `Config.threadingConcurrency`; thread default through `runDigest` from `sync.ts`.

No new commands, no behavior change for users — except that `memvc sync` now finishes (slowly) instead of failing.

---

## File Structure

**New files:**
- `src/digest/concurrency.ts` — `mapWithConcurrency<T, R>(items, limit, worker): Promise<R[]>`
- `tests/digest/concurrency.test.ts` — order preservation, limit observed, error propagation

**Modified files:**
- `src/digest/threading.ts` — accept optional `concurrency`, route through helper
- `src/digest/orchestrator.ts` — accept optional `concurrency`, pass to `runThreading`
- `src/config.ts` — add `threadingConcurrency: z.number().int().positive().default(4)`
- `src/commands/sync.ts` — pass `cfg.threadingConcurrency` (via `SyncOptions`) into `runDigest`
- `tests/digest/threading.test.ts` — add a test that asserts the concurrency cap is honored

**Untouched:** `src/digest/redo.ts` (calls only `generateArticle`/`generateChapter` per-thread/per-project, which are sequential), `src/digest/article.ts`, `src/digest/chapter.ts`, `src/digest/pipeline.ts`, `src/commands/digest.ts`.

---

## Task 1: Worker-pool helper

**Files:**
- Create: `src/digest/concurrency.ts`
- Create: `tests/digest/concurrency.test.ts`

### Public surface

```ts
/**
 * Map `items` through `worker` with at most `limit` workers running at once.
 * Returns results in the SAME order as input. Throws on first worker error.
 *
 * Pattern: a fixed-size pool of workers, each pulling the next index from a
 * shared cursor. No external deps. Strongly typed; preserves input order
 * regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

### Tests

- [ ] **Step 1.1: Write failing test file**

Create `tests/digest/concurrency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/digest/concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order, regardless of completion order", async () => {
    // Worker for index 0 takes 30ms; index 1 takes 10ms.
    const got = await mapWithConcurrency([0, 1, 2], 3, async (n) => {
      await delay(n === 0 ? 30 : 5);
      return n * 10;
    });
    expect(got).toEqual([0, 10, 20]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const worker = async (n: number): Promise<number> => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
      return n;
    };
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, worker);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // sanity: at least some parallelism happened
  });

  it("returns empty array for empty input", async () => {
    const got = await mapWithConcurrency([], 4, async (n: number) => n);
    expect(got).toEqual([]);
  });

  it("works with limit larger than items.length", async () => {
    const got = await mapWithConcurrency([1, 2, 3], 99, async (n) => n * 2);
    expect(got).toEqual([2, 4, 6]);
  });

  it("works with limit=1 (effectively serial)", async () => {
    const order: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
      order.push(n);
      await delay(5);
    });
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("throws on first worker error and stops dispatching", async () => {
    let started = 0;
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
        started++;
        await delay(5);
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow(/boom/);
    // started should be < items.length (we stop dispatching after the error).
    // Exact count depends on race; just assert we didn't dispatch all 5.
    expect(started).toBeLessThan(5);
  });

  it("throws on limit < 1", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/limit/);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npm test -- concurrency`
Expected: FAIL with "Cannot find module '../../src/digest/concurrency.js'".

- [ ] **Step 1.3: Write `src/digest/concurrency.ts`**

```ts
/**
 * Map `items` through `worker` with at most `limit` workers running at once.
 * Returns results in the SAME order as input. Throws on first worker error
 * and stops dispatching new tasks (in-flight tasks complete naturally; their
 * results are discarded).
 *
 * Pattern: fixed-size pool of workers, each pulling the next index from a
 * shared cursor. No external deps.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  let cursor = 0;
  let aborted = false;
  let abortError: unknown;

  async function pumpOne(): Promise<void> {
    while (!aborted) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!, i);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          abortError = err;
        }
        return;
      }
    }
  }

  const poolSize = Math.min(limit, items.length);
  const pool = Array.from({ length: poolSize }, () => pumpOne());
  await Promise.all(pool);

  if (aborted) throw abortError;
  return results;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npm test -- concurrency`
Expected: all 7 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/digest/concurrency.ts tests/digest/concurrency.test.ts
git commit -m "feat(digest): add mapWithConcurrency worker-pool helper"
```

---

## Task 2: Wire concurrency limit into `runThreading` + plumb through orchestrator + config

**Files:**
- Modify: `src/digest/threading.ts`
- Modify: `src/digest/orchestrator.ts`
- Modify: `src/config.ts`
- Modify: `src/commands/sync.ts`
- Modify: `tests/digest/threading.test.ts`

### Step 2.1 — `src/digest/threading.ts`

- [ ] **Replace `runThreading` body to use `mapWithConcurrency`**

(a) Add to imports:

```ts
import { mapWithConcurrency } from "./concurrency.js";
```

(b) Replace the `runThreading` function body. The new function takes an optional `concurrency` param (default 4) and uses the helper instead of `Promise.all(batches.map(...))`:

```ts
export async function runThreading(
  runner: LlmRunner,
  batches: SessionForBatching[][],
  concurrency = 4,
): Promise<ThreadCandidate[]> {
  const results = await mapWithConcurrency(batches, concurrency, (batch) =>
    runner.run(
      THREAD_PROMPT,
      { sessionList: JSON.stringify(batch.map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        endedAt: s.endedAt,
      }))) },
      { outputFormat: "json" },
    ),
  );

  const perBatchCandidates: ThreadCandidate[][] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
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

### Step 2.2 — `src/digest/orchestrator.ts`

- [ ] **Add optional `concurrency` to `runDigest`; pass to `runThreading`**

(a) Find the `runDigest` signature:

```ts
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null,
): Promise<DigestReport> {
```

Add a 6th parameter:

```ts
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null,
  concurrency = 4,
): Promise<DigestReport> {
```

(b) Inside the function, find the line `const candidates = await runThreading(runner, batches);` and change to:

```ts
const candidates = await runThreading(runner, batches, concurrency);
```

### Step 2.3 — `src/config.ts`

- [ ] **Add `threadingConcurrency` to the Zod schema with default 4**

In `src/config.ts`, add a field to the schema (place it next to `runner` / `runnerModel`):

```ts
  threadingConcurrency: z.number().int().positive().default(4),
```

The full schema after the change should look like:

```ts
const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api", "github-models"]).default("claude-cli"),
  runnerModel: z.string().default(""),
  threadingConcurrency: z.number().int().positive().default(4),
});
```

(Existing config files on disk that don't have this field will get the default 4 via Zod — no migration needed.)

### Step 2.4 — `src/commands/sync.ts`

- [ ] **Plumb `threadingConcurrency` from cfg into `runDigest`**

(a) In `SyncOptions`, add an optional field next to `runnerConfig`:

```ts
  /** Cap on parallel runner calls during the threading phase. Default 4. */
  threadingConcurrency?: number;
```

(b) In `runSync`, find the call to `runDigest`. It currently looks like:

```ts
digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex, key);
```

Change to:

```ts
digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex, key, opts.threadingConcurrency ?? 4);
```

(c) In `syncCmd`, find the `runSync({...})` call and add `threadingConcurrency: cfg.threadingConcurrency` to the args object:

```ts
  const r = await runSync({
    repoPath: cfg.repoPath,
    encrypt: cfg.encrypt,
    passphrase,
    saltB64: cfg.salt,
    push: true,
    repoUrl: cfg.repoUrl,
    deviceBranch: cfg.deviceBranch,
    noDigest: opts.noDigest,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
    threadingConcurrency: cfg.threadingConcurrency,
  });
```

### Step 2.5 — `tests/digest/threading.test.ts`

- [ ] **Add a test asserting the concurrency cap is honored**

Append this test inside the existing `describe("runThreading", ...)` block, after the last existing test:

```ts
  it("respects the concurrency cap (no more than `concurrency` runner calls in flight at once)", async () => {
    let active = 0;
    let peak = 0;
    const replies: RunResult[] = [];
    const runner: LlmRunner = {
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true, text: "[]", durationMs: 10 } satisfies RunResult;
      },
    };
    const batches = Array.from({ length: 8 }, (_, i) => [s(`s${i}`)]);
    await runThreading(runner, batches, 2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    void replies; // silences unused-var if you remove the array
  });
```

(You may have to remove the `void replies; // ...` line if it's flagged; it's a defensive carry-over from the existing test scaffolding.)

### Step 2.6 — Run + verify + commit

- [ ] **Run `npm test -- threading concurrency`** — both green; threading test count grows by 1.
- [ ] **Run `npm test`** — full suite green (was 162 → 162 + 7 concurrency + 1 threading = 170).
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/threading.ts src/digest/orchestrator.ts src/config.ts src/commands/sync.ts tests/digest/threading.test.ts
git commit -m "feat(digest): cap threading runner concurrency (default 4) to avoid overwhelming local LLM CLI"
```

---

## Task 3: Smoke + roadmap note

- [ ] **Step 3.1: Manual smoke**

```bash
cd /Users/yueliu/edge/memvc
npm run build
# memvc is npm-linked so this picks up the new dist/ automatically
export MEMVC_PASSPHRASE='your-passphrase'
memvc sync
```

Expected: digest now runs with at most 4 concurrent `claude -p` subprocesses. With 57 batches at ~30 sec each (claude CLI typical), that's ~7 minutes of threading wall-clock — slow but no longer fails. Watch `htop` if curious.

- [ ] **Step 3.2: Optional config override for power users**

To raise the cap manually after a successful run, edit `~/.memvc/config.json`:

```diff
   "runnerModel": "",
+  "threadingConcurrency": 8
 }
```

No code change needed.

- [ ] **Step 3.3: This is a bugfix, not a sprint deliverable** — no roadmap update required.

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - The bug surfaces a missing operational guardrail; no spec wording covers it. We add the cap with a sensible default and a config knob to override.
  - `runThreading`'s "throws on first sign of trouble" contract is preserved (now via `mapWithConcurrency` propagating the first error).

- **Placeholder scan:** every code step has full code; no TBD; no "similar to"; no "add validation".

- **Type consistency:**
  - `concurrency` is `number` everywhere; `mapWithConcurrency<T, R>` is generic.
  - `runDigest`'s new 6th param defaults to 4 — backward compatible with the 159 existing tests that pass 5 args.
  - `runThreading`'s new 3rd param defaults to 4 — backward compatible with existing tests that pass 2 args.
  - `Config.threadingConcurrency` defaults via Zod, so existing `~/.memvc/config.json` files don't need migration.

- **Why limit=4:** empirical default. Most laptops handle 4 parallel `claude -p` subprocesses without saturating, while still giving meaningful speedup vs serial. User's report had ~57 concurrent → catastrophic. 4 is conservative; users with beefier machines or a lighter runner backend can override via config.

- **Why article phase isn't capped here:** `runDigest`'s article loop already runs sequentially (`for (const input of allArticleInputs) { await generateArticle(...) }`). It's effectively concurrency=1. Bumping it would require a separate decision; out of scope for this fix.

- **Why redo isn't touched:** `runDigestRedo` calls `generateArticle` and `generateChapter` in sequential `for-await` loops too. Same story — already serial.

- **Out of scope (deliberately):**
  - Per-runner concurrency tuning (claude-cli is fork-heavy; anthropic-api could likely sustain higher).
  - Adaptive backoff / retry on rate-limit signals.
  - Article-phase parallelism.
  - Visible progress reporting during the threading phase (currently silent — user sees the "digest:" summary at the end).
