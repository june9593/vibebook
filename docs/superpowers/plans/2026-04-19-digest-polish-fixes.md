# Digest Polish Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the digest commands after real-world usage exposed a UX bug (no progress output → looks frozen for 20-40 minutes), a leftover-files issue (`~/.claude/projects/<hash>/` accumulates), and four small code-quality MINORs from the previous review (digestCmd doesn't self-heal deviceBranch; cwd-wrap pattern duplicated; uniqueProjects helper duplicated; `isRealProjectPath` over-broad on bare `.json`).

**Architecture:**
- A small `Reporter` interface (one per digest run) replaces silent loops with per-batch / per-article / per-chapter `console.log` lines. Batch counts and timing are surfaced. The reporter is injectable so tests can capture without polluting test output.
- `withIsolatedCwd(runner, callback)` becomes the single source of truth for the mkdtemp + wrap + rmSync pattern. It also takes responsibility for cleaning the corresponding `~/.claude/projects/<hash>/` entry on exit (best-effort; never throws).
- `digestCmd` calls a new `readConfigWithMigration()` shared with `syncCmd` so all three entrypoints (sync / digest --redo / digest --reset) get the deviceBranch self-heal.
- One `uniqueProjectsFromReport(report)` helper replaces the two near-identical functions in `digest.ts`.
- `isRealProjectPath` drops the bare `.json` suffix check (covered already by `-workspace.json` check; bare `.json` was risking false positives).

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

**Spec reference:** No spec change. This is a polish sprint addressing user-reported issues from `memvc digest --reset` real-world usage on 2026-04-19, plus deferred MINORs from the previous code-quality review.

---

## File Structure

**New files:**
- `src/digest/reporter.ts` — `Reporter` interface + `consoleReporter` impl + `silentReporter` (for tests)
- `src/digest/with-isolated-cwd.ts` — `withIsolatedCwd(runner, callback)` helper

**Modified files:**
- `src/digest/orchestrator.ts` — accept `reporter`, emit per-phase lines; use `withIsolatedCwd` helper
- `src/digest/redo.ts` — same
- `src/digest/threading.ts` — accept `reporter`, emit per-batch completion lines
- `src/digest/article.ts` — accept `reporter`, emit per-article line
- `src/digest/chapter.ts` — accept `reporter`, emit per-chapter line
- `src/digest/project-filter.ts` — drop `.json` suffix check
- `src/commands/sync.ts` — pass `consoleReporter()` to runDigest
- `src/commands/digest.ts` — extract shared `readConfigWithMigration()`; pass reporter; replace duplicate uniqueProjects with single `uniqueProjectsFromReport`
- Tests for each modified file — assert reporter calls + new helper behavior

**Untouched:** every other source file.

---

## Task 1: Reporter abstraction + console impl

**Files:**
- Create: `src/digest/reporter.ts`
- Create: `tests/digest/reporter.test.ts`

### Step 1.1 — Reporter interface + impls

- [ ] **Create `src/digest/reporter.ts`**:

