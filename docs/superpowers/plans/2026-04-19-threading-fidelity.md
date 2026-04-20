# Threading Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the threading phase from silently dropping the majority of sessions (real-world: 77 raw → 10 BookEntries, 87% loss). Give the LLM enough context to make meaningful grouping decisions (title + preview + algorithmic score), require it to mention every input session in its output (worthWriting field instead of silent drop), and add a defensive backstop that auto-recovers any session the LLM still misses.

**Architecture:**
- A new `src/digest/session-signal.ts` module computes per-session signals: title (first user message), preview (first 300 chars of user text), and an insight score (0-1 from logex's SIGNAL_CATEGORIES keyword classifier). Pure function over a session .md body.
- `pipeline.ts buildBatchingInput` is enriched: it now produces `EnrichedSessionForBatching` which adds `title`, `preview`, `insightScore`. Batcher unchanged (only uses tokenEstimate + project + endedAt).
- `threading.ts runThreading` constructs a richer `sessionList` JSON for the LLM (id, project, endedAt, title, preview, score). New `assets/prompts/thread.md` requires the LLM to mention every session and emit `worthWriting: bool`.
- `ThreadCandidate.worthWriting` becomes part of the schema; `worthWriting=false` records as a skip BookEntry (preserving spec's "skip:true means LLM judged trivial" semantics, just made explicit).
- After threading merges, `runThreading` computes `dropped = inputSessionIds - outputSessionIds`. Each dropped session is force-bucketed as a single-session ThreadCandidate with `worthWriting=true` and a synthetic threadId derived from the session's title slug. This is the safety net.

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

**Reference:** `/Users/yueliu/edge/logex/src/pipeline/{chunk,segment}.ts` for SIGNAL_CATEGORIES keyword scoring + chunk-summary prompt format.

---

## Scope

5 tasks. Each is independently committable. Tasks 1-3 are pure infrastructure; Task 4 is the prompt rewrite + threading wiring; Task 5 is the safety net.

- Task 1: `session-signal.ts` (signal extraction + scoring) + tests
- Task 2: `EnrichedSessionForBatching` type and `buildBatchingInput` upgrade + tests
- Task 3: New `assets/prompts/thread.md` with rich input + worthWriting + threading.ts wiring to pass through new fields
- Task 4: `worthWriting` semantics in `ThreadCandidate` and `recordSkippedThreadCandidates`
- Task 5: `recoverDroppedSessions` safety net in `runThreading`

---

## File Structure

**New files:**
- `src/digest/session-signal.ts` — `extractSessionSignals(mdBody): SessionSignals`
- `tests/digest/session-signal.test.ts`

**Modified:**
- `src/digest/types.ts` — `EnrichedSessionForBatching` extends `SessionForBatching`; `ThreadCandidate.worthWriting?: boolean`
- `src/digest/pipeline.ts` — `buildBatchingInput` returns enriched shape
- `src/digest/threading.ts` — sessionList includes new fields; safety net for dropped sessions
- `src/digest/orchestrator.ts` — pass enriched input through; treat `worthWriting=false` as skip via existing `recordSkippedThreadCandidates`
- `assets/prompts/thread.md` — rewritten prompt (rich input, worthWriting, mention-every-session requirement)
- `tests/digest/pipeline.test.ts` — assert enriched output
- `tests/digest/threading.test.ts` — assert recovery + worthWriting handling
- `tests/digest/orchestrator.test.ts` — adjust integration test assertions

**Untouched:** `article.ts`, `chapter.ts`, `toc.ts`, `redo.ts`, `batcher.ts`, `book-index.ts`, `pipeline.recordSkippedThreadCandidates`, `commands/*`.

---

## Task 1: `session-signal.ts` extraction + scoring

**Files:**
- Create: `src/digest/session-signal.ts`
- Create: `tests/digest/session-signal.test.ts`

### Public surface

```ts
export interface SessionSignals {
  /** First user message text, trimmed, ≤ 80 chars (used as the title hint). */
  title: string;
  /** First ~300 chars of concatenated user messages — gives LLM topic context. */
  preview: string;
  /** Insight score 0.0–1.0 derived from keyword categories (logex algorithm). */
  insightScore: number;
}

/**
 * Pure function over a session's rendered .md body. Extracts:
 *   - title: first markdown ## User block's text, capped at 80 chars
 *   - preview: concatenation of all ## User block text, first 300 chars
 *   - insightScore: SIGNAL_CATEGORIES keyword classifier from logex
 */
export function extractSessionSignals(mdBody: string): SessionSignals;
```

### Algorithm details (verbatim from logex chunk.ts)

```ts
const SIGNAL_CATEGORIES: Record<string, string[]> = {
  debugging: ['bug', 'error', 'fix', 'debug', 'root cause', 'traceback', 'broken', '问题', '修复'],
  architecture: ['architecture', 'design', 'pattern', 'trade-off', 'decision', 'approach', '架构', '设计'],
  discovery: ['learned', 'discovered', 'insight', 'gotcha', 'trap', 'pitfall', 'trick', '发现', '陷阱', '关键'],
  reasoning: ['because', 'instead of', 'rather than', 'why', 'the reason', '原因', '所以', '因为'],
  evaluation: ['review', 'evaluate', 'score', 'verdict', 'assessment', '评估', '审查'],
};
```

Score formula: `Math.min(1.0, (categoryHits / 5) * 0.4 + (totalHits / 15) * 0.3 + userRatio * 0.3)`. Floor at 0.1 if < 2 categories hit.

### Tests

- [ ] **Step 1.1: Write `tests/digest/session-signal.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extractSessionSignals } from "../../src/digest/session-signal.js";

describe("extractSessionSignals", () => {
  it("extracts title from the first ## User block", () => {
    const md = `# Display\n\n## User\n\nfix the bug in login\n\n## Assistant\n\nok`;
    const r = extractSessionSignals(md);
    expect(r.title).toBe("fix the bug in login");
  });

  it("caps title at 80 chars", () => {
    const long = "x".repeat(200);
    const md = `## User\n\n${long}\n`;
    const r = extractSessionSignals(md);
    expect(r.title.length).toBeLessThanOrEqual(80);
  });

  it("preview concatenates all ## User blocks, capped at 300 chars", () => {
    const md = `## User\n\nfirst question\n\n## Assistant\n\nresp\n\n## User\n\nsecond question\n`;
    const r = extractSessionSignals(md);
    expect(r.preview).toContain("first question");
    expect(r.preview).toContain("second question");
    expect(r.preview.length).toBeLessThanOrEqual(305); // 300 + ellipsis
  });

  it("insightScore is high when multiple SIGNAL_CATEGORIES hit", () => {
    const md = `## User\n\nfix the bug, root cause was a design pattern decision; learned a lot. why? because architecture was wrong.`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBeGreaterThan(0.3);
  });

  it("insightScore floors at 0.1 when fewer than 2 categories hit", () => {
    const md = `## User\n\nhi how are you\n\n## Assistant\n\nfine`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBe(0.1);
  });

  it("works on Chinese content", () => {
    const md = `## User\n\n修复了一个问题，发现是架构设计的关键陷阱，原因是因为没考虑边界`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBeGreaterThan(0.2);
  });

  it("handles empty body without crashing", () => {
    const r = extractSessionSignals("");
    expect(r.title).toBe("");
    expect(r.preview).toBe("");
    expect(r.insightScore).toBe(0);
  });

  it("handles body with only assistant messages (no user) — title empty", () => {
    const md = `## Assistant\n\nhello world`;
    const r = extractSessionSignals(md);
    expect(r.title).toBe("");
  });
});
```

- [ ] **Step 1.2: `npm test -- session-signal`** → FAIL (module missing).

- [ ] **Step 1.3: Implement `src/digest/session-signal.ts`**

```ts
const SIGNAL_CATEGORIES: Record<string, string[]> = {
  debugging: ["bug", "error", "fix", "debug", "root cause", "traceback", "broken", "问题", "修复"],
  architecture: ["architecture", "design", "pattern", "trade-off", "decision", "approach", "架构", "设计"],
  discovery: ["learned", "discovered", "insight", "gotcha", "trap", "pitfall", "trick", "发现", "陷阱", "关键"],
  reasoning: ["because", "instead of", "rather than", "why", "the reason", "原因", "所以", "因为"],
  evaluation: ["review", "evaluate", "score", "verdict", "assessment", "评估", "审查"],
};

