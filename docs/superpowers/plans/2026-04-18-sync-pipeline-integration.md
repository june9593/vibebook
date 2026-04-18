# Sprint 2.8.3 — Sync Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Sprint 2.8.2 `runDigest` orchestrator into `commands/sync.ts` so that `memvc sync` runs phases 1-2 (extract + raw push) followed by phases 3-7 (digest) followed by phase 8 (book push), gated behind the existing config and a new `--no-digest` flag for the "old behavior" escape hatch. Add an integration test that runs `runSync` end-to-end against a fixture repo with a fake runner. Update the roadmap to mark Sprint 2.8 done.

**Architecture:**
- `runSync` gains an optional `noDigest: boolean` field. When `true`, `runSync` returns after the existing extract+commit+push (today's behavior). When `false` (default), `runSync` calls `runDigest` after the raw push, persists the updated `BookIndex`, and stages the updated `book/**` and `.memvc/index.book.json` paths under the same device branch with a separate commit + push.
- The runner is constructed once via `createRunner(cfg)`. If `cfg.encrypt` is true, `runDigest` is NOT called — the digest pipeline does not yet support encrypted raw sessions, and `pipeline.ts` already throws on `.enc` paths. We surface this as a clean warning rather than a crash.
- Failure isolation in sync.ts mirrors the spec: if `runDigest` throws (i.e. threading phase failed), we log a warning, do NOT push the book commit, and return a `SyncResult` that flags `digestStatus: "failed"`. The raw push from phase 2 is preserved.
- A second commit-and-push happens only when the digest produced changes (any tracked file under `book/` or `.memvc/index.book.json` differs from HEAD).
- CLI gets a `--no-digest` flag forwarded to `runSync.noDigest`.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest, commander. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md` "Pipeline" (phases 1, 2, 3-7, 8) and CLI section "memvc sync --no-digest 只跑 extract".

---

## Where 2.8.3 sits

- **2.8.1 (shipped):** `pipeline.ts` planning.
- **2.8.2 (shipped):** `orchestrator.ts` `runDigest`.
- **2.8.3 (this plan):** wire `runDigest` into `commands/sync.ts`, add `--no-digest` flag, integration test, roadmap update.

This plan covers two tasks:
1. Wire + flag + integration test (one commit).
2. Roadmap update (one commit).

---

## File Structure

**New files:** none.

**Modified files:**
- `src/commands/sync.ts` — `SyncOptions.noDigest`, `SyncResult.digestStatus`/`digestReport`, conditional digest invocation + second commit.
- `src/cli.ts` — `--no-digest` flag, plumb through.
- `tests/commands/sync.test.ts` — add a new describe block for digest integration with a fake runner.
- `docs/superpowers/roadmap.md` — mark 2.8 done.

**Untouched:** every digest module, every other command.

---

## Task 1: Wire runDigest into sync.ts + integration test

**Files:**
- Modify: `src/commands/sync.ts` (full rewrite shown below)
- Modify: `src/cli.ts` (add `--no-digest` option)
- Modify: `tests/commands/sync.test.ts` (add new describe block)

### Step 1 — Replace `src/commands/sync.ts` with this content

- [ ] **Step 1.1: Write the new `src/commands/sync.ts`**

```ts
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import chalk from "chalk";
import { ClaudeCodeAdapter } from "../sources/claude-code.js";
import { VSCodeCopilotAdapter } from "../sources/vscode-copilot.js";
import type { SourceAdapter } from "../sources/base.js";
import { loadIndex, saveIndex, hasUnchanged, upsertEntry } from "../index-store.js";
import type { IndexEntry } from "../types.js";
import { writeSession } from "../writer.js";
import { deriveKey, encrypt } from "../crypto.js";
import { readConfig, getPassphrase, type Config } from "../config.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
import { migrateLegacyMainToDevice } from "../migrate.js";
import { loadBookIndex, saveBookIndex } from "../digest/book-index.js";
import { createRunner } from "../digest/runner.js";
import { runDigest, type DigestReport } from "../digest/orchestrator.js";

export interface SyncOptions {
  repoPath: string;
  claudeRoot?: string;
  vscodeRoot?: string;
  encrypt: boolean;
  passphrase?: string;
  saltB64?: string;
  push?: boolean;
  repoUrl?: string;
  deviceBranch?: string;
  /** When true, skip phases 3-7 (digest). Default false. */
  noDigest?: boolean;
  /** Runner config — required when noDigest is false and encrypt is false. */
  runnerConfig?: Pick<Config, "runner" | "runnerModel">;
}

export type DigestStatus = "ok" | "skipped-encrypted" | "skipped-flag" | "failed" | "not-attempted";

export interface SyncResult {
  newCount: number;
  skippedCount: number;
  pathsWritten: string[];
  committed: boolean;
  pushed: boolean;
  digestStatus: DigestStatus;
  digestError?: string;
  digestReport?: DigestReport;
  /** True iff a second commit (book branch update) was created. */
  digestCommitted: boolean;
  /** True iff the book commit was pushed (only meaningful when digestCommitted is true). */
  digestPushed: boolean;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const adapters: SourceAdapter[] = [
    new ClaudeCodeAdapter(opts.claudeRoot),
    new VSCodeCopilotAdapter(opts.vscodeRoot),
  ];

  const idx = loadIndex(opts.repoPath);
  const key = opts.encrypt
    ? deriveKey(opts.passphrase!, Buffer.from(opts.saltB64!, "base64"))
    : null;

  let newCount = 0, skippedCount = 0;
  const pathsWritten: string[] = [];

  for (const adapter of adapters) {
    for await (const d of adapter.discover()) {
      let s;
      try {
        s = await d.load();
      } catch (err) {
        console.log(chalk.yellow(`! skip ${d.sourcePath}: ${(err as Error).message}`));
        continue;
      }
      if (hasUnchanged(idx, s.tool, s.sessionId, d.sourceMtimeMs, d.sourceSha256)) {
        skippedCount++;
        continue;
      }
      const rel = writeSession(opts.repoPath, s);

      if (key) {
        const rawAbs = join(opts.repoPath, rel.raw);
        const mdAbs = join(opts.repoPath, rel.md);
        const rawEnc = encrypt(readFileSync(rawAbs), key);
        const mdEnc = encrypt(readFileSync(mdAbs), key);
        writeFileSync(rawAbs + ".enc", rawEnc);
        writeFileSync(mdAbs + ".enc", mdEnc);
        unlinkSync(rawAbs);
        unlinkSync(mdAbs);
        pathsWritten.push(rel.raw + ".enc", rel.md + ".enc");
      } else {
        pathsWritten.push(rel.raw, rel.md);
      }

      const entry: IndexEntry = {
        sessionId: s.sessionId,
        shortId: s.shortId,
        tool: s.tool,
        project: s.project,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        nameSlug: s.nameSlug,
        displayName: s.displayName,
        relativePath: key ? rel.raw + ".enc" : rel.raw,
        sourcePath: s.sourcePath,
        sourceMtimeMs: d.sourceMtimeMs,
        sourceSha256: d.sourceSha256,
      };
      upsertEntry(idx, entry);
      newCount++;
      console.log(chalk.green(`+ ${s.tool}/${s.project}/${s.nameSlug} (${s.shortId})`));
    }
  }

  saveIndex(opts.repoPath, idx);
  const indexPath = ".memvc/index.json";

  let committed = false, pushed = false;
  if (opts.push && opts.repoUrl && opts.deviceBranch) {
    console.log(chalk.gray(`\nOpening repo at ${opts.repoPath}...`));
    const git = await ensureRepo(opts.repoPath, opts.repoUrl);
    const mig = await migrateLegacyMainToDevice(opts.repoPath, opts.deviceBranch);
    if (mig.migrated) {
      console.log(chalk.cyan(`Migrated legacy 'main' branch to '${opts.deviceBranch}'. 'main' is now unborn locally.`));
    }
    try { await git.fetch(); } catch { /* remote may be empty / offline */ }
    console.log(chalk.gray(`Ensuring branch '${opts.deviceBranch}' is checked out...`));
    await ensureDeviceBranch(git, opts.deviceBranch);
    const all = [...pathsWritten, indexPath];
    console.log(chalk.gray(`Staging ${all.length} paths and committing...`));
    const r = await commitAndPush(
      git,
      `memvc sync: +${newCount} sessions`,
      all,
      opts.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    committed = r.committed; pushed = r.pushed;
    if (committed && !pushed) console.log(chalk.yellow("Commit done, push failed or skipped."));
  }

  // -------------------- Phases 3-7 (digest) + phase 8 (book push) --------------------
  let digestStatus: DigestStatus = "not-attempted";
  let digestError: string | undefined;
  let digestReport: DigestReport | undefined;
  let digestCommitted = false, digestPushed = false;

  if (opts.noDigest) {
    digestStatus = "skipped-flag";
  } else if (opts.encrypt) {
    digestStatus = "skipped-encrypted";
    console.log(chalk.yellow(
      "Digest pipeline skipped: encrypted raw is not yet supported (book/ unchanged).",
    ));
  } else if (!opts.runnerConfig) {
    digestStatus = "skipped-flag";
  } else {
    console.log(chalk.gray("\nRunning digest pipeline (phases 3-7)..."));
    const bookIndex = loadBookIndex(opts.repoPath);
    const runner = createRunner(opts.runnerConfig);
    try {
      digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex);
      saveBookIndex(opts.repoPath, bookIndex);
      digestStatus = "ok";
      console.log(chalk.gray(
        `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]`,
      ));
    } catch (e) {
      digestStatus = "failed";
      digestError = e instanceof Error ? e.message : String(e);
      console.log(chalk.yellow(`! digest failed: ${digestError}`));
    }

    // -------------------- Phase 8 (book push) --------------------
    if (digestStatus === "ok" && opts.push && opts.repoUrl && opts.deviceBranch && digestReport) {
      const git = await ensureRepo(opts.repoPath, opts.repoUrl);
      // We're already on opts.deviceBranch from the raw commit above. Stage all
      // book paths the digest touched + the BookIndex, and commit if dirty.
      const bookPaths = collectDigestPaths(digestReport, opts.repoPath);
      if (bookPaths.length > 0) {
        const r = await commitAndPush(
          git,
          `memvc digest: +${digestReport.articlesOk} articles, ${digestReport.chaptersRewritten.length} chapters`,
          bookPaths,
          opts.deviceBranch,
          (stage) => console.log(chalk.gray(`  ${stage}`)),
        );
        digestCommitted = r.committed;
        digestPushed = r.pushed;
        if (digestCommitted && !digestPushed) {
          console.log(chalk.yellow("Digest commit done, push failed or skipped."));
        }
      }
    }
  }

  return {
    newCount, skippedCount, pathsWritten,
    committed, pushed,
    digestStatus, digestError, digestReport,
    digestCommitted, digestPushed,
  };
}

/**
 * Collect repo-rooted paths the digest produced or might have produced:
 *   - .memvc/index.book.json
 *   - every entry in digestReport.tocFilesWritten
 *   - book/<project>/articles/* for articles touched (we glob the project dirs)
 *   - book/<project>/chapter.md for each rewritten chapter
 *
 * commitAndPush handles missing files gracefully (git add of a non-existent
 * path is a no-op when the path was previously committed; otherwise git just
 * stages what's there). We avoid a recursive walk to keep this fast.
 */
function collectDigestPaths(report: DigestReport, repoRoot: string): string[] {
  const out = new Set<string>();
  out.add(".memvc/index.book.json");
  for (const p of report.tocFilesWritten) out.add(p);
  for (const project of report.chaptersRewritten) out.add(`book/${project}/chapter.md`);
  // Articles: rather than enumerate per-thread, stage the whole articles dir
  // for any project we touched. git add accepts directory paths and stages
  // every file under them.
  const projectsTouched = new Set<string>();
  for (const project of report.chaptersRewritten) projectsTouched.add(project);
  // tocFilesWritten includes book/<project>/timeline.md for non-empty projects;
  // pull project names from those.
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1]) projectsTouched.add(m[1]);
  }
  for (const project of projectsTouched) {
    const dir = `book/${project}/articles`;
    if (existsSync(join(repoRoot, dir))) out.add(dir);
  }
  return [...out];
}

