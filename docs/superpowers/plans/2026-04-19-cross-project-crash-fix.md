# Cross-Project Crash Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a single bad LLM grouping (one threadId spanning multiple projects) from throwing and discarding 13+ minutes of completed threading work. The bug surfaced 2026-04-19: `pipeline.ts: thread misc-empty-session spans multiple projects (...)` killed `runDigest`, no book/ output, no toc, no saveBookIndex. Fix in three layers: (1) `mergeCandidates` keys cross-batch identity by (threadId, project) instead of threadId alone so two projects' identical slugs stay distinct, (2) `buildArticleInputForThread` no longer throws on multi-project — it returns null with warning so the orchestrator continues, and (3) `runDigest` wraps the whole pipeline in a top-level catch that always tries to persist `BookIndex` + run `toc` + `saveBookIndex` even when downstream phases blow up.

**Architecture:**
- **Layer 1 (preventive):** `mergeCandidates` groups by composite `(threadId, project)`. The shared `threadId` becomes a property of the group, but a `misc-empty-session` from `project=A` and `project=B` are now distinct groups → distinct candidates. Threading prompt also strengthens "no cross-project merging" rule, but the code-level fix is the load-bearing protection.
- **Layer 2 (containment):** `buildArticleInputForThread` returns `null` (not throws) when sessions span multiple projects, with a console.warn naming the offending threadId. The caller (`buildArticleInputs` and `buildStaleArticleInputs`) already handles `null`. Sessions in the dropped candidate become eligible for next-sync recovery.
- **Layer 3 (resilience):** `runDigest` wraps the entire body in a try-catch that ALWAYS runs `generateToc(...)` + `saveBookIndex(...)` in a finally block (best-effort), so any unexpected throw still produces some output. The thrown error is captured in `DigestReport.crashedAt` so caller knows.

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

**Reference:** Production log 2026-04-19, 54 successful threading batches discarded due to `misc-empty-session` cross-project group, single throw at `pipeline.ts buildArticleInputForThread`.

---

## Scope

3 tasks, 3 commits.

- **Task 1:** `mergeCandidates` keys by `(threadId, project)`. Threading prompt strengthens project boundary.
- **Task 2:** `buildArticleInputForThread` soft-fails (returns null + warns) on multi-project candidates.
- **Task 3:** `runDigest` always runs toc + saveBookIndex even on inner crash.

After this fix, a recurrence of the original LLM behavior would: merge prevents the cross-project group from forming → threading produces 6 distinct `misc-empty-session-<project-suffix>` candidates → article phase processes each one in its own project → no crash. Even if some new bug throws inside article phase, toc + BookIndex still get persisted.

---

## File Structure

**Modified:**
- `src/digest/types.ts` — add `project: string` to `ThreadCandidate` (becomes a non-optional output field)
- `src/digest/threading.ts` — `mergeCandidates` keys by (threadId, project); each candidate carries `project` from input batch's first session; recovery candidates carry `project` from their session
- `src/digest/pipeline.ts` — `buildArticleInputForThread` returns null on multi-project (with warn), accepts the new `ThreadCandidate.project` if present, uses it as a hint
- `src/digest/orchestrator.ts` — top-level try/catch around the entire body; always run toc + persist; add `crashedAt?: string` to `DigestReport`
- `src/digest/redo.ts` — same try/finally pattern for parity (less critical since redo is short, but consistent)
- `assets/prompts/thread.md` — add explicit "do NOT group sessions across different projects" rule
- Tests: `tests/digest/threading.test.ts`, `tests/digest/pipeline.test.ts`, `tests/digest/orchestrator.test.ts`

**Untouched:** article.ts, chapter.ts, toc.ts, batcher.ts, session-signal.ts, runner.ts, sync.ts, digest.ts.

---

## Task 1: `mergeCandidates` keyed by (threadId, project) + prompt rule

**Files:**
- Modify: `src/digest/types.ts`
- Modify: `src/digest/threading.ts`
- Modify: `assets/prompts/thread.md`
- Modify: `tests/digest/threading.test.ts`

### Step 1.1 — `ThreadCandidate.project` field

In `src/digest/types.ts`, add `project: string` to `ThreadCandidate` (non-optional going forward; existing code paths that build candidates will populate it).