export interface SessionSignals {
  title: string;
  preview: string;
  insightScore: number;
}

/**
 * Extract per-session signals from a rendered session .md body.
 * Pure; no IO.
 *
 * The .md body is produced by `src/writer.ts` and looks like:
 *   # <displayName>
 *   **Tool:** ... etc
 *   ---
 *   ## User _(timestamp)_
 *   <text>
 *   ## Assistant _(timestamp)_
 *   <text>
 *   ## User _(timestamp)_
 *   ...
 *
 * We extract user-message text only (assistant is too noisy for a topic preview).
 */
export function extractSessionSignals(mdBody: string): SessionSignals {
  const userTexts = extractUserTexts(mdBody);
  const joined = userTexts.join(" ").replace(/\s+/g, " ").trim();

  const titleSrc = userTexts[0] ?? "";
  const titleClean = titleSrc.replace(/\s+/g, " ").trim();
  const title = titleClean.length > 80 ? titleClean.slice(0, 80) : titleClean;

  const preview = joined.length > 300 ? joined.slice(0, 300) + "…" : joined;

  const score = scoreText(joined, userTexts.join(" ").length, mdBody.length);

  return { title, preview, insightScore: score };
}

/** Pull text from every "## User" block. Stops at the next "## " heading. */
function extractUserTexts(md: string): string[] {
  const out: string[] = [];
  // Lines that start a User block.
  const lines = md.split("\n");
  let inUser = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (/^## User\b/.test(line)) {
      if (buf.length > 0) {
        out.push(buf.join("\n").trim());
        buf = [];
      }
      inUser = true;
      continue;
    }
    if (/^## /.test(line)) {
      if (inUser && buf.length > 0) {
        out.push(buf.join("\n").trim());
        buf = [];
      }
      inUser = false;
      continue;
    }
    if (inUser) buf.push(line);
  }
  if (inUser && buf.length > 0) out.push(buf.join("\n").trim());
  return out.filter((s) => s.length > 0);
}

