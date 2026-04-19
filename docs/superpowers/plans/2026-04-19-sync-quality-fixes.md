# Sync Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four user-reported quality issues from `memvc sync` real-world usage: (1) `claude -p` subprocesses spawn in the user's CWD and pollute their Claude session history, (2) book changes don't push because legacy configs lack `deviceBranch`, (3) BookIndex contains pseudo-projects (`.worktrees-*`, `*.code-workspace`, etc) from non-real-project Claude sessions, (4) no command exists to wipe and re-run digest from scratch when state is corrupted.

**Architecture:**
- Fix 1: spawn `claude` with `cwd` set to a temp directory so each subprocess gets its own isolated session-history directory under `~/.claude/projects/`. Tempdir is created once per `runDigest` call and cleaned up on completion.
- Fix 2: `sync.ts` self-heals a missing/empty `deviceBranch` by computing it from `os.hostname()` (using existing `deviceBranchFromHostname`) and writing it back to `~/.memvc/config.json`. One-shot migration; logs a notice.
- Fix 3: introduce `isRealProjectPath(path): boolean` predicate. Sessions whose `cwd` looks like a worktree, electron data dir, or a one-off path are dropped from BookIndex (they DO get extracted into `raw_sessions/` so we don't lose data — but the digest pipeline ignores them). One-shot migration prunes existing junk from `BookIndex.threads`.
- Fix 4: new CLI `memvc digest --reset` that deletes `book/`, `.memvc/index.book.json`, then runs `runDigest` from scratch. Sibling to `--redo`.

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

---

## Scope

Four independent fixes in one plan. Each task is independently committable; tasks can ship in any order though Task 2 (deviceBranch self-heal) is the highest user-impact and should ship first.

- **Task 1**: `deviceBranch` self-healing migration in `sync.ts`
- **Task 2**: spawn `claude` with isolated `cwd`
- **Task 3**: filter pseudo-projects + one-shot migration
- **Task 4**: `memvc digest --reset` command

---

## Task 1: Self-heal missing `deviceBranch`

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/config.ts` (export updateConfig helper if not already)
- Modify: `tests/commands/sync.test.ts`

### Step 1.1 — Add `updateConfig` helper if missing

- [ ] **Check `src/config.ts`** for an existing way to write back the config. Currently `writeConfig(cfg: Config)` does it. We'll just call it from sync.ts.

### Step 1.2 — In `syncCmd`, self-heal before calling `runSync`

- [ ] **Edit `src/commands/sync.ts`** — at the top of `syncCmd`, after `readConfig()`, add:

```ts
import { writeConfig } from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
// ... existing imports

export async function syncCmd(opts: { noDigest?: boolean } = {}): Promise<void> {
  const cfg = readConfig();

  // Self-heal: legacy configs (pre-Sprint 1.5) lack deviceBranch. Without it,
  // the push gate in runSync silently skips commit+push. Migrate by computing
  // from hostname and writing back to ~/.memvc/config.json.
  if (!cfg.deviceBranch || cfg.deviceBranch.trim() === "") {
    const newBranch = deviceBranchFromHostname();
    console.log(chalk.cyan(
      `Migrating: legacy config missing deviceBranch. Setting to "${newBranch}" and saving to ~/.memvc/config.json.`,
    ));
    cfg.deviceBranch = newBranch;
    writeConfig(cfg);
  }

  const passphrase = cfg.encrypt ? getPassphrase() : undefined;
  // ... rest of existing syncCmd unchanged
```

### Step 1.3 — Test

- [ ] **Add to `tests/commands/sync.test.ts`** a test that calls `syncCmd` with a stubbed config (mock `readConfig` to return `deviceBranch: ""`) and asserts `writeConfig` was called with a non-empty branch. This is harder to test in isolation because `syncCmd` reads from `~/.memvc/config.json`. Acceptable alternative: extract the self-heal logic into a small pure helper `ensureDeviceBranch(cfg): { migrated: boolean; cfg: Config }` and unit-test that.

```ts
// In src/commands/sync.ts, extract:
export function ensureDeviceBranchOnConfig(cfg: Config): { migrated: boolean; cfg: Config } {
  if (cfg.deviceBranch && cfg.deviceBranch.trim() !== "") {
    return { migrated: false, cfg };
  }
  return {
    migrated: true,
    cfg: { ...cfg, deviceBranch: deviceBranchFromHostname() },
  };
}
```

Then in `syncCmd`:
```ts
const heal = ensureDeviceBranchOnConfig(cfg);
if (heal.migrated) {
  console.log(chalk.cyan(`Migrating: setting deviceBranch to "${heal.cfg.deviceBranch}"`));
  writeConfig(heal.cfg);
}
const cfg = heal.cfg; // shadow with the migrated copy
```

Test:
```ts
import { ensureDeviceBranchOnConfig } from "../../src/commands/sync.js";

describe("ensureDeviceBranchOnConfig", () => {
  it("migrates when deviceBranch is empty string", () => {
    const cfg: Config = { /* ... fill required fields ..., */ deviceBranch: "" };
    const r = ensureDeviceBranchOnConfig(cfg);
    expect(r.migrated).toBe(true);
    expect(r.cfg.deviceBranch.length).toBeGreaterThan(0);
  });
  it("no-op when deviceBranch is set", () => {
    const cfg: Config = { /* ..., */ deviceBranch: "my-device" };
    const r = ensureDeviceBranchOnConfig(cfg);
    expect(r.migrated).toBe(false);
    expect(r.cfg.deviceBranch).toBe("my-device");
  });
});
```

- [ ] **Step 1.4: Commit**
```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "fix(sync): self-heal legacy configs missing deviceBranch"
```

---

## Task 2: Isolate `claude -p` cwd to prevent session-history pollution

**Files:**
- Modify: `src/digest/runners/claude-cli.ts`
- Modify: `src/digest/orchestrator.ts` (creates the temp dir, passes path down)
- Modify: `src/digest/runner.ts` (RunOptions gains `cwd?: string`)
- Modify: `tests/digest/runners/claude-cli.test.ts` (if exists)

### Step 2.1 — Add `cwd` to `RunOptions` and use in claude-cli

- [ ] **Edit `src/digest/runner.ts`** — add field:
```ts
export interface RunOptions {
  timeoutMs?: number;
  outputFormat?: "json" | "text";
  /** Working directory for the subprocess (claude-cli only). When omitted,
   *  uses process.cwd(), which causes Claude to log session history under
   *  ~/.claude/projects/<hash-of-cwd>/. Pass an isolated tmp dir to prevent
   *  polluting the user's project history. */
  cwd?: string;
}
```

- [ ] **Edit `src/digest/runners/claude-cli.ts`** — pass `cwd` to spawn:
```ts
proc = spawn("claude", args, {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: opts.cwd, // undefined falls back to process.cwd()
});
```

### Step 2.2 — In orchestrator, create tmpdir + pass down

- [ ] **Edit `src/digest/orchestrator.ts`** at the top of `runDigest`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export async function runDigest(/* ...existing args */): Promise<DigestReport> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), "memvc-claude-"));
  try {
    // ... existing body, but wrap runner usage:
    const wrappedRunner: LlmRunner = {
      run: (prompt, vars, opts = {}) => runner.run(prompt, vars, { ...opts, cwd: isolatedCwd }),
    };
    // Use wrappedRunner everywhere instead of runner.
    // ... existing logic
  } finally {
    try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
```

Same wrapping for `runDigestRedo`.

### Step 2.3 — Test

- [ ] **Add a unit test** in `tests/digest/runners/claude-cli.test.ts` (create if missing) that uses a mock spawn (vi.mock node:child_process) and asserts the spawn `options` object contains `cwd: <expected>`.

- [ ] **Step 2.4: Commit**
```bash
git add src/digest/runners/claude-cli.ts src/digest/runner.ts src/digest/orchestrator.ts src/digest/redo.ts tests/digest/runners/claude-cli.test.ts
git commit -m "fix(digest): spawn claude -p with isolated cwd to prevent session-history pollution"
```

---

## Task 3: Filter pseudo-projects from BookIndex

**Files:**
- Create: `src/digest/project-filter.ts` — `isRealProjectPath(path): boolean`
- Modify: `src/digest/pipeline.ts` — drop sessions whose `IndexEntry.project` looks pseudo
- Modify: `src/digest/orchestrator.ts` — one-shot migration that prunes existing pseudo-projects from `BookIndex.threads`
- Create: `tests/digest/project-filter.test.ts`

### Step 3.1 — `isRealProjectPath` predicate

- [ ] **Create `src/digest/project-filter.ts`**:

```ts
/**
 * Heuristic: a path is a "real project" if it's a developer working directory,
 * not a worktree, electron data dir, or transient workspace path.
 *
 * Rejects:
 *   - paths containing /.worktrees-*
 *   - paths ending in *.code-workspace, *.json (likely workspace.json fragments)
 *   - paths whose basename matches workspaceStorage hash patterns (32-hex)
 *   - empty / "root" / "home"
 *   - paths under VSCode workspaceStorage (~/Library/.../Code/User/workspaceStorage)
 *
 * This is a heuristic — it's allowed to be wrong in edge cases. Goal: clean
 * the obviously-junk projects out of book/ TOC.
 */
export function isRealProjectPath(slugOrPath: string): boolean {
  if (!slugOrPath || slugOrPath === "root" || slugOrPath === "home") return false;
  const lower = slugOrPath.toLowerCase();
  if (lower.includes(".worktrees-")) return false;
  if (lower.endsWith(".code-workspace") || lower.endsWith("-workspacestorage")) return false;
  if (lower.endsWith(".json") || lower.endsWith("-workspace.json")) return false;
  // Reject pure-numeric / 32-hex-like pseudo-IDs masquerading as project names
  if (/^\d{10,}/.test(slugOrPath)) return false;
  if (/^[a-f0-9]{20,}$/.test(slugOrPath)) return false;
  return true;
}
```

### Step 3.2 — Tests

- [ ] **Create `tests/digest/project-filter.test.ts`**:

```ts
import { describe, it, expect } from "vitest";
import { isRealProjectPath } from "../../src/digest/project-filter.js";

describe("isRealProjectPath", () => {
  it("accepts normal project slugs", () => {
    expect(isRealProjectPath("edge-memvc")).toBe(true);
    expect(isRealProjectPath("chromium-src")).toBe(true);
  });
  it("rejects worktree paths", () => {
    expect(isRealProjectPath(".worktrees-38e8767b-6a62-4f6f-b062-96296496fee0")).toBe(false);
  });
  it("rejects workspace.json-derived names", () => {
    expect(isRealProjectPath("1747378825021-workspace.json")).toBe(false);
    expect(isRealProjectPath("commands-pew.code-workspace")).toBe(false);
  });
  it("rejects workspaceStorage hash dirs", () => {
    expect(isRealProjectPath("User-workspaceStorage")).toBe(false);
  });
  it("rejects sentinel values", () => {
    expect(isRealProjectPath("")).toBe(false);
    expect(isRealProjectPath("root")).toBe(false);
    expect(isRealProjectPath("home")).toBe(false);
  });
  it("rejects long-numeric prefixed names", () => {
    expect(isRealProjectPath("1747378825021-something")).toBe(false);
  });
});
```

### Step 3.3 — Apply filter in `pipeline.findNewSessionEntries`

- [ ] **Edit `src/digest/pipeline.ts`**:

```ts
import { isRealProjectPath } from "./project-filter.js";

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
    if (covered.has(e.sessionId)) continue;
    if (!isRealProjectPath(e.project)) continue; // NEW: skip pseudo-projects
    out.push(e);
  }
  out.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  return out;
}
```

### Step 3.4 — One-shot migration in `runDigest`

- [ ] **Edit `src/digest/orchestrator.ts`** at the top of `runDigest` (before any phase):

```ts
import { isRealProjectPath } from "./project-filter.js";

// One-shot migration: drop pseudo-project entries from BookIndex.threads.
// Existing book/ files for those projects are NOT deleted (user can `digest --reset`
// for a clean slate). Future sync just won't recreate them.
let pruned = 0;
for (const [tid, be] of Object.entries(bookIndex.threads)) {
  if (!isRealProjectPath(be.project)) {
    delete bookIndex.threads[tid];
    pruned++;
  }
}
for (const project of Object.keys(bookIndex.chapters)) {
  if (!isRealProjectPath(project)) {
    delete bookIndex.chapters[project];
    pruned++;
  }
}
if (pruned > 0) {
  console.log(`runDigest: pruned ${pruned} pseudo-project entries from BookIndex`);
}
```

### Step 3.5 — Update tests + commit

- [ ] **Run `npm test`** — all green; add the 6 project-filter tests.
- [ ] **Commit**:
```bash
git add src/digest/project-filter.ts src/digest/pipeline.ts src/digest/orchestrator.ts tests/digest/project-filter.test.ts
git commit -m "fix(digest): filter pseudo-projects (.worktrees, *.code-workspace, etc) from BookIndex"
```

---

## Task 4: `memvc digest --reset` command

**Files:**
- Modify: `src/commands/digest.ts` — add `reset?: boolean` and `runDigestReset` flow
- Modify: `src/cli.ts` — register `--reset` flag
- Modify: `tests/commands/digest.test.ts`

### Step 4.1 — `digestCmd` handles `--reset`

- [ ] **Edit `src/commands/digest.ts`**:

```ts
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DigestOptions {
  redo?: boolean;
  reset?: boolean;
}

export async function digestCmd(opts: DigestOptions): Promise<void> {
  if (opts.reset && opts.redo) {
    console.log(chalk.red("Cannot use --reset and --redo together. Pick one."));
    return;
  }
  if (opts.reset) {
    return runDigestReset();
  }
  if (opts.redo) {
    // ... existing redo logic unchanged
  }
  // ... existing fall-through help unchanged
}

async function runDigestReset(): Promise<void> {
  const cfg = readConfig();
  console.log(chalk.yellow(`memvc digest --reset: wiping book/ and .memvc/index.book.json under ${cfg.repoPath}`));
  const bookDir = join(cfg.repoPath, "book");
  const bookIndex = join(cfg.repoPath, ".memvc", "index.book.json");
  if (existsSync(bookDir)) rmSync(bookDir, { recursive: true, force: true });
  if (existsSync(bookIndex)) rmSync(bookIndex, { force: true });
  console.log(chalk.gray("  wiped. Now running fresh digest..."));

  const key = cfg.encrypt
    ? deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"))
    : null;

  const idx = loadIndex(cfg.repoPath);
  const book = loadBookIndex(cfg.repoPath); // empty after wipe
  const runner = createRunner({ runner: cfg.runner, runnerModel: cfg.runnerModel });
  const report = await runDigest(runner, cfg.repoPath, idx, book, key);
  saveBookIndex(cfg.repoPath, book);

  console.log(chalk.bold(
    `\n--reset complete: +${report.articlesOk} articles, ${report.threadsSkipped} skip, ${report.articlesFailed} failed; ${report.chaptersRewritten.length} chapters`,
  ));

  // git push (mirror digestCmd push block)
  if (cfg.deviceBranch) {
    const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
    try { await git.fetch(); } catch { /* ok if offline */ }
    await ensureDeviceBranch(git, cfg.deviceBranch);
    const paths = [
      ".memvc/index.book.json",
      ...report.tocFilesWritten,
      ...report.chaptersRewritten.map((p) => `book/${p}/chapter.md`),
      ...uniqueProjects(report).map((p) => `book/${p}/articles`),
    ];
    const r = await commitAndPush(
      git,
      `memvc digest --reset: ${report.articlesOk} articles, ${report.chaptersRewritten.length} chapters`,
      paths,
      cfg.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    if (r.committed) {
      console.log(chalk.cyan(r.pushed ? "Pushed (book)." : "Committed book (push failed)."));
    }
  }
}
```

### Step 4.2 — `src/cli.ts` registers `--reset`

- [ ] **Edit `src/cli.ts`** — modify the existing `digest` block:

```ts
program
  .command("digest")
  .description("Digest pipeline operations: --redo retries failed; --reset wipes book/ and re-runs from scratch")
  .option("--redo", "retry all failed threads and force-rewrite every chapter")
  .option("--reset", "DESTRUCTIVE: wipe book/ + .memvc/index.book.json, then run digest from scratch")
  .action(async (opts: { redo?: boolean; reset?: boolean }) => {
    const { digestCmd } = await import("./commands/digest.js");
    await digestCmd({ redo: opts.redo, reset: opts.reset });
  });
```

### Step 4.3 — Test

- [ ] **Add an integration test** in `tests/commands/digest.test.ts`:

```ts
it("--reset wipes book/ and runs fresh digest", async () => {
  // ... pre-stage book/ + index.book.json with junk content
  // ... call digestCmd({ reset: true }) with a fake runner
  // ... assert book/ was wiped then refilled, BookIndex re-saved
});
```

- [ ] **Step 4.4: Commit**
```bash
git add src/commands/digest.ts src/cli.ts tests/commands/digest.test.ts
git commit -m "feat(cli): add 'memvc digest --reset' to wipe book/ and re-run digest from scratch"
```

---

## Self-Review Checklist

- **Spec coverage:** four discrete user reports, one task each. No spec change.
- **Type consistency:** `Config.deviceBranch` already exists; no schema change. `RunOptions.cwd` is additive. `DigestOptions.reset` is additive.
- **Failure handling:** Each task's failure is isolated:
  - Task 1 failure: deviceBranch stays empty, push gate keeps short-circuiting (current behavior, no regression)
  - Task 2 failure: tmpdir creation fails → throws, runDigest aborts (acceptable; rare)
  - Task 3 failure: filter rejects valid project → user manually edits BookIndex, or we tune the predicate
  - Task 4 failure: rm partway through → user can re-run, idempotent

- **Out of scope:**
  - Re-encrypting BookIndex
  - Renaming pseudo-project article files on disk (just leave them; `--reset` cleans)
  - Multi-device deviceBranch coordination (Sprint 4 concern)