export async function syncCmd(opts: { noDigest?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const passphrase = cfg.encrypt ? getPassphrase() : undefined;
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
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed (raw)." : "Committed raw (push failed)."));
  if (r.digestStatus === "ok") {
    console.log(chalk.cyan(
      r.digestCommitted
        ? (r.digestPushed ? "Pushed (book)." : "Committed book (push failed).")
        : "Digest produced no changes to commit.",
    ));
  } else if (r.digestStatus === "failed") {
    console.log(chalk.yellow(`Digest failed: ${r.digestError}`));
  } else if (r.digestStatus === "skipped-encrypted") {
    console.log(chalk.yellow("Digest skipped (encrypted mode)."));
  } else if (r.digestStatus === "skipped-flag") {
    console.log(chalk.gray("Digest skipped (--no-digest)."));
  }
}
```

- [ ] **Step 1.2: Update `src/cli.ts` — add `--no-digest` flag**

Replace the `sync` command block in `src/cli.ts` (lines 16-22) with:

```ts
  program
    .command("sync")
    .description("Extract, commit, push raw sessions; then run digest pipeline (phases 3-7) and push book branch")
    .option("--no-digest", "skip digest pipeline (only runs extract + raw push)")
    .action(async (opts: { digest?: boolean }) => {
      const { syncCmd } = await import("./commands/sync.js");
      // commander's --no-X sets opts.X = false when the flag is present, true otherwise.
      await syncCmd({ noDigest: opts.digest === false });
    });
```

(Note: commander's `--no-X` convention populates `opts.X` as a boolean. When the user types `memvc sync --no-digest`, `opts.digest === false`. When omitted, `opts.digest === undefined` (treated as `true` semantically — i.e. "do digest").)

- [ ] **Step 1.3: Add new describe block to `tests/commands/sync.test.ts`**

Append the following AFTER the existing `describe("runSync", ...)` block (do not modify the existing tests):

```ts
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { loadBookIndex } from "../../src/digest/book-index.js";

// Reuse the same fixture setup style as the existing block.
describe("runSync — digest integration", () => {
  let repo: string;
  let claudeRoot: string;
  let vscodeRoot: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-repo-"));
    claudeRoot = mkdtempSync(join(tmpdir(), "memvc-claude-"));
    const proj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
    vscodeRoot = mkdtempSync(join(tmpdir(), "memvc-vscode-"));
  });

  it("with noDigest=true: no book/ files written, no .memvc/index.book.json", async () => {
    const r = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false, noDigest: true,
    });
    expect(r.newCount).toBe(1);
    expect(r.digestStatus).toBe("skipped-flag");
    expect(existsSync(join(repo, "book"))).toBe(false);
    expect(existsSync(join(repo, ".memvc/index.book.json"))).toBe(false);
  });

  it("with noDigest=false but no runnerConfig: digest is skipped (no crash)", async () => {
    const r = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
    });
    // No runnerConfig provided → digest skipped silently (treated like --no-digest).
    expect(r.digestStatus).toBe("skipped-flag");
    expect(existsSync(join(repo, "book"))).toBe(false);
  });

  it("with noDigest=false + fake runner: writes book/ files and saves BookIndex", async () => {
    // Patch createRunner via vi.mock-like trick: instead of mocking, we use
    // the SyncOptions.runnerConfig to drive createRunner — but createRunner
    // returns one of the real backends. To test end-to-end without the
    // claude CLI, we monkey-patch createRunner via a module-level swap.
    //
    // Simpler approach: use a small intercepted runner module via a test-only
    // env var. But we don't have such an env hook today. Cleanest: inject a
    // pre-built runner via SyncOptions.runnerConfig is not possible (it's a
    // Config slice, not a runner). So we'll dynamically import the runner
    // module and replace createRunner with vi.spyOn for this test.

    // Stage canned LLM responses for: 1 thread, 1 article, 1 chapter.
    const canned: RunResult[] = [
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-int", title: "集成", sessionIds: [extractedSessionId(repo, claudeRoot)] },
      ])},
      { ok: true, durationMs: 1, text: "# 集成\n\n文章。" },
      { ok: true, durationMs: 1, text: "# edge-memvc\n\n章。" },
    ];
    const queue = [...canned];
    const fakeRunner: LlmRunner = {
      async run(_prompt, _vars) {
        const next = queue.shift();
        if (!next) throw new Error("fake runner exhausted");
        return next;
      },
    };

    // Spy on createRunner to return our fake.
    const runnerMod = await import("../../src/digest/runner.js");
    const spy = vi.spyOn(runnerMod, "createRunner").mockReturnValue(fakeRunner);

    try {
      const r = await runSync({
        repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
        runnerConfig: { runner: "claude-cli", runnerModel: "" },
      });
      expect(r.digestStatus).toBe("ok");
      expect(r.digestReport!.articlesOk).toBe(1);
      expect(r.digestReport!.chaptersRewritten).toEqual(["edge-memvc"]);
      expect(existsSync(join(repo, "book/index.md"))).toBe(true);
      expect(existsSync(join(repo, "book/edge-memvc/chapter.md"))).toBe(true);
      expect(existsSync(join(repo, ".memvc/index.book.json"))).toBe(true);
      const book = loadBookIndex(repo);
      expect(book.threads["t-int"]!.articleStatus).toBe("ok");
      expect(book.chapters["edge-memvc"]).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("with encrypt=true: digest is skipped with status skipped-encrypted", async () => {
    const r = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot,
      encrypt: true,
      passphrase: "test-pass",
      saltB64: Buffer.from("0123456789abcdef").toString("base64"),
      runnerConfig: { runner: "claude-cli", runnerModel: "" },
    });
    expect(r.digestStatus).toBe("skipped-encrypted");
    expect(existsSync(join(repo, "book"))).toBe(false);
  });

  it("with noDigest=false + fake runner returning failed thread: digestStatus=failed, no book commit", async () => {
    const queue: RunResult[] = [
      { ok: false, durationMs: 1, error: "thread runner exploded" },
    ];
    const fakeRunner: LlmRunner = {
      async run() {
        const n = queue.shift();
        if (!n) throw new Error("exhausted");
        return n;
      },
    };
    const runnerMod = await import("../../src/digest/runner.js");
    const spy = vi.spyOn(runnerMod, "createRunner").mockReturnValue(fakeRunner);
    try {
      const r = await runSync({
        repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
        runnerConfig: { runner: "claude-cli", runnerModel: "" },
      });
      expect(r.digestStatus).toBe("failed");
      expect(r.digestError).toMatch(/thread/);
      expect(existsSync(join(repo, "book"))).toBe(false);
      expect(r.digestCommitted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Helper: read the IndexFile that runSync just wrote and pull the single
 * sessionId out, so the canned threading reply can reference it. Called
 * AFTER runSync writes to repo, but our test injects the runner BEFORE
 * the digest phase reads — so we read the *expected* sessionId from the
 * fixture before calling runSync. Trick: the fixture's session uuid is
 * stable; we hard-code it.
 *
 * Reading the existing fixture: tests/fixtures/claude-session.jsonl contains
 * a single session with a deterministic uuid. We could parse it, but for a
 * test fixture we trust the value; assert it stays stable as a side check.
 */
function extractedSessionId(_repo: string, _claudeRoot: string): string {
  // The fixture's sessionId is the uuid embedded in the .jsonl. Parse it once.
  const fixture = readFileSync(join(fixturesDir, "claude-session.jsonl"), "utf8");
  const firstLine = fixture.split("\n", 1)[0]!;
  const obj = JSON.parse(firstLine) as { sessionId?: string };
  if (!obj.sessionId) {
    throw new Error("fixture has no sessionId on its first line — adjust extractedSessionId helper");
  }
  return obj.sessionId;
}
```

You will also need these new imports at the TOP of `tests/commands/sync.test.ts`:

```ts
import { vi } from "vitest";
import { Buffer } from "node:buffer";
```

And the existing `import { describe, it, expect, beforeEach } from "vitest";` becomes `import { describe, it, expect, beforeEach, vi } from "vitest";`. The `Buffer` import is for the encrypt-test salt.

- [ ] **Step 2: Run new tests to verify they fail (the source isn't compiled yet)**

Run: `npm test -- tests/commands/sync.test.ts`
Expected: FAIL on the new tests (compile error if `SyncOptions.noDigest` doesn't exist yet).

(If you implemented Step 1.1 first, this step is a sanity check that the code compiled and the tests at minimum start running.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — was 144, now 149 (5 new sync integration tests).

If the third test ("with fake runner") fails because the fixture's first JSONL line doesn't have `sessionId`, look at `tests/fixtures/claude-session.jsonl` and adjust `extractedSessionId`. Common Claude session JSONL formats put sessionId on the meta header line OR not at all (the adapter derives it from the filename). If the latter, hard-code the sessionId your `runSync` test produces — read `idx.entries` after a no-digest run (or use the `claudeRoot` fixture filename `abc12345.jsonl` → most adapters produce a UUID-like sessionId; consult `src/sources/claude-code.ts`).

- [ ] **Step 4: Run build to confirm**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts src/cli.ts tests/commands/sync.test.ts
git commit -m "feat(sync): integrate digest pipeline (phases 3-7 + book push); add --no-digest flag; integration test"
```

---

## Task 2: Roadmap update

**Files:**
- Modify: `docs/superpowers/roadmap.md`

- [ ] **Step 1: Mark Sprint 2.8 done**

In `docs/superpowers/roadmap.md` (around the "Current Baseline" section), add a new line under the existing 2.5/2.6/2.7 ✅ entries:

```diff
 - ✅ **Sprint 2.7**：TOC 机械生成（front page + 全局 timeline + 每章 timeline，markdown 转义）
+- ✅ **Sprint 2.8**：sync 接入 digest pipeline（runDigest orchestrator；--no-digest flag；book 分支二次 commit）
```

In the same file, find `- **2.8 sync 接入 pipeline**` line in the Sprint 2 detail section and append ` ✓`:

```diff
-- **2.8 sync 接入 pipeline**
+- **2.8 sync 接入 pipeline** ✓
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/roadmap.md
git commit -m "docs(roadmap): mark Sprint 2.8 done"
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - "memvc sync = extract + thread + article + chapter + toc + push 两个分支" → `runSync` runs phase 1 (extract) → 2 (raw push) → 3-7 (`runDigest`) → 8 (book push, second commit on same device branch).
  - "memvc sync --no-digest 只跑 extract" → `--no-digest` flag plumbed through CLI; `noDigest:true` short-circuits before digest.
  - "阶段 4 失败 → 中止 4-7, 保留阶段 1-2 的 push, 下次 sync 重试" → `runDigest` throws → caught here → `digestStatus="failed"` + raw push preserved + book commit NOT issued.
  - Failure isolation: matches spec at every layer (article failure isolated by `generateArticle`, chapter failure isolated by `generateChapter`, threading failure aborts 4-7 but not 1-2).

- **Encrypted-mode behavior:** Documented and tested (`skipped-encrypted` status). The pipeline modules already throw on `.enc` paths, so this gate is the safe thing.

- **Spec gap acknowledged:** The spec mentions a SEPARATE `<device>` book branch and `<device>-raw` raw branch (Sprint 3 scope). For Sprint 2.8 we punt: both raw and book commits go on the SAME device branch, with two separate commits per `sync`. Sprint 3 will introduce the dual-worktree split.

- **Placeholder scan:** every code step has full code; no TBD; no "similar to above" except the existing test block which is unmodified by reference.

- **Type consistency:**
  - `LlmRunner`, `RunResult`, `createRunner`, `Config` slice — all match their source modules.
  - `loadBookIndex`, `saveBookIndex` — match `src/digest/book-index.ts` signatures.
  - `runDigest`, `DigestReport` — match `src/digest/orchestrator.ts` signatures.
  - `commitAndPush` already accepts `(git, message, paths, branch, onStage)` — confirmed by existing call site.
  - The `--no-digest` commander idiom: `opts.digest === false` when present (this is commander's documented behavior; verified in their docs).

- **Test brittleness:** the third integration test depends on `extractedSessionId` correctly parsing the fixture. If the fixture's first JSONL line lacks `sessionId`, swap to either (a) reading `loadIndex(repo).entries` AFTER a separate `noDigest:true` run to discover the sessionId, or (b) parsing whichever line of the fixture carries it. Step 3's note documents the fallback.

- **Out of scope (deferred, by design):**
  - Dual worktree (separate raw + book branches) → Sprint 3.
  - `memvc digest --redo` command → Sprint 2.9.
  - Encrypted digest pipeline → future sprint.
  - Anthropic-API / GitHub-Models runner integration → Sprint 5.