function scoreText(joinedLower: string, userTextLen: number, totalLen: number): number {
  if (!joinedLower) return 0;
  const lower = joinedLower.toLowerCase();
  let categoryHits = 0;
  let totalHits = 0;
  for (const keywords of Object.values(SIGNAL_CATEGORIES)) {
    const hits = keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > 0) {
      categoryHits++;
      totalHits += hits;
    }
  }
  if (categoryHits < 2) return 0.1;
  const userRatio = userTextLen / Math.max(totalLen, 1);
  const score = (categoryHits / 5) * 0.4 + (totalHits / 15) * 0.3 + userRatio * 0.3;
  return Math.min(1.0, score);
}
```

- [ ] **Step 1.4: `npm test -- session-signal`** → green.
- [ ] **Step 1.5: Commit**: `git add src/digest/session-signal.ts tests/digest/session-signal.test.ts && git commit -m "feat(digest): add session-signal extractor (title, preview, insightScore from SIGNAL_CATEGORIES)"`

---

## Task 2: `EnrichedSessionForBatching` + pipeline upgrade

**Files:**
- Modify: `src/digest/types.ts`
- Modify: `src/digest/pipeline.ts`
- Modify: `tests/digest/pipeline.test.ts`

- [ ] **Step 2.1: Update `src/digest/types.ts`** — keep `SessionForBatching` unchanged; add:

```ts
import type { SessionSignals } from "./session-signal.js";

/**
 * SessionForBatching enriched with extracted signals for the threading
 * LLM prompt. Built by pipeline.buildBatchingInput; consumed by threading.
 * Batcher only reads SessionForBatching fields, so this is a strict superset.
 */
export interface EnrichedSessionForBatching extends SessionForBatching, SessionSignals {}
```

Add `worthWriting?: boolean` to `ThreadCandidate`:

```ts
export interface ThreadCandidate {
  threadId: string;
  sessionIds: string[];
  title: string;
  skip?: boolean;
  reason?: string;
  /** Set false by the LLM when this thread is judged trivial / not worth an
   *  article. Equivalent to skip:true; pipeline.recordSkippedThreadCandidates
   *  treats both as skip. Made explicit so threading prompt can require LLM
   *  to mention every session (no silent drops). */
  worthWriting?: boolean;
}
```

- [ ] **Step 2.2: Update `src/digest/pipeline.ts buildBatchingInput`** to return `EnrichedSessionForBatching[]`:

```ts
import { extractSessionSignals } from "./session-signal.js";
// ... existing imports