```ts
export interface ThreadCandidate {
  threadId: string;
  project: string;          // NEW: required; populated by threading.ts from batch context
  sessionIds: string[];
  title: string;
  skip?: boolean;
  reason?: string;
  worthWriting?: boolean;
}
```

### Step 1.2 — `mergeCandidates` groups by composite key

In `src/digest/threading.ts`, change `mergeCandidates` so the `groups` Map and the canonical-collapse Map both key on `${threadId}\0${project}` (using `\0` as a separator since project slugs can't contain it).

The full updated function:

```ts
export function mergeCandidates(perBatch: ThreadCandidate[][]): ThreadCandidate[] {
  interface Group {
    threadId: string;
    project: string;
    title: string;
    sessionIds: string[];
    skip: boolean;
    reason?: string;
    firstSeen: number;
  }
  const key = (threadId: string, project: string) => `${threadId}\0${project}`;
  const groups = new Map<string, Group>();
  let idx = 0;
  for (const batch of perBatch) {
    for (const c of batch) {
      const k = key(c.threadId, c.project);
      let g = groups.get(k);
      if (!g) {
        g = {
          threadId: c.threadId,
          project: c.project,
          title: c.title,
          sessionIds: [],
          skip: false,
          firstSeen: idx,
        };
        groups.set(k, g);
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

  // Slug-equivalence collapse: only collapse groups within the SAME project.
  const groupList = Array.from(groups.values());
  const canonicalOf = new Map<string, string>(); // key → canonical key
  for (const g of groupList) {
    let canonical = g;
    for (const other of groupList) {
      if (other === g) continue;
      if (other.project !== g.project) continue;  // NEW: same-project only
      if (areEquivalent(g.threadId, other.threadId)) {
        if (
          other.threadId.length > canonical.threadId.length ||
          (other.threadId.length === canonical.threadId.length &&
            other.firstSeen < canonical.firstSeen)
        ) {
          canonical = other;
        }
      }
    }
    canonicalOf.set(key(g.threadId, g.project), key(canonical.threadId, canonical.project));
  }

  const finalGroups = new Map<string, Group>();
  for (const g of groupList) {
    const canonKey = canonicalOf.get(key(g.threadId, g.project))!;
    let cg = finalGroups.get(canonKey);
    if (!cg) {
      const seed = groups.get(canonKey)!;
      cg = {
        threadId: seed.threadId,
        project: seed.project,
        title: seed.title,
        sessionIds: [],
        skip: false,
        firstSeen: seed.firstSeen,
      };
      finalGroups.set(canonKey, cg);
    }
    for (const sid of g.sessionIds) {
      if (!cg.sessionIds.includes(sid)) cg.sessionIds.push(sid);
    }
    if (g.skip) {
      cg.skip = true;
      if (g.reason && !cg.reason) cg.reason = g.reason;
    }
  }

  const out: ThreadCandidate[] = Array.from(finalGroups.values())
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((g) => {
      const tc: ThreadCandidate = {
        threadId: g.threadId,
        project: g.project,
        title: g.title,
        sessionIds: g.sessionIds,
      };
      if (g.skip) tc.skip = true;
      if (g.reason) tc.reason = g.reason;
      return tc;
    });
  return out;
}
```

### Step 1.3 — `processBatch` populates `project` on every candidate

The LLM's response doesn't include `project` (the prompt schema doesn't ask for it). Inject it server-side: after `asThreadCandidates(parsed, batchIndex)` succeeds, derive each candidate's project from its sessionIds by looking them up in the input batch.

In `processBatch` inside `runThreading`, replace:

```ts
const candidates = asThreadCandidates(parsed, batchIndex);
return { ok: true, candidates };
```

with:

```ts
const rawCandidates = asThreadCandidates(parsed, batchIndex);
// Inject project from the input batch. If a candidate's sessionIds span
// multiple projects within this batch (shouldn't happen — batcher groups by
// project — but defensive), split into one candidate per project.
const sidToProject = new Map<string, string>();
for (const s of batch) sidToProject.set(s.sessionId, s.project);
const candidates: ThreadCandidate[] = [];
for (const c of rawCandidates) {
  // Bucket this candidate's sessionIds by project.
  const byProject = new Map<string, string[]>();
  for (const sid of c.sessionIds) {
    const proj = sidToProject.get(sid);
    if (!proj) continue; // sessionId not in this batch — drop (recovery picks it up)
    let bucket = byProject.get(proj);
    if (!bucket) { bucket = []; byProject.set(proj, bucket); }
    bucket.push(sid);
  }
  for (const [proj, sids] of byProject) {
    candidates.push({
      threadId: c.threadId,
      project: proj,
      title: c.title,
      sessionIds: sids,
      ...(c.skip ? { skip: true } : {}),
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.worthWriting !== undefined ? { worthWriting: c.worthWriting } : {}),
    });
  }
}
return { ok: true, candidates };
```

### Step 1.4 — Recovery synthesizes project from session

In the recovery section of `runThreading`, the existing code constructs synthetic candidates from `dropped: EnrichedSessionForBatching[]`. Add `project` to each:

```ts
const recoveredCandidates: ThreadCandidate[] = dropped.map((s) => ({
  threadId: synthThreadId(s),
  project: s.project,
  title: synthTitle(s),
  sessionIds: [s.sessionId],
  worthWriting: true,
}));
```

### Step 1.5 — Strengthen prompt rule

In `assets/prompts/thread.md`, add a numbered rule (place after the existing rule 1 about mentioning every session):

```
1.5. **绝对不要跨项目合并**：每个 thread 必须属于唯一一个项目。如果两个 session 看起来话题相关但 project 字段不同，它们必须分到不同的 thread（即使 threadId 相似也没关系，因为后端按 (threadId, project) 去重，跨项目同名 threadId 不会被错误合并）。
```

(The wording reassures the LLM that backend protection exists, so no need for it to be paranoid; but explicitly ask not to cross projects.)

### Step 1.6 — Tests

Add to `tests/digest/threading.test.ts`:

```ts
describe("mergeCandidates — cross-project safety", () => {
  it("two candidates with the SAME threadId but DIFFERENT projects stay distinct", () => {
    const merged = mergeCandidates([
      [{ threadId: "misc-empty", project: "proj-a", title: "空", sessionIds: ["a1"] }],
      [{ threadId: "misc-empty", project: "proj-b", title: "空", sessionIds: ["b1"] }],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((c) => `${c.threadId}@${c.project}`).sort())
      .toEqual(["misc-empty@proj-a", "misc-empty@proj-b"]);
    // Sessions stay separate, not merged.
    expect(merged.find((c) => c.project === "proj-a")!.sessionIds).toEqual(["a1"]);
    expect(merged.find((c) => c.project === "proj-b")!.sessionIds).toEqual(["b1"]);
  });

  it("same threadId AND same project DOES merge (regression of pre-fix behavior)", () => {
    const merged = mergeCandidates([
      [{ threadId: "fix-bug", project: "proj-a", title: "fix", sessionIds: ["s1"] }],
      [{ threadId: "fix-bug", project: "proj-a", title: "fix", sessionIds: ["s2"] }],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionIds).toEqual(["s1", "s2"]);
  });

  it("slug-equivalence collapse only happens within the same project", () => {
    // "fix-bug" and "fix-bug-1" normalize to same slug → would collapse...
    // ...but only within same project. Across projects they stay distinct.
    const merged = mergeCandidates([
      [{ threadId: "fix-bug", project: "proj-a", title: "x", sessionIds: ["a1"] }],
      [{ threadId: "fix-bug-1", project: "proj-b", title: "y", sessionIds: ["b1"] }],
    ]);
    expect(merged).toHaveLength(2);
  });
});
```

Update existing `mergeCandidates` and `runThreading` tests to add `project: "p"` to every ThreadCandidate literal. Most test fixtures use `project = "p"` already in the `s()` helper, so the migration is mechanical.

### Step 1.7 — Run + commit

- [ ] **Run `npm test`** — green; expect ~3 new tests added.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit:** `git add -u && git commit -m "fix(digest): mergeCandidates keys by (threadId, project) — prevent cross-project group merge"`

---

## Task 2: `buildArticleInputForThread` soft-fails on multi-project

**Files:**
- Modify: `src/digest/pipeline.ts`
- Modify: `tests/digest/pipeline.test.ts`

### Step 2.1 — Replace throw with null + warn

In `src/digest/pipeline.ts buildArticleInputForThread`, find the multi-project branch (currently throws). Change:

```ts
if (projects.size > 1) {
  throw new Error(
    `${contextLabel}: thread ${threadId} spans multiple projects (${[...projects].join(", ")})`,
  );
}
```

to:

```ts
if (projects.size > 1) {
  console.warn(
    `${contextLabel}: thread ${threadId} spans multiple projects (${[...projects].join(", ")}); dropping this candidate (sessions will retry next sync)`,
  );
  return null;
}
```

(Existing callers — `buildArticleInputs` and `buildStaleArticleInputs` — already handle the `null` return by skipping; verify with `grep`.)

### Step 2.2 — Test

Add to `tests/digest/pipeline.test.ts`:

```ts
it("buildArticleInputForThread soft-fails (returns null + warn) when sessions span multiple projects", () => {
  const eA = ie({ sessionId: "a", project: "proj-a", relativePath: "raw_sessions/c/a/x/a.md" });
  const eB = ie({ sessionId: "b", project: "proj-b", relativePath: "raw_sessions/c/b/x/b.md" });
  writeSessionMd(eA.relativePath, "## User\n\na");
  writeSessionMd(eB.relativePath, "## User\n\nb");
  const idx = makeIndex([eA, eB]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const got = buildArticleInputForThread("mixed", "title", ["a", "b"], idx, repoRoot, "test", null);
    expect(got).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spans multiple projects"));
  } finally {
    warn.mockRestore();
  }
});
```

If a previous test asserted `expect(() => buildArticleInputForThread(...)).toThrow(/multiple projects/)`, replace it with the soft-fail assertion.

### Step 2.3 — Run + commit

- [ ] **Run `npm test`** — green.
- [ ] **Commit:** `git add -u && git commit -m "fix(digest): buildArticleInputForThread soft-fails on multi-project (no throw)"`

---

## Task 3: Top-level try/catch in `runDigest` + always-run toc/save

**Files:**
- Modify: `src/digest/orchestrator.ts`
- Modify: `src/digest/redo.ts`
- Modify: `tests/digest/orchestrator.test.ts`

### Step 3.1 — Add `crashedAt?: string` to `DigestReport`

In `src/digest/orchestrator.ts`, extend the type:

```ts
export interface DigestReport {
  // ... existing fields ...
  /** When set, the pipeline body threw before completion. toc + save still ran
   *  in the finally block. Caller should warn the user but not treat sync as
   *  total failure. */
  crashedAt?: string;
}
```

### Step 3.2 — Wrap `runDigestImpl` body in try/catch/finally

`runDigestImpl` is the inner private function called by the public `runDigest` after `withIsolatedCwd`. Wrap its body so toc + saveBookIndex (the latter is the caller's job currently — leave it) still happen.

Key invariants:
- The pruning step at the top of the public `runDigest` already runs BEFORE `withIsolatedCwd`. Don't move it.
- `generateToc` is mechanical (no LLM) and idempotent. Safe to always call.
- `bookIndex` mutation persists in the caller's reference. We don't need to re-saveBookIndex here — `runSync` and `runDigestResetCmd` already do it after `runDigest` returns.

Restructure `runDigestImpl`:

```ts
async function runDigestImpl(/* same params */): Promise<DigestReport> {
  const report: DigestReport = { /* same initial state */ };
  let crashedAt: string | undefined;
  try {
    // ---- threading phase ---- (existing body)
    // ---- article phase ---- (existing body)
    // ---- chapter phase ---- (existing body)
  } catch (e) {
    crashedAt = e instanceof Error ? e.message : String(e);
    console.warn(`runDigest: phase crashed: ${crashedAt}; will still attempt toc + persist BookIndex`);
  }

  // ---- toc phase always runs ----
  try {
    reporter.tocStart();
    const tocResult = generateToc(repoRoot, bookIndex);
    report.tocFilesWritten = tocResult.written;
    reporter.tocDone(tocResult.written.length);
  } catch (e) {
    console.warn(`runDigest: toc phase also crashed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (crashedAt) report.crashedAt = crashedAt;
  return report;
}
```

### Step 3.3 — `runDigestRedoImpl` same pattern

`src/digest/redo.ts runDigestRedoImpl` — wrap the article + chapter phases in try/catch, always run toc, add `crashedAt?: string` to `RedoReport`.

### Step 3.4 — Tests

Add to `tests/digest/orchestrator.test.ts`:

```ts
describe("runDigest — top-level crash containment", () => {
  it("when article phase throws, toc still runs and BookIndex is preserved in caller's ref", async () => {
    // Stage a session, but make generateArticle throw via a runner that throws
    // synchronously (orchestrator catches in its outer try).
    const e = ie({ sessionId: "s1" });
    writeSessionMd(e.relativePath, "## User\n\nfix bug");
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    let called = 0;
    const runner: LlmRunner = {
      async run(_p, vars) {
        called++;
        // First call = threading: returns valid candidate.
        if (called === 1) return { ok: true, durationMs: 1, text: JSON.stringify([
          { threadId: "t1", title: "t", sessionIds: ["s1"] },
        ])};
        // Second call = article: throw to simulate downstream crash.
        throw new Error("simulated crash inside article phase");
      },
    };
    const r = await runDigest(runner, repoRoot, idx, book, null, 4, 1, silentReporter());
    // Even though article-phase threw via runner, generateArticle's own
    // contract converts that into a "failed" status (no orchestrator-level
    // crash). For an orchestrator-level crash, we'd need to inject failure
    // upstream of generateArticle — see next test.
    expect(r.tocFilesWritten).toContain("book/index.md");
  });

  it("when buildArticleInputs throws (e.g. corrupt index), report.crashedAt is set and toc still runs", async () => {
    // Make pipeline.ts throw by passing an indexFile entry whose .md path is
    // a directory (causes readSync EISDIR).
    const e = ie({ sessionId: "s1", relativePath: "some/dir-not-file" });
    mkdirSync(join(repoRoot, "some/dir-not-file"), { recursive: true }); // exists as dir
    const idx = makeIndex([e]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const runner: LlmRunner = { async run() { throw new Error("not called"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runDigest(runner, repoRoot, idx, book, null, 4, 1, silentReporter());
      expect(r.crashedAt).toBeTruthy();
      expect(r.tocFilesWritten).toContain("book/index.md"); // toc still ran
    } finally {
      warn.mockRestore();
    }
  });
});
```

### Step 3.5 — Run + commit

- [ ] **Run `npm test`** — green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit:** `git add -u && git commit -m "fix(digest): wrap runDigest body in try/catch; always run toc + return DigestReport even on crash"`

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - User report: 54 successful threading batches discarded due to cross-project crash. → Layer 1 (mergeCandidates) prevents the crash from forming. Layer 2 (soft-fail) prevents any future similar issue from killing the run. Layer 3 (try/catch) makes the entire pipeline resilient.
- **Placeholder scan:** every step has full code; no TBD.
- **Type consistency:**
  - `ThreadCandidate.project: string` is now non-optional. All call sites that construct candidates must populate it: `mergeCandidates` reads from input candidates (which have it because `processBatch` injects it). Recovery candidates: get it from the dropped session. Tests: must add `project: "p"` to every `ThreadCandidate` literal.
  - `DigestReport.crashedAt?: string` is optional/additive — backward compatible.
- **Why not throw + retry:** failed batches (throwing) reappear next sync naturally via `findNewSessionEntries`. But a downstream crash AFTER threading wastes ~13 minutes. Soft-fail + always-run-toc preserves both the threading work and any partial article/chapter outputs.

- **Out of scope (deliberately):**
  - Smarter "split a multi-project candidate into N per-project candidates" in `buildArticleInputForThread`. The Task 1 fix at `processBatch` already prevents multi-project candidates from forming cross-batch; Task 2 just hardens the boundary. Splitting a within-batch multi-project candidate is theoretically possible but unnecessary because batcher groups by project before the batch is built.
  - Auto-retry on crash. User can run `memvc digest --redo` after a crash to retry.