```ts
import chalk from "chalk";

/**
 * Tiny progress reporter passed into runDigest / runDigestRedo / runDigestReset.
 * Each method is called as the named phase makes observable progress, so the
 * user can see "the thing isn't frozen" during 20+ minute digest runs.
 *
 * Implementations MUST be cheap and synchronous — they're called from inside
 * tight loops in the orchestrator and downstream modules.
 */
export interface Reporter {
  /** Called once at the start of the threading phase with the batch count. */
  threadingStart(batchCount: number): void;
  /** Called when a single threading batch completes (success or soft-fail). */
  threadingBatchDone(batchIndex: number, batchCount: number, durationMs: number, ok: boolean): void;
  /** Called once at the start of the article phase with the count to process. */
  articleStart(threadCount: number): void;
  /** Called when a single article completes (ok / skipped / failed). */
  articleDone(threadId: string, status: "ok" | "skipped" | "failed", durationMs: number): void;
  /** Called once at the start of the chapter phase with the count of projects. */
  chapterStart(projectCount: number): void;
  /** Called when a single chapter rewrite completes. */
  chapterDone(project: string, status: "ok" | "no-articles" | "failed", durationMs: number): void;
  /** Called once at the start of the toc phase. */
  tocStart(): void;
  /** Called when toc completes with the count of files written. */
  tocDone(filesWritten: number): void;
}

/**
 * Default reporter: prints `chalk.gray(...)` lines to stdout, terse but
 * informative. Used by every CLI entrypoint (sync, digest --redo, digest --reset).
 */
export function consoleReporter(): Reporter {
  return {
    threadingStart(n) {
      console.log(chalk.gray(`  threading: ${n} batch(es) to process...`));
    },
    threadingBatchDone(i, n, ms, ok) {
      const tag = ok ? chalk.gray("ok") : chalk.yellow("FAILED");
      console.log(chalk.gray(`  threading: batch ${i + 1}/${n} ${tag} (${ms}ms)`));
    },
    articleStart(n) {
      console.log(chalk.gray(`  articles: ${n} thread(s) to write...`));
    },
    articleDone(threadId, status, ms) {
      const tag =
        status === "ok" ? chalk.gray("ok")
        : status === "skipped" ? chalk.gray("skip")
        : chalk.yellow("FAILED");
      console.log(chalk.gray(`  article ${threadId}: ${tag} (${ms}ms)`));
    },
    chapterStart(n) {
      console.log(chalk.gray(`  chapters: ${n} project(s) eligible...`));
    },
    chapterDone(project, status, ms) {
      const tag =
        status === "ok" ? chalk.gray("ok")
        : status === "no-articles" ? chalk.gray("(none)")
        : chalk.yellow("FAILED");
      console.log(chalk.gray(`  chapter ${project}: ${tag} (${ms}ms)`));
    },
    tocStart() {
      console.log(chalk.gray(`  toc: writing...`));
    },
    tocDone(n) {
      console.log(chalk.gray(`  toc: ${n} file(s) written`));
    },
  };
}

/**
 * No-op reporter for tests that don't care about progress lines.
 * Use silentReporter() rather than passing consoleReporter() in tests
 * to avoid polluting test output.
 */
export function silentReporter(): Reporter {
  return {
    threadingStart() {},
    threadingBatchDone() {},
    articleStart() {},
    articleDone() {},
    chapterStart() {},
    chapterDone() {},
    tocStart() {},
    tocDone() {},
  };
}
```

### Step 1.2 — Tests

- [ ] **Create `tests/digest/reporter.test.ts`**:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consoleReporter, silentReporter } from "../../src/digest/reporter.js";

describe("consoleReporter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { logSpy.mockRestore(); });

  it("threadingStart prints batch count", () => {
    consoleReporter().threadingStart(57);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("57"));
  });

  it("threadingBatchDone shows index, total, ok status, and duration", () => {
    consoleReporter().threadingBatchDone(0, 5, 1234, true);
    const arg = logSpy.mock.calls[0]![0] as string;
    expect(arg).toContain("1/5"); // 1-based index
    expect(arg).toContain("1234");
  });

  it("threadingBatchDone shows FAILED for ok=false", () => {
    consoleReporter().threadingBatchDone(2, 3, 100, false);
    const arg = logSpy.mock.calls[0]![0] as string;
    expect(arg).toContain("FAILED");
  });

  it("articleDone differentiates ok / skipped / failed", () => {
    const r = consoleReporter();
    r.articleDone("t1", "ok", 100);
    r.articleDone("t2", "skipped", 100);
    r.articleDone("t3", "failed", 100);
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("ok");
    expect(calls[1]).toContain("skip");
    expect(calls[2]).toContain("FAILED");
  });

  it("chapterDone handles no-articles", () => {
    consoleReporter().chapterDone("p", "no-articles", 5);
    expect(logSpy.mock.calls[0]![0] as string).toContain("(none)");
  });

  it("tocDone shows file count", () => {
    consoleReporter().tocDone(42);
    expect(logSpy.mock.calls[0]![0] as string).toContain("42");
  });
});