export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
  key: Buffer | null,
): EnrichedSessionForBatching[] {
  const out: EnrichedSessionForBatching[] = [];
  for (const e of entries) {
    const body = readSessionBody(repoRoot, e.relativePath, key, "pipeline.ts");
    const signals = extractSessionSignals(body);
    out.push({
      sessionId: e.sessionId,
      project: e.project,
      endedAt: e.endedAt,
      tokenEstimate: Math.ceil(body.length / 3.5),
      title: signals.title,
      preview: signals.preview,
      insightScore: signals.insightScore,
    });
  }
  return out;
}
```

- [ ] **Step 2.3: Update `tests/digest/pipeline.test.ts`** — existing `buildBatchingInput` tests assert tokenEstimate; new assertion that title / preview / insightScore are present. Add one test:

```ts
it("buildBatchingInput attaches signals from extractSessionSignals", () => {
  const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/x.md" });
  // body must include a ## User block so extractSessionSignals returns non-empty title
  writeSessionMd(e.relativePath, `# Disp\n\n## User\n\nfix bug, learn from architecture decision\n`);
  const got = buildBatchingInput([e], repoRoot, null);
  expect(got[0]!.title).toContain("fix bug");
  expect(got[0]!.preview).toBeTruthy();
  expect(got[0]!.insightScore).toBeGreaterThan(0);
});
```

- [ ] **Step 2.4: Update orchestrator/threading callers** — `orchestrator.ts` already passes the result of `buildBatchingInput` to `makeBatches` and then to `runThreading`. The batcher only reads `SessionForBatching` fields (sessionId, project, endedAt, tokenEstimate), so the enriched type flows through unchanged. `runThreading`'s parameter must change from `SessionForBatching[][]` to `EnrichedSessionForBatching[][]`. Update its signature:

```ts
// src/digest/threading.ts
export async function runThreading(
  runner: LlmRunner,
  batches: EnrichedSessionForBatching[][],
  // ... rest unchanged
```

(The actual prompt rendering using these new fields lives in Task 3.)

- [ ] **Step 2.5: `npm test`** → green; build clean.
- [ ] **Step 2.6: Commit**: `git add -u && git commit -m "feat(digest): pipeline + threading types carry session signals (title, preview, insightScore)"`

---

## Task 3: Rewrite `assets/prompts/thread.md` + use rich input in threading

**Files:**
- Modify: `assets/prompts/thread.md`
- Modify: `src/digest/threading.ts` (the `mapWithConcurrency` callback's sessionList JSON)

- [ ] **Step 3.1: Rewrite `assets/prompts/thread.md`**:

```
你是一个代码工程师的助手。要把一批零散的编码 session 分组成"一件事"（thread），并判断每个 thread 是否值得写成文章。

## 输入

SESSION_LIST 是一个 JSON 数组，每个元素：
- sessionId: 唯一 ID
- project: 项目名
- endedAt: ISO 时间戳
- title: 这个 session 的第一条用户消息（前 80 字）
- preview: 前 300 字的用户消息内容
- insightScore: 0-1 的算法打分（高 = 关键词命中多类，可能值得写）

## 任务

把 sessions 分组：同一个项目 + 话题相关 + 时间相邻的合并成一个 thread。

## 关键规则（必须遵守）

1. **每个输入的 sessionId 必须出现在输出的某个 thread 中**。即使是琐碎的、看起来没价值的 session，也必须分配到一个 thread。绝对不允许在输出中遗漏任何 session。
2. **worthWriting=false** 用来标记不值得写文章的 thread（纯闲聊、太短、低分数）。这样的 thread 仍然被记录，只是不生成文章。
3. **worthWriting=true** 是默认；除非明确判断不值得写，否则都置为 true。
4. **threadId** 是 slug：小写字母数字短横线；应描述这件事，如 "fix-copilot-scan"、"add-progress-output"。
5. **title** 是中文短标题，≤ 20 字。
6. 倾向于**保留**而不是丢弃：用户更怕错过工作记录，不怕文章里有几篇 trivial 的。

## 输出

纯 JSON，不要 markdown 代码块。Schema:

[
  {
    "threadId": "...",
    "title": "...",
    "sessionIds": ["..."],
    "worthWriting": true,
    "reason": "可选；当 worthWriting=false 时说明原因"
  }
]

## 输入数据

{{sessionList}}
```

- [ ] **Step 3.2: Update `runThreading` to render the new sessionList**

In `src/digest/threading.ts`, the `runner.run` call currently passes:

```ts
sessionList: JSON.stringify(batch.map((s) => ({
  sessionId: s.sessionId,
  project: s.project,
  endedAt: s.endedAt,
})))
```

Change to:

```ts
sessionList: JSON.stringify(batch.map((s) => ({
  sessionId: s.sessionId,
  project: s.project,
  endedAt: s.endedAt,
  title: s.title,
  preview: s.preview,
  insightScore: Number(s.insightScore.toFixed(2)),
})))
```

- [ ] **Step 3.3: `asThreadCandidates` validator (in same file) accepts optional worthWriting**

The existing validator already accepts unknown extra fields; just confirm it doesn't reject `worthWriting`. Add an explicit type-check:

```ts
function asThreadCandidates(data: unknown, batchIndex: number): ThreadCandidate[] {
  // ... existing checks
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as Record<string, unknown>;
    // ... existing required-fields checks
    if (c.worthWriting !== undefined && typeof c.worthWriting !== "boolean") {
      throw new Error(
        `threading batch ${batchIndex}: bad shape — element ${i} worthWriting must be boolean if present`,
      );
    }
  }
  return data as ThreadCandidate[];
}
```

- [ ] **Step 3.4: Update threading tests** — at minimum, the existing `runThreading` tests use `s(sessionId)` helper that produces `SessionForBatching`. Update the helper or tests to produce enriched shape:

```ts
function s(sessionId: string, opts: Partial<EnrichedSessionForBatching> = {}): EnrichedSessionForBatching {
  return {
    sessionId,
    project: "p",
    endedAt: "2026-04-01T00:00:00Z",
    tokenEstimate: 10,
    title: "",
    preview: "",
    insightScore: 0,
    ...opts,
  };
}
```

- [ ] **Step 3.5: `npm test`** → green; `npm run build` clean.
- [ ] **Step 3.6: Commit**: `git add -u && git commit -m "feat(digest): rewrite threading prompt with rich input + worthWriting; mention-every-session rule"`

---

## Task 4: Treat `worthWriting=false` as skip in `recordSkippedThreadCandidates`

**Files:**
- Modify: `src/digest/pipeline.ts` (`recordSkippedThreadCandidates`)
- Modify: `tests/digest/pipeline.test.ts`

- [ ] **Step 4.1: Update `recordSkippedThreadCandidates`** in `src/digest/pipeline.ts`:

```ts
export function recordSkippedThreadCandidates(
  bookIndex: BookIndex,
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
): string[] {
  const skipped: string[] = [];
  const nowIso = new Date().toISOString();
  const sessionLookup = sessionLookupBySid(indexFile);
  for (const c of candidates) {
    const isSkip = c.skip === true || c.worthWriting === false;
    if (!isSkip) continue;
    // ... rest of existing body unchanged (firstSid lookup, project, etc.)
    const reason = c.reason ?? (c.worthWriting === false ? "not worth writing" : "");
    const entry: BookEntry = {
      // ... existing fields
      skipReason: reason,
      // ...
    };
    upsertThread(bookIndex, entry);
    skipped.push(c.threadId);
  }
  return skipped;
}
```

Mirror the logic in `buildArticleInputs`: skip both `c.skip === true` and `c.worthWriting === false`.

- [ ] **Step 4.2: Tests** — add to `tests/digest/pipeline.test.ts`:

```ts
it("recordSkippedThreadCandidates treats worthWriting=false the same as skip:true", () => {
  const idx = makeIndex([ie({ sessionId: "sid-1", project: "p" })]);
  const book: BookIndex = { version: 1, threads: {}, chapters: {} };
  recordSkippedThreadCandidates(
    book,
    [{ threadId: "t", title: "trivial", sessionIds: ["sid-1"], worthWriting: false, reason: "too short" }],
    idx,
  );
  expect(book.threads["t"]!.skip).toBe(true);
  expect(book.threads["t"]!.skipReason).toBe("too short");
});

