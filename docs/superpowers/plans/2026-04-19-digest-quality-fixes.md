# Digest Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four digest-quality issues surfaced by 2026-04-19 audit of the user's `memvc-repo` after a real `memvc sync` produced 30 articles from ~450 raw sessions: (1) Claude Code subagent jsonls in `~/.claude/projects/<proj>/<sessionId>/subagents/` get scanned and pollute raw_sessions with "You are implementing Task X" titled entries (169 such files across 26 dirs); (2) threading produces mega-threads (350 edge-memvc sessions → 1 thread → 1 article) so most content is lost in over-aggregation; (3) article failures show only as `FAILED` in CLI with no diagnostic; (4) article prompt is "踩坑/学到的东西" focused, so when a thread is "real work without obvious pitfall," LLM SKIPs it.

**Architecture:**
- **Task 1** (subagent filter): `ClaudeCodeAdapter.discover()` walks subdirectories of `~/.claude/projects/<proj>/`. Skip any directory named `subagents` at any depth. Mechanical clean-up of existing 169 files documented as a manual one-shot user step.
- **Task 2** (cap thread size): Threading prompt adds hard rule "single thread should contain ≤ 5 sessions; prefer many smaller threads to one mega-thread." Backed by post-merge enforcement: any candidate from the LLM with > 5 sessionIds gets split into ceil(N/5) candidates with suffixes `-part1`, `-part2`, etc.
- **Task 3** (surface failure): `DigestReport.articlesFailed` becomes `articleFailures: { threadId: string; error: string }[]` so `runSync`/`digestCmd` summary lines can show why each one failed. Backward-compat: keep `articlesFailed: number` as a derived count.
- **Task 4** (3-section prompt): Rewrite `assets/prompts/article.md` so LLM produces three sections per article (## 主要产出 / ## 知识积累 / ## 踩过的坑), each with "(无)" if empty. SKIP only when ALL THREE sections would be empty — much higher bar.

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

**Spec reference:** Real-world audit results 2026-04-19; user feedback on edge-src producing only 2 articles for a year of work; user feedback on subagent jsonl pollution; user prior request for 三段式 chapter (now applied to article instead per scope discussion).

---

## Scope

4 tasks, 4 commits. Each independently committable.

- **Task 1**: ClaudeCodeAdapter skips `subagents/` subdirs at any depth
- **Task 2**: Threading prompt + code enforces ≤ 5 sessions per thread
- **Task 3**: Surface per-article failure reasons in DigestReport + CLI
- **Task 4**: Rewrite article.md to mandatory 3-section structure

---

## File Structure

**Modified:**
- `src/sources/claude-code.ts` — skip `subagents/` subdirs in walk
- `src/digest/threading.ts` — post-merge split candidates with > 5 sessionIds
- `assets/prompts/thread.md` — add "≤ 5 sessions per thread" guideline
- `src/digest/orchestrator.ts` — `DigestReport.articleFailures` + populate from generateArticle results
- `src/commands/sync.ts` — summary log shows failure reasons
- `src/commands/digest.ts` — same for redo + reset summary
- `assets/prompts/article.md` — full rewrite to 3-section structure
- Tests: `tests/sources/claude-code.test.ts`, `tests/digest/threading.test.ts`, `tests/digest/orchestrator.test.ts`

**Untouched:** chapter.ts, toc.ts, redo.ts (mostly — only inherits orchestrator changes), pipeline.ts, with-isolated-cwd.ts.

---

## Task 1: ClaudeCodeAdapter skips `subagents/` subdirs

**Files:**
- Modify: `src/sources/claude-code.ts`
- Modify: `tests/sources/claude-code.test.ts`

### Step 1.1 — Add subagents skip in walk

In `src/sources/claude-code.ts`, the existing walk loop pushes any `e.isDirectory()` entry onto the stack (with the existing top-level `isMemvcOrTmpProjectDir` filter). Add a check at any depth: skip subdirs named `subagents`.

Locate the walk:

```ts
if (e.isDirectory()) {
  if (dir === this.root && isMemvcOrTmpProjectDir(e.name)) continue;
  stack.push(p);
}
```

Change to:

```ts
if (e.isDirectory()) {
  if (dir === this.root && isMemvcOrTmpProjectDir(e.name)) continue;
  // Skip Claude Code's own subagent transcript dirs at any depth.
  // These appear as ~/.claude/projects/<proj>/<sessionId>/subagents/agent-*.jsonl
  // and contain agentic prompt boilerplate ("You are implementing Task X")
  // that pollutes raw_sessions with bogus session titles. They are NOT user
  // sessions; they are sub-task transcripts spawned by an outer session.
  if (e.name === "subagents") continue;
  stack.push(p);
}
```

### Step 1.2 — Test

Add to `tests/sources/claude-code.test.ts` inside the existing pollution-filter `describe`:

```ts
it("skips subagents/ subdirs at any depth", async () => {
  const proj = join(claudeRoot, "-Users-yueliu-real-project");
  mkdirSync(proj, { recursive: true });
  // A real top-level session.
  writeFileSync(join(proj, "real.jsonl"), '{"sessionId":"real","cwd":"/Users/yueliu/real-project"}\n');
  // A subagents/ subdir nested inside an outer session's dir.
  const outerSession = join(proj, "outer-session-id");
  mkdirSync(join(outerSession, "subagents"), { recursive: true });
  writeFileSync(
    join(outerSession, "subagents", "agent-foo.jsonl"),
    '{"sessionId":"agent-foo","cwd":"/Users/yueliu/real-project"}\n',
  );
  // A nested subagents/ deeper still (defensive).
  mkdirSync(join(outerSession, "subagents", "nested-stuff"), { recursive: true });
  writeFileSync(
    join(outerSession, "subagents", "nested-stuff", "agent-bar.jsonl"),
    '{"sessionId":"agent-bar","cwd":"/Users/yueliu/real-project"}\n',
  );

  const adapter = new ClaudeCodeAdapter(claudeRoot);
  const sourcePaths: string[] = [];
  for await (const ds of adapter.discover()) {
    sourcePaths.push(ds.sourcePath);
  }
  expect(sourcePaths.some((p) => p.endsWith("real.jsonl"))).toBe(true);
  expect(sourcePaths.some((p) => p.includes("/subagents/"))).toBe(false);
  expect(sourcePaths.some((p) => p.endsWith("agent-foo.jsonl"))).toBe(false);
  expect(sourcePaths.some((p) => p.endsWith("agent-bar.jsonl"))).toBe(false);
});
```

### Step 1.3 — Run + commit

- [ ] `npm test -- claude-code` — green; +1 new test.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "fix(sources): ClaudeCodeAdapter skips subagents/ subdirs at any depth (prevents Claude Code subagent transcript pollution)"`

### Step 1.4 — Manual one-shot cleanup (user-facing note)

After this code change ships, the user runs (one-time):

```bash
find ~/.claude/projects -path "*/subagents" -type d -exec rm -rf {} + 2>/dev/null
```

Document this in the commit message body or PR description so the user knows. Don't bake the cleanup into the code (one-shot mechanical, no need for a flag).

---

## Task 2: Cap thread size at 5 sessions (prompt + post-merge split)

**Files:**
- Modify: `assets/prompts/thread.md` (add new rule)
- Modify: `src/digest/threading.ts` (post-merge split)
- Modify: `tests/digest/threading.test.ts`

### Step 2.1 — Prompt: add ≤5-sessions guideline

In `assets/prompts/thread.md`, after the existing rule 6 ("倾向于保留..."), add:

```
7. **每个 thread 最多包含 5 个 session**。如果某个 topic 涉及 > 5 个 session（如 350 个 edge-memvc session 的混合工作），分成多个 thread（命名加 `-1`, `-2` 等数字后缀；如 `fix-claude-cli-1`、`fix-claude-cli-2`）。这样每篇文章聚焦更具体的工作，避免被概括成"日常工作总结"而被 SKIP。
```

### Step 2.2 — Code: post-merge split

In `src/digest/threading.ts`, after `mergeCandidates(perBatchCandidates)` and BEFORE the recovery section, add a split step:

```ts
const mergedCandidates = mergeCandidates(perBatchCandidates);

// Post-merge: cap any candidate's sessionIds at MAX_SESSIONS_PER_THREAD by
// splitting into multiple candidates with -1, -2, ... suffixes. Even if the
// LLM ignored the prompt's ≤ 5 rule, this enforces it deterministically.
const MAX_SESSIONS_PER_THREAD = 5;
const splitCandidates: ThreadCandidate[] = [];
for (const c of mergedCandidates) {
  if (c.sessionIds.length <= MAX_SESSIONS_PER_THREAD) {
    splitCandidates.push(c);
    continue;
  }
  const chunks: string[][] = [];
  for (let i = 0; i < c.sessionIds.length; i += MAX_SESSIONS_PER_THREAD) {
    chunks.push(c.sessionIds.slice(i, i + MAX_SESSIONS_PER_THREAD));
  }
  for (let i = 0; i < chunks.length; i++) {
    splitCandidates.push({
      ...c,
      threadId: `${c.threadId}-${i + 1}`,
      sessionIds: chunks[i]!,
    });
  }
}
```

Then continue with the existing dropped-session recovery + return logic, but use `splitCandidates` (instead of `mergedCandidates`) as the basis for `outputSids` and the final return:

```ts
const outputSids = new Set<string>();
for (const c of splitCandidates) {
  for (const sid of c.sessionIds) outputSids.add(sid);
}
// ... rest of dropped-session recovery unchanged ...
const finalCandidates = splitCandidates.concat(recoveredCandidates);
```

### Step 2.3 — Tests

Add to `tests/digest/threading.test.ts`:

```ts
describe("runThreading — cap thread size at 5 sessions", () => {
  it("splits a candidate with 12 sessions into 3 threads of 5+5+2", async () => {
    const sids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([
        { threadId: "mega", title: "M", sessionIds: sids, project: "p" },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(
      runner,
      [sids.map((sid) => s(sid))],
      4, 1,
      silentReporter(),
    );
    const mega = r.candidates.filter((c) => c.threadId.startsWith("mega"));
    expect(mega.map((c) => c.threadId).sort()).toEqual(["mega-1", "mega-2", "mega-3"]);
    expect(mega.find((c) => c.threadId === "mega-1")!.sessionIds).toHaveLength(5);
    expect(mega.find((c) => c.threadId === "mega-2")!.sessionIds).toHaveLength(5);
    expect(mega.find((c) => c.threadId === "mega-3")!.sessionIds).toHaveLength(2);
    // All 12 sessions present, none lost.
    const allSids = new Set(mega.flatMap((c) => c.sessionIds));
    expect(allSids).toEqual(new Set(sids));
  });

  it("does NOT split candidates with ≤5 sessions", async () => {
    const sids = ["a", "b", "c"];
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([
        { threadId: "small", title: "s", sessionIds: sids, project: "p" },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(
      runner,
      [sids.map((sid) => s(sid))],
      4, 1,
      silentReporter(),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.threadId).toBe("small");
    expect(r.candidates[0]!.sessionIds).toEqual(sids);
  });

  it("preserves project + title + worthWriting on each split", async () => {
    const sids = Array.from({ length: 7 }, (_, i) => `s${i}`);
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([
        { threadId: "feat", title: "功能", sessionIds: sids, project: "proj-a", worthWriting: true },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(
      runner,
      [sids.map((sid) => s(sid, { project: "proj-a" }))],
      4, 1,
      silentReporter(),
    );
    const feats = r.candidates.filter((c) => c.threadId.startsWith("feat"));
    expect(feats).toHaveLength(2);
    for (const c of feats) {
      expect(c.title).toBe("功能");
      expect(c.project).toBe("proj-a");
      expect(c.worthWriting).toBe(true);
    }
  });
});
```

### Step 2.4 — Run + commit

- [ ] `npm test -- threading` — green; +3 new tests.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(digest): enforce ≤5 sessions per thread (prompt + post-merge split with -N suffix)"`

---

## Task 3: Surface per-article failure reasons in DigestReport + CLI

**Files:**
- Modify: `src/digest/orchestrator.ts` (DigestReport + populate)
- Modify: `src/digest/redo.ts` (RedoReport same shape)
- Modify: `src/commands/sync.ts` (summary log)
- Modify: `src/commands/digest.ts` (summary log for redo + reset)
- Modify: `tests/digest/orchestrator.test.ts`

### Step 3.1 — Update DigestReport shape

In `src/digest/orchestrator.ts`, replace:

```ts
articlesFailed: number;
```

with:

```ts
/** Per-thread failure reasons. articlesFailed is derived from this. */
articleFailures: { threadId: string; error: string }[];
```

Then derive `articlesFailed` as a getter or compute at use site. To keep the change small and additive, KEEP `articlesFailed: number` and ADD `articleFailures`:

```ts
articlesFailed: number;
/** Per-thread failure reasons (parallel to articlesFailed). */
articleFailures: { threadId: string; error: string }[];
```

In the article phase loop, when `res.status === "failed"`, populate the failure entry:

```ts
for (const input of allArticleInputs) {
  const res = await generateArticle(runner, repoRoot, input, bookIndex, reporter);
  if (res.status === "ok") report.articlesOk++;
  else if (res.status === "skipped") report.articlesSkipped++;
  else {
    report.articlesFailed++;
    report.articleFailures.push({ threadId: input.threadId, error: res.error });
  }
}
```

Initialize `articleFailures: []` in the report constructor.

### Step 3.2 — Same for RedoReport

In `src/digest/redo.ts`, add `articleFailures: { threadId: string; error: string }[]` to `RedoReport`. In Phase 1 (the retry loop), when `generateArticle` returns failed, populate it:

```ts
if (res.status === "ok") {
  report.threadsRecovered++;
} else if (res.status === "skipped") {
  report.threadsNewlySkipped++;
} else {
  report.threadsStillFailed++;
  report.articleFailures.push({ threadId: be.threadId, error: res.error });
}
```

### Step 3.3 — sync.ts summary log shows failures

In `src/commands/sync.ts`, find the `digest:` summary log line. Currently:

```ts
console.log(chalk.gray(
  `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]${failedBatchSuffix}`,
));
```

Add right AFTER it (when failures > 0):

```ts
if (digestReport.articleFailures.length > 0) {
  for (const f of digestReport.articleFailures) {
    console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.slice(0, 200)}`));
  }
}
```

### Step 3.4 — digest.ts (redo + reset) same

In `src/commands/digest.ts`'s redo summary log block (where it prints `--redo: N recovered / M still failed / ...`), add a similar per-failure loop right after, using `report.articleFailures`. Same for the `--reset` path which calls `runDigest` (so its `report` is a `DigestReport`, same field name).

### Step 3.5 — Tests

In `tests/digest/orchestrator.test.ts`, find the existing article-failure test and assert the new field:

```ts
// In the test that has at least one failed article:
expect(r.articleFailures).toHaveLength(1);
expect(r.articleFailures[0]).toMatchObject({
  threadId: expect.stringMatching(/t-bad/),
  error: expect.any(String),
});
```

Add at least one new explicit test if none exists, exercising 1 ok + 1 failed and asserting both `articlesFailed === 1` and `articleFailures` has the right entry with the right error message.

### Step 3.6 — Run + commit

- [ ] `npm test` — green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(digest): surface per-article failure reasons in report + sync/digest CLI summary"`

---

## Task 4: Rewrite `article.md` to mandatory 3-section structure

**Files:**
- Modify: `assets/prompts/article.md`
- (No code change required; the prompt is loaded via `loadPromptAsset`. Tests for `generateArticle` mock the runner, so they don't depend on prompt text.)
- Optional: bump `ARTICLE_VERSION` in `src/digest/article.ts` so existing articles regenerate next sync.

### Step 4.1 — Replace `assets/prompts/article.md`

Full new content:

```
你要把下面若干个 session 合成一篇工程博客风格的文章。这是用户的工作 memory，用来回看「我做了什么、学到了什么、踩过什么坑」。

## 输出结构（强制三段式）

每篇文章 **必须** 包含以下三个二级小节，按顺序，不要漏。每节内容来源于 sessions：

1. **`## 主要产出`** —— 这次工作做出了什么具体东西？写了什么代码、文档、PR、决策？修复了什么？发布了什么？产出的东西要具体（提及函数名、文件路径、commit 关键词、PR 链接）。如果实在没有可见产出，写一行 "（无显著产出）"。
2. **`## 知识积累`** —— 学到了什么？理解了哪个 system / API / 概念更深？记录了什么知识点（即使是"原来这么用"的小发现）。如果完全没有学习内容，写一行 "（无）"。
3. **`## 踩过的坑`** —— 遇到了什么 bug / 误解 / 错误尝试？是怎么发现是错的？怎么绕开的？如果完全顺利，写一行 "（无）"。

每节下面用具体小点（- ...）展开，每点 1-3 句话；不需要长篇大论。

## 其他要求

- 文章顶部用 `# <标题>` —— 标题 ≤ 20 字，描述本次工作主题；
- 文章末尾用 `## 附：原始对话` 列出涉及的 session 短 id（如 `(s1ab)`）+ 中文一句话摘要，不要列原始路径；
- 用中文写作；
- 代码片段和命令行**保留原文**（用 ```...``` 包），不要改写；
- 避免逐字引用对话；提炼成叙事；
- **SKIP 阈值很高**：只有当三个小节都会写出 "（无）" / "（无显著产出）"（即 sessions 真的什么都没发生，纯粹是空对话）才返回单行 `SKIP: <原因>`。其他情况一律产出文章 —— 哪怕产出/学习/坑里有两个是「（无）」也要写。

## 输入

THREAD_TITLE: {{title}}

SESSIONS（由旧到新）：

{{sessionsMd}}
```

### Step 4.2 — Bump ARTICLE_VERSION (optional but recommended)

In `src/digest/article.ts`, change `export const ARTICLE_VERSION = 1;` to `export const ARTICLE_VERSION = 2;`. This forces existing OK articles to be regenerated on next sync via the orchestrator's stale-version path, so the user gets the new 3-section format without `--reset`.

### Step 4.3 — Run + commit

- [ ] `npm test` — green (no test changes; the prompt is loaded but tests mock the runner output).
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(prompt): rewrite article.md to mandatory 3-section structure (产出/知识/坑); bump ARTICLE_VERSION"`

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - User report 1 (subagent pollution) → Task 1
  - User report 4a (mega-thread) → Task 2
  - User report 4b (failure visibility) → Task 3
  - User prior request for 3-section + applied to article (not chapter) per scope discussion → Task 4

- **Placeholder scan:** every step has full code; no TBD.

- **Type consistency:**
  - `DigestReport.articleFailures: { threadId: string; error: string }[]` shape used in both orchestrator.ts and redo.ts (both add the field).
  - `articlesFailed: number` retained for backward compat with existing tests; new tests assert both fields.
  - `MAX_SESSIONS_PER_THREAD = 5` is a single inline const; if user later wants tuning, expose via Config (out of scope).

- **Backward compat:**
  - Task 1: pure filter add, no semantic change for users without subagent transcripts.
  - Task 2: a candidate getting split from `feat-bug` → `feat-bug-1`, `feat-bug-2`. Existing BookEntries with the un-split threadId WILL be re-split on next sync (their sessionIds will produce the same chunks). Acceptable churn.
  - Task 3: additive field; existing `articlesFailed` count unchanged.
  - Task 4: bumping ARTICLE_VERSION causes existing articles to regenerate (which is what the user wants — they're complaining the existing articles are bad).

- **Out of scope (deliberately):**
  - Cleanup of the 169 existing subagent-pollution files in raw_sessions: subagents/ files were never written there in the first place (they live in `~/.claude/projects/<proj>/<sid>/subagents/` and the adapter scanned them). The fix prevents future scans; the old `raw_sessions/.../你*` files were already cleaned in the previous session.
  - Cleanup of the 169 jsonl files under `~/.claude/projects/.../subagents/` themselves — they're Claude Code's data, not memvc's; let user decide.
  - Worktree filtering (#3 from user feedback): user was undecided; deferred to a future plan if confirmed.
  - Configurable MAX_SESSIONS_PER_THREAD: 5 is a sensible default; revisit if user reports it.
  - Chapter prompt 3-section: user explicitly chose to apply 3-section to article, not chapter, after audit feedback.