describe("silentReporter", () => {
  it("never logs", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const r = silentReporter();
      r.threadingStart(1);
      r.threadingBatchDone(0, 1, 1, true);
      r.articleStart(1);
      r.articleDone("t", "ok", 1);
      r.chapterStart(1);
      r.chapterDone("p", "ok", 1);
      r.tocStart();
      r.tocDone(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
```

### Step 1.3 — Run + commit

- [ ] **Run `npm test -- reporter`** — all 8 tests green.
- [ ] **Run `npm test`** — full suite green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/reporter.ts tests/digest/reporter.test.ts
git commit -m "feat(digest): add Reporter interface (console + silent impls) for progress output"
```

---

## Task 2: Wire Reporter through threading / article / chapter / orchestrator / redo

**Files:**
- Modify: `src/digest/threading.ts`
- Modify: `src/digest/article.ts`
- Modify: `src/digest/chapter.ts`
- Modify: `src/digest/orchestrator.ts`
- Modify: `src/digest/redo.ts`
- Modify: every test file that calls these functions (pass `silentReporter()` to avoid noisy output)

### Step 2.1 — `runThreading` accepts reporter, emits batch-done lines

- [ ] **Edit `src/digest/threading.ts`**: add `reporter: Reporter` as a parameter to `runThreading` (place it AFTER `maxAttempts` so the existing call site needs only a small addition). Inside `processBatch`, capture start time, then in the for-loop body after each attempt's outcome, emit `reporter.threadingBatchDone(batchIndex, batches.length, Date.now() - started, ok)` ONCE per batch (not per attempt). Add `reporter.threadingStart(batches.length)` at the top of `runThreading`.

```ts
import type { Reporter } from "./reporter.js";

export async function runThreading(
  runner: LlmRunner,
  batches: SessionForBatching[][],
  concurrency = DEFAULT_THREADING_CONCURRENCY,
  maxAttempts = DEFAULT_THREADING_MAX_ATTEMPTS,
  reporter: Reporter,
): Promise<ThreadingResult> {
  reporter.threadingStart(batches.length);
  const outcomes = await mapWithConcurrency(batches, concurrency, async (batch, i) => {
    const started = Date.now();
    const outcome = await processBatch(runner, batch, i, maxAttempts);
    reporter.threadingBatchDone(i, batches.length, Date.now() - started, outcome.ok);
    return outcome;
  });
  // ... rest of existing function unchanged
```

### Step 2.2 — `generateArticle` accepts reporter

- [ ] **Edit `src/digest/article.ts`**: add `reporter: Reporter` as the LAST parameter of `generateArticle`. At the top of the function capture `started = Date.now()`. At every return point (status: ok / skipped / failed), call `reporter.articleDone(input.threadId, status, Date.now() - started)`.

(The `articleStart(n)` is called by the orchestrator, not here, since article.ts only handles one thread.)

### Step 2.3 — `generateChapter` accepts reporter

- [ ] **Edit `src/digest/chapter.ts`**: same pattern — add `reporter: Reporter` last param; capture `started`; at every return (`ok` / `no-articles` / `failed`), call `reporter.chapterDone(project, res.status, Date.now() - started)`. (The chapterStart line comes from orchestrator.)

### Step 2.4 — `generateToc` does NOT take a reporter

- [ ] **Note:** generateToc doesn't loop; it's one synchronous call. Orchestrator calls `reporter.tocStart()` before invocation and `reporter.tocDone(written.length)` after. Don't modify toc.ts itself.

### Step 2.5 — `runDigest` and `runDigestRedo` accept reporter, drive the per-phase calls

- [ ] **Edit `src/digest/orchestrator.ts`**:

(a) Add `reporter: Reporter` as a NEW LAST parameter (8th) to `runDigest` (and the inner `runDigestImpl`).

(b) After the threading phase: `reporter.articleStart(allArticleInputs.length)` before the article loop.

(c) Inside the article loop, change `await generateArticle(runner, repoRoot, input, bookIndex)` → `await generateArticle(runner, repoRoot, input, bookIndex, reporter)`.

(d) Before the chapter loop: `reporter.chapterStart(touchedProjects.size)` (or wherever the eligibility set is computed; pass the count of projects we'll iterate, not the count we'll write — the chapterDone calls will tell the user which were no-articles).

(e) Inside the chapter loop, change `await generateChapter(runner, repoRoot, project, bookIndex)` → `await generateChapter(runner, repoRoot, project, bookIndex, reporter)`.

(f) Around generateToc: `reporter.tocStart(); ... reporter.tocDone(tocResult.written.length);`.

(g) The threading call: `await runThreading(runner, batches, concurrency, maxAttempts, reporter)`.

(h) Same treatment for `runDigestRedo` in `redo.ts`: gain `reporter: Reporter` last param. Reorder phases: `reporter.articleStart(failedThreads.length)` before the retry loop; pass reporter to `generateArticle`. Then `reporter.chapterStart(projects.length)` before the chapter loop. Then `reporter.tocStart() / tocDone()`.

### Step 2.6 — Update sync.ts and digest.ts entrypoints

- [ ] **Edit `src/commands/sync.ts`**: at the call site for `runDigest`, add a final argument `consoleReporter()`. Add `import { consoleReporter } from "../digest/reporter.js";`.

- [ ] **Edit `src/commands/digest.ts`**: at every call site for `runDigest` (inside `runDigestResetFromRepo`) and `runDigestRedo` (inside `runDigestRedoFromRepo`), add `consoleReporter()` as the final argument. Add the import.

### Step 2.7 — Update existing tests to pass `silentReporter()`

- [ ] **Search and update**:

```bash
grep -rn "runThreading\|generateArticle\|generateChapter\|runDigest\b\|runDigestRedo\b" tests/
```

For every call site in tests, append `silentReporter()` as the new last argument. Most tests will need:

```ts
import { silentReporter } from "../../src/digest/reporter.js";
// then add silentReporter() to each call
```

### Step 2.8 — Run + commit

- [ ] **Run `npm test`** — full suite green. Test count unchanged from Task 1 baseline (no new tests in this task; just rewiring).
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add -u
git commit -m "feat(digest): emit per-phase progress lines from runDigest/runDigestRedo via Reporter"
```

---

## Task 3: `withIsolatedCwd` helper + clean Claude session files

**Files:**
- Create: `src/digest/with-isolated-cwd.ts`
- Create: `tests/digest/with-isolated-cwd.test.ts`
- Modify: `src/digest/orchestrator.ts` — replace inline mkdtemp+wrap+rm with helper
- Modify: `src/digest/redo.ts` — same

### Step 3.1 — Helper

- [ ] **Create `src/digest/with-isolated-cwd.ts`**:

```ts
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner } from "./runner.js";

/**
 * Run `callback` with an LlmRunner that injects a per-digest-run isolated cwd
 * into every spawn. Cleans up both:
 *   - the tmp cwd dir itself (always)
 *   - the Claude CLI's `~/.claude/projects/<hash>/` directory it created
 *     (best-effort; only when the user has the Claude CLI installed and it
 *     stamped session files there)
 *
 * The hash Claude uses for the projects directory is deterministic from the
 * cwd path: SHA-1 of the path, hex-encoded. We mirror that here so we can
 * find and delete the right directory.
 */
export async function withIsolatedCwd<T>(
  runner: LlmRunner,
  callback: (wrappedRunner: LlmRunner) => Promise<T>,
): Promise<T> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), "memvc-claude-"));
  const wrappedRunner: LlmRunner = {
    run: (prompt, vars, opts = {}) => runner.run(prompt, vars, { ...opts, cwd: isolatedCwd }),
  };
  try {
    return await callback(wrappedRunner);
  } finally {
    // Best-effort cleanup #1: the tmp cwd dir.
    try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* swallow */ }
    // Best-effort cleanup #2: Claude CLI session files at ~/.claude/projects/<hash>/.
    const claudeProjectsDir = join(homedir(), ".claude", "projects", claudeProjectHash(isolatedCwd));
    if (existsSync(claudeProjectsDir)) {
      try { rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }
}