it("buildArticleInputs treats worthWriting=false the same as skip:true (excludes)", () => {
  const e = ie({ relativePath: "raw_sessions/c/p/x/y.md" });
  writeSessionMd(e.relativePath, "## User\n\nx");
  const idx = makeIndex([e]);
  const got = buildArticleInputs(
    [{ threadId: "t", title: "", sessionIds: ["sid-1"], worthWriting: false }],
    idx, repoRoot, null,
  );
  expect(got).toEqual([]);
});
```

Update `buildArticleInputs` to also short-circuit on `c.worthWriting === false`:

```ts
for (const c of candidates) {
  if (c.skip || c.worthWriting === false) continue;
  // ... rest unchanged
}
```

- [ ] **Step 4.3: `npm test`** → green.
- [ ] **Step 4.4: Commit**: `git add -u && git commit -m "feat(digest): treat worthWriting=false as skip in pipeline"`

---

## Task 5: Safety net — auto-recover dropped sessions in `runThreading`

**Files:**
- Modify: `src/digest/threading.ts`
- Modify: `tests/digest/threading.test.ts`

- [ ] **Step 5.1: After `mergeCandidates`, before returning, compute dropped set and force-bucket**

In `src/digest/threading.ts`, in `runThreading` after the existing `mergeCandidates(perBatchCandidates)` call but before constructing the final ThreadingResult:

```ts
// Compute which input sessionIds are NOT in any candidate output. These are
// LLM omissions — recover by force-creating one-session threads. This GUARANTEES
// no input session vanishes silently. (Sessions in failedBatches don't need
// recovery here — they will reappear in findNewSessionEntries on the next sync,
// per the soft-fail contract.)
const succeededBatchIndices = new Set(
  outcomes.map((o, i) => o.ok ? i : -1).filter((i) => i >= 0),
);
const inputSidsFromSucceededBatches = new Set<string>();
for (let i = 0; i < batches.length; i++) {
  if (!succeededBatchIndices.has(i)) continue;
  for (const s of batches[i]!) inputSidsFromSucceededBatches.add(s.sessionId);
}
const outputSids = new Set<string>();
for (const c of mergedCandidates) {
  for (const sid of c.sessionIds) outputSids.add(sid);
}
const dropped: EnrichedSessionForBatching[] = [];
for (let i = 0; i < batches.length; i++) {
  if (!succeededBatchIndices.has(i)) continue;
  for (const s of batches[i]!) {
    if (!outputSids.has(s.sessionId)) dropped.push(s);
  }
}
if (dropped.length > 0) {
  console.warn(`runThreading: LLM omitted ${dropped.length} session(s); auto-recovering as 1-session threads`);
}
const recoveredCandidates: ThreadCandidate[] = dropped.map((s) => ({
  threadId: synthThreadId(s),
  title: synthTitle(s),
  sessionIds: [s.sessionId],
  worthWriting: true,
}));
const finalCandidates = mergedCandidates.concat(recoveredCandidates);
```

(Replace `mergedCandidates` with `finalCandidates` in the return.)

Helpers (place at module bottom):

```ts
/** Build a synthetic threadId from session signals. Used only for recovered
 *  (LLM-omitted) sessions; the threadId must be a unique slug stable enough
 *  to survive cross-batch merging. We use the first 16 chars of sessionId
 *  + a kebab-case excerpt of the title so it reads OK in book/index.md. */