/**
 * Mirrors Claude CLI's directory-naming scheme for ~/.claude/projects/<X>/.
 *
 * From observation, Claude CLI uses the absolute cwd path with `/` replaced
 * by `-` (so `/var/folders/.../T/memvc-claude-AbCdEf` becomes
 * `-var-folders-...-T-memvc-claude-AbCdEf`). If this turns out to be wrong on
 * a future Claude CLI version, the cleanup just no-ops (existsSync returns
 * false), which is the safe failure mode.
 *
 * NOTE: if Claude switches to a hash-based naming, update this function.
 */
function claudeProjectHash(absPath: string): string {
  return absPath.split("/").join("-");
}

// Exported for tests.
export { claudeProjectHash as _claudeProjectHashForTests };
```

### Step 3.2 — Tests

- [ ] **Create `tests/digest/with-isolated-cwd.test.ts`**:

```ts
import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import type { LlmRunner } from "../../src/digest/runner.js";
import { withIsolatedCwd, _claudeProjectHashForTests } from "../../src/digest/with-isolated-cwd.js";

describe("withIsolatedCwd", () => {
  it("wraps runner so .run is called with cwd injected", async () => {
    let captured: string | undefined;
    const runner: LlmRunner = {
      run: async (_p, _v, opts) => {
        captured = opts?.cwd;
        return { ok: true, text: "hi", durationMs: 1 };
      },
    };
    await withIsolatedCwd(runner, async (wrapped) => {
      await wrapped.run("p", {}, { outputFormat: "text" });
    });
    expect(captured).toMatch(/memvc-claude-/);
  });

  it("cleans up the tmp cwd after callback resolves", async () => {
    let cwdSeen = "";
    await withIsolatedCwd(
      { run: async (_p, _v, opts) => { cwdSeen = opts?.cwd ?? ""; return { ok: true, text: "", durationMs: 1 }; } },
      async (w) => { await w.run("p", {}); },
    );
    expect(existsSync(cwdSeen)).toBe(false);
  });

  it("cleans up even when callback throws", async () => {
    let cwdSeen = "";
    await expect(withIsolatedCwd(
      { run: async (_p, _v, opts) => { cwdSeen = opts?.cwd ?? ""; return { ok: true, text: "", durationMs: 1 }; } },
      async (w) => { await w.run("p", {}); throw new Error("boom"); },
    )).rejects.toThrow(/boom/);
    expect(existsSync(cwdSeen)).toBe(false);
  });

  it("preserves opts the runner already had (overlays cwd, doesn't replace)", async () => {
    let captured: any;
    const runner: LlmRunner = {
      run: async (_p, _v, opts) => { captured = opts; return { ok: true, text: "", durationMs: 1 }; },
    };
    await withIsolatedCwd(runner, async (w) => {
      await w.run("p", {}, { outputFormat: "json", timeoutMs: 5000 });
    });
    expect(captured.outputFormat).toBe("json");
    expect(captured.timeoutMs).toBe(5000);
    expect(captured.cwd).toMatch(/memvc-claude-/);
  });

  it("claudeProjectHash mirrors slash-replacement scheme", () => {
    expect(_claudeProjectHashForTests("/var/folders/x/T/memvc-claude-Ab")).toBe(
      "-var-folders-x-T-memvc-claude-Ab",
    );
  });
});
```

### Step 3.3 — Use helper in orchestrator and redo

- [ ] **Edit `src/digest/orchestrator.ts`**: replace the inline `mkdtempSync` + manual wrap + `try/finally rmSync` block (the body of the public `runDigest`) with:

```ts
import { withIsolatedCwd } from "./with-isolated-cwd.js";

export async function runDigest(/* same signature */): Promise<DigestReport> {
  // pruning step (Task 3 from the previous sprint) stays here, BEFORE wrapping
  // ... existing prune logic ...
  return withIsolatedCwd(runner, (wrappedRunner) =>
    runDigestImpl(wrappedRunner, repoRoot, indexFile, bookIndex, key, concurrency, maxAttempts, reporter),
  );
}
```

- [ ] **Edit `src/digest/redo.ts`**: same — wrap `runDigestRedoImpl` invocation in `withIsolatedCwd`.

### Step 3.4 — Run + commit

- [ ] **Run `npm test`** — full suite green; +5 from the new helper tests.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/with-isolated-cwd.ts tests/digest/with-isolated-cwd.test.ts src/digest/orchestrator.ts src/digest/redo.ts
git commit -m "refactor(digest): extract withIsolatedCwd helper; clean ~/.claude/projects/<hash> on exit"
```

---

## Task 4: digestCmd self-heal deviceBranch (shared with sync)

**Files:**
- Modify: `src/commands/sync.ts` — add `readConfigWithMigration()` exported helper
- Modify: `src/commands/digest.ts` — call `readConfigWithMigration()` instead of `readConfig`
- Modify: `tests/commands/sync.test.ts` — test the helper handles legacy config

### Step 4.1 — Hoist self-heal into a shared helper