function synthThreadId(s: EnrichedSessionForBatching): string {
  const titleSlug = s.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const sidPart = s.sessionId.slice(0, 8);
  return titleSlug ? `${titleSlug}-${sidPart}` : `recovered-${sidPart}`;
}

function synthTitle(s: EnrichedSessionForBatching): string {
  const t = s.title.trim();
  return t ? t.slice(0, 20) : "（自动恢复）";
}
```

- [ ] **Step 5.2: Tests** — append to `tests/digest/threading.test.ts`:

```ts
it("auto-recovers sessions the LLM omitted from its output", async () => {
  const runner = fakeRunner([
    // LLM returns only 1 candidate covering only s1, dropping s2 and s3 silently.
    {
      ok: true,
      text: JSON.stringify([
        { threadId: "t1", title: "T1", sessionIds: ["s1"], worthWriting: true },
      ]),
      durationMs: 1,
    },
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const r = await runThreading(
      runner,
      [[s("s1", { title: "fix bug" }), s("s2", { title: "add feature" }), s("s3", { title: "" })]],
      4,
      1,
      // reporter
      (() => {
        const sr = require("../../src/digest/reporter.js");
        return sr.silentReporter();
      })(),
    );
    const allSids = new Set(r.candidates.flatMap((c) => c.sessionIds));
    expect(allSids).toEqual(new Set(["s1", "s2", "s3"])); // every input recovered
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-recovering"));
  } finally {
    warn.mockRestore();
  }
});

it("does NOT recover sessions from failed batches (those are retried next sync per soft-fail contract)", async () => {
  const runner = fakeRunner([
    { ok: false, error: "boom", durationMs: 1 }, // batch 0 fails completely
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const r = await runThreading(
      runner,
      [[s("s1"), s("s2")]],
      4,
      1, // maxAttempts=1 → instant soft-fail
      (() => { const sr = require("../../src/digest/reporter.js"); return sr.silentReporter(); })(),
    );
    expect(r.candidates).toEqual([]);
    expect(r.failedBatches).toHaveLength(1);
    // No "auto-recovering" warn — failed-batch sessions reappear next sync naturally.
    const recoveryCalls = warn.mock.calls.filter((c) => String(c[0]).includes("auto-recovering"));
    expect(recoveryCalls).toHaveLength(0);
  } finally {
    warn.mockRestore();
  }
});

it("synthesized threadId derives readable slug from session title", async () => {
  const runner = fakeRunner([
    { ok: true, text: JSON.stringify([]), durationMs: 1 }, // LLM drops everything
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const r = await runThreading(
      runner,
      [[s("session-uuid-12345", { title: "Fix Login Bug" })]],
      4, 1,
      (() => { const sr = require("../../src/digest/reporter.js"); return sr.silentReporter(); })(),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.threadId).toMatch(/fix-login-bug/);
    expect(r.candidates[0]!.threadId).toContain("session-"); // first 8 chars of sessionId
  } finally {
    warn.mockRestore();
  }
});
```

(Note: tests use `require` for silentReporter to avoid an import-cycle headache; if the project already top-imports it in this file, use that instead.)

- [ ] **Step 5.3: `npm test`** → green. Full suite expected at 199 + ~12 new = ~211. Build clean.
- [ ] **Step 5.4: Commit**: `git add -u && git commit -m "feat(digest): auto-recover sessions LLM omits from threading output (zero-loss guarantee)"`

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - User report: 77 → 10 sessions, 87% loss → addressed by Task 3 (rich prompt context) + Task 5 (safety net guarantees zero-loss).
  - User question: prompt 三段式? → NOT this plan; this plan is about not losing sessions, not about article structure. The 三段式 prompt redesign is a follow-up.

- **Placeholder scan:** every step has full code; one `require` workaround flagged inline.

- **Type consistency:**
  - `EnrichedSessionForBatching` extends `SessionForBatching` so batcher continues to work without changes.
  - `runThreading` signature widens to `EnrichedSessionForBatching[][]`. Tests update via the `s()` helper override.
  - `ThreadCandidate.worthWriting?: boolean` is additive; existing tests that don't set it are unaffected (treated as `true` by default).

- **Backward compat:**
  - Existing BookEntries unchanged. `worthWriting=false` flows into existing `skip:true` BookEntry shape; downstream `chapter.ts` / `toc.ts` already handle skip correctly.
  - The new prompt is more demanding but compatible: LLMs not following "mention every session" still produce valid JSON; the safety net catches their omissions.

- **Out of scope (deliberately):**
  - 三段式 article/chapter prompt redesign — separate plan
  - Adjusting article prompt for "产出 / 知识 / 踩坑" — separate plan
  - Re-running digest on existing repo — user does `memvc digest --reset` after merge
  - Improving `synthThreadId` collision handling beyond the 8-char sessionId suffix — extremely unlikely to collide; addressable later if needed