- [ ] **Edit `src/commands/sync.ts`**: refactor the existing `ensureDeviceBranchOnConfig` flow into `readConfigWithMigration()`:

```ts
import { readConfig, writeConfig, type Config } from "../config.js";

/**
 * Loads ~/.memvc/config.json and applies any in-place migrations needed by
 * current code (currently: deviceBranch self-heal). On migration, writes the
 * fixed config back to disk. Used by both syncCmd and digestCmd.
 */
export function readConfigWithMigration(): Config {
  const cfg = readConfig();
  const heal = ensureDeviceBranchOnConfig(cfg);
  if (heal.migrated) {
    console.log(chalk.cyan(
      `Migrating: setting deviceBranch to "${heal.cfg.deviceBranch}" (saved to ~/.memvc/config.json)`,
    ));
    writeConfig(heal.cfg);
  }
  return heal.cfg;
}
```

(b) Update `syncCmd` to use it instead of inline `readConfig` + `ensureDeviceBranchOnConfig`.

### Step 4.2 — `digestCmd` uses the shared loader

- [ ] **Edit `src/commands/digest.ts`**: change `const cfg = readConfig();` (in both `digestCmd`'s redo branch AND in `runDigestResetCmd`) to `const cfg = readConfigWithMigration();`. Add the import: `import { readConfigWithMigration } from "./sync.js";`.

### Step 4.3 — Test

- [ ] **In `tests/commands/sync.test.ts`**, add a test for the new function:

```ts
import { readConfigWithMigration } from "../../src/commands/sync.js";
// ... in the same describe block as ensureDeviceBranchOnConfig tests:

it("readConfigWithMigration writes back the migrated config when deviceBranch was empty", () => {
  // Arrange: mock readConfig and writeConfig
  const cfg = { /* ... required fields ..., */ deviceBranch: "" } as Config;
  const writes: Config[] = [];
  vi.spyOn(/* import config as namespace */, "readConfig").mockReturnValue(cfg);
  vi.spyOn(/* import config as namespace */, "writeConfig").mockImplementation((c) => { writes.push(c); });
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  const result = readConfigWithMigration();
  expect(result.deviceBranch.length).toBeGreaterThan(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.deviceBranch).toBe(result.deviceBranch);

  vi.restoreAllMocks();
});
```

(Adjust the spyOn setup to match how config.ts is currently exported. If `vi.spyOn` on namespace import is awkward, simpler: refactor `readConfigWithMigration` to take `loaders = { readConfig, writeConfig }` as a default-injected dependency. For pragma: use whichever pattern the codebase already employs.)

### Step 4.4 — Run + commit

- [ ] **Run `npm test`** — green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/commands/sync.ts src/commands/digest.ts tests/commands/sync.test.ts
git commit -m "refactor(commands): hoist deviceBranch self-heal into readConfigWithMigration; digestCmd uses it"
```

---

## Task 5: `uniqueProjectsFromReport` helper + tighten `isRealProjectPath`

**Files:**
- Modify: `src/commands/digest.ts` — extract single `uniqueProjectsFromReport`
- Modify: `src/digest/project-filter.ts` — drop bare `.json` suffix
- Modify: `tests/digest/project-filter.test.ts` — adjust test that asserted `.json` rejection

### Step 5.1 — Single uniqueProjects helper

- [ ] **Edit `src/commands/digest.ts`**: replace the two near-identical helpers (`uniqueProjects` for redo and the equivalent for reset) with one:

```ts
/**
 * Collect unique project names that the digest run touched. Pulls from
 * chaptersRewritten + parses project from book/<project>/timeline.md paths
 * in tocFilesWritten.
 *
 * Works on both DigestReport and RedoReport because both have these fields
 * (we accept the structural intersection rather than the union).
 */
export function uniqueProjectsFromReport(
  report: { chaptersRewritten: string[]; tocFilesWritten: string[] },
): string[] {
  const out = new Set<string>(report.chaptersRewritten);
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}
```

Update both call sites (in `digestCmd`'s redo branch and `runDigestResetCmd`'s commit-paths construction) to call `uniqueProjectsFromReport(report)`.

Delete the old `uniqueProjects` and `uniqueDigestProjects` (or whichever they were named).

### Step 5.2 — Drop `.json` suffix from `isRealProjectPath`

- [ ] **Edit `src/digest/project-filter.ts`**: remove the line `if (lower.endsWith(".json") || lower.endsWith("-workspace.json")) return false;`. Replace with just the workspace.json variant:

```ts
if (lower.endsWith("-workspace.json") || lower.endsWith(".code-workspace")) return false;
```

(Keep `.code-workspace`; just drop the bare `.json`.)

### Step 5.3 — Test adjustment

- [ ] **Edit `tests/digest/project-filter.test.ts`**: ensure the test that asserts `1747378825021-workspace.json` rejection still passes (it should, via the more-specific suffix). If there's a separate test asserting bare `.json` (e.g. `foo.json`), either remove it or invert it to assert acceptance.

### Step 5.4 — Run + commit

- [ ] **Run `npm test`** — green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/commands/digest.ts src/digest/project-filter.ts tests/digest/project-filter.test.ts
git commit -m "refactor(digest): one uniqueProjectsFromReport helper; tighten isRealProjectPath"
```

---

## Task 6: Manual smoke (no commit)

- [ ] **Step 6.1**:

```bash
cd /Users/yueliu/edge/memvc
npm run build
export MEMVC_PASSPHRASE='your-passphrase'
memvc digest --reset
```

Expected output:

```
memvc digest --reset: wiping book/ and .memvc/index.book.json under /Users/yueliu/memvc-repo
  wiped. Now running fresh digest...
  threading: 57 batch(es) to process...
  threading: batch 1/57 ok (12345ms)
  threading: batch 2/57 ok (8932ms)
  ...
  articles: 134 thread(s) to write...
  article t-abc12345: ok (3210ms)
  ...
  chapters: 23 project(s) eligible...
  chapter edge-memvc: ok (4521ms)
  ...
  toc: writing...
  toc: 47 file(s) written
--reset complete: +123 articles, 11 skip, 0 failed; 23 chapters
```

After the run:

```bash
ls /tmp/memvc-claude-* 2>/dev/null
ls ~/.claude/projects/ | grep memvc-claude
```

Both should be empty (cleanup worked).

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - User report: "no progress, looks frozen" → Reporter (Tasks 1+2).
  - User question: "still creates Claude sessions?" → cleanup added in Task 3's `withIsolatedCwd`.
  - Previous review MINORs: hoist deviceBranch (Task 4), DRY uniqueProjects (Task 5), tighten filter (Task 5), DRY cwd-wrap (Task 3 helper).

- **Placeholder scan:** every code step has full code; one Step 4.3 test note ("adjust spyOn pattern") may need quick judgment from the implementer based on existing test style — defensible because the `vi.spyOn(namespace)` pattern has subtleties that depend on import shape.

- **Type consistency:**
  - `Reporter` interface added once, referenced everywhere by import.
  - `runDigest`, `runDigestRedo`, `runThreading`, `generateArticle`, `generateChapter` all gain `reporter: Reporter` as a NEW LAST param. Existing tests must update — captured in Step 2.7.
  - `withIsolatedCwd` signature: `(runner, callback) => Promise<T>` matches the existing inline pattern.
  - `readConfigWithMigration()` returns `Config` — same shape, no schema change.
  - `uniqueProjectsFromReport` accepts a structural type, works for both report shapes.

- **Backward compatibility:**
  - All Reporter additions are backward incompatible at the API level (new required param). Tests must be updated. There's no programmatic third-party caller (memvc is a CLI), so internal-only break is acceptable.
  - Optional alternative: make reporter `reporter: Reporter = silentReporter()` default to avoid mass test edits. **Decision: required param**, because hiding it as optional risks tests passing without exercising the new path; better to force every call site to acknowledge.

- **Cleanup safety:**
  - `withIsolatedCwd` `rmSync(claudeProjectsDir)` is best-effort; swallowing errors is correct because the dir might not exist (Claude CLI not installed) or might already be cleaned.
  - The hash-naming assumption can break if Claude CLI changes its scheme; documented inline.

- **Out of scope (deliberately):**
  - Spinner / animated progress. Plain log lines per event are enough; spinners get garbled when interleaved with other output.
  - Per-thread / per-chapter timing histograms.
  - SIGINT-safe tmpdir cleanup (acceptable per previous review).
  - Renaming `runDigestResetCmd` (currently private; private duplication is fine).
