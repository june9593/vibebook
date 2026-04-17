# Per-Device Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memvc sync to a per-device branch (named after `os.hostname()`) so multiple machines can push to the same repo without merge conflicts. `main` is left untouched — users view per-device chat logs by checking out the device branch.

**Architecture:** Device identity is derived from `os.hostname()`, sanitized to a git-safe slug, then persisted in `~/.memvc/config.json` as `deviceBranch`. `ensureRepo` creates the branch as an **orphan** (empty history) the first time it's used, so device branches don't share history with `main` or each other. Existing users on `main` get a one-shot migration when they next run any command: rename local `main` → `<device>` and create a fresh empty `main`.

**Tech Stack:** Node 20+, TypeScript, simple-git, existing memvc stack.

---

## File Structure

**New files:**
- `src/device.ts` — derive + sanitize the device branch name from `os.hostname()`
- `tests/device.test.ts` — unit tests for sanitizer
- `tests/git-ops-branches.test.ts` — integration test: orphan branch creation, push to device branch
- `src/migrate.ts` — one-shot rename of legacy `main` → `<device>` on first run

**Modified files:**
- `src/config.ts` — add optional `deviceBranch` field to Config schema
- `src/commands/init.ts` — populate `deviceBranch` at init time
- `src/git-ops.ts` — `ensureDeviceBranch(git, branchName)` helper; `commitAndPush` pushes to `<device>` not `HEAD`
- `src/commands/sync.ts` — call `ensureDeviceBranch` before commit; run migration check

---

## Task 1: Device-name derivation

**Files:**
- Create: `src/device.ts`
- Create: `tests/device.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/device.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeBranchName, deviceBranchFromHostname } from "../src/device.js";

describe("sanitizeBranchName", () => {
  it("keeps alnum, dash, underscore, dot", () => {
    expect(sanitizeBranchName("yuedeMacBook-Pro-2.local")).toBe("yuedeMacBook-Pro-2.local");
  });
  it("replaces spaces and unsafe chars with dashes", () => {
    expect(sanitizeBranchName("Yue's iMac")).toBe("Yue-s-iMac");
  });
  it("collapses runs of dashes and trims leading/trailing", () => {
    expect(sanitizeBranchName("---foo   bar---")).toBe("foo-bar");
  });
  it("lowercases nothing (preserves case)", () => {
    expect(sanitizeBranchName("MacBook")).toBe("MacBook");
  });
  it("falls back to 'device' when empty after sanitize", () => {
    expect(sanitizeBranchName("///")).toBe("device");
  });
  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long).length).toBe(60);
  });
});

describe("deviceBranchFromHostname", () => {
  it("returns sanitized hostname", () => {
    // hostname() is env-dependent; assert only that result is non-empty and sanitized
    const b = deviceBranchFromHostname();
    expect(b.length).toBeGreaterThan(0);
    expect(b).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- device`
Expected: FAIL with "Cannot find module '../src/device.js'".

- [ ] **Step 3: Write `src/device.ts`**

```ts
import { hostname } from "node:os";

/**
 * Make `raw` safe for use as a git branch name.
 * Keeps [A-Za-z0-9._-]; replaces everything else with '-'; collapses runs of '-';
 * trims leading/trailing '-' or '.'; caps length at 60.
 * Falls back to "device" if empty after sanitize.
 */
export function sanitizeBranchName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^[-.]+|[-.]+$/g, "");
  if (s.length === 0) return "device";
  if (s.length > 60) s = s.slice(0, 60).replace(/[-.]+$/g, "");
  return s || "device";
}

export function deviceBranchFromHostname(): string {
  return sanitizeBranchName(hostname());
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- device`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/device.ts tests/device.test.ts
git commit -m "feat(device): sanitize os.hostname() into a git-safe branch name"
```

---

## Task 2: Extend Config with deviceBranch field

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts` (if exists — otherwise skip test edit)

- [ ] **Step 1: Modify `src/config.ts`**

Replace the `Schema` block with:

```ts
const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),
  deviceBranch: z.string().default(""),
});
export type Config = z.infer<typeof Schema>;
```

The `.default("")` means existing configs missing the field will parse successfully with empty string.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Run full tests**

Run: `npm test`
Expected: all existing tests still pass (schema is backward compatible).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add deviceBranch field (default empty for backward-compat)"
```

---

## Task 3: Orphan-branch creation in git-ops

**Files:**
- Modify: `src/git-ops.ts`
- Create: `tests/git-ops-branches.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/git-ops-branches.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { ensureDeviceBranch } from "../src/git-ops.js";

async function initBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-remote-"));
  await simpleGit().cwd(dir).init(true);
  return dir;
}

async function initClient(remote: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-client-"));
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addRemote("origin", remote);
  return dir;
}

describe("ensureDeviceBranch", () => {
  it("creates an orphan branch when none exists locally or on remote", async () => {
    const remote = await initBareRemote();
    const client = await initClient(remote);
    const git = simpleGit(client);

    await ensureDeviceBranch(git, "mbp2");

    const branchSummary = await git.branchLocal();
    expect(branchSummary.current).toBe("mbp2");
    // No commits yet — HEAD should be unborn. A dummy write + commit should be the first.
    writeFileSync(join(client, "hello.txt"), "hi\n");
    await git.add(["hello.txt"]);
    await git.commit("first");
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("first");
  });

  it("is idempotent: running twice stays on the branch", async () => {
    const remote = await initBareRemote();
    const client = await initClient(remote);
    const git = simpleGit(client);

    await ensureDeviceBranch(git, "mbp2");
    writeFileSync(join(client, "a.txt"), "a\n");
    await git.add(["a.txt"]);
    await git.commit("a");

    await ensureDeviceBranch(git, "mbp2");
    const b = await git.branchLocal();
    expect(b.current).toBe("mbp2");
    const log = await git.log();
    expect(log.total).toBe(1); // no new commits from second call
  });

  it("checks out existing remote device branch instead of creating orphan", async () => {
    const remote = await initBareRemote();

    // machine A creates branch and pushes one commit
    const clientA = await initClient(remote);
    const gitA = simpleGit(clientA);
    await ensureDeviceBranch(gitA, "mbp2");
    writeFileSync(join(clientA, "a.txt"), "a\n");
    await gitA.add(["a.txt"]);
    await gitA.commit("a");
    await gitA.push("origin", "mbp2");

    // machine A (or same machine fresh clone) — new local repo, branch should come from remote
    const clientB = await initClient(remote);
    const gitB = simpleGit(clientB);
    await gitB.fetch();
    await ensureDeviceBranch(gitB, "mbp2");
    const log = await gitB.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("a");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- git-ops-branches`
Expected: FAIL with "ensureDeviceBranch is not a function".

- [ ] **Step 3: Modify `src/git-ops.ts`** — add `ensureDeviceBranch` and change push target

Replace the whole file with:

```ts
import { simpleGit, SimpleGit } from "simple-git";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export async function ensureRepo(localPath: string, repoUrl: string): Promise<SimpleGit> {
  if (!existsSync(localPath)) {
    mkdirSync(localPath, { recursive: true });
    const git = simpleGit();
    await git.clone(repoUrl, localPath);
  }
  const git = simpleGit(localPath);
  if (!existsSync(join(localPath, ".git"))) {
    await git.init();
    await git.addRemote("origin", repoUrl).catch(() => { /* exists */ });
  }
  return git;
}

/**
 * Make sure the working tree is on `branch`.
 * Priority:
 *   1. Local branch exists → checkout.
 *   2. Remote `origin/<branch>` exists → checkout tracking branch.
 *   3. Neither → create as orphan (empty history, no parent).
 */
export async function ensureDeviceBranch(git: SimpleGit, branch: string): Promise<void> {
  const local = await git.branchLocal();
  if (local.all.includes(branch)) {
    if (local.current !== branch) await git.checkout(branch);
    return;
  }
  // Look for remote tracking branch
  let remoteHas = false;
  try {
    const remote = await git.branch(["-r"]);
    remoteHas = remote.all.includes(`origin/${branch}`);
  } catch { /* no remotes fetched yet */ }
  if (remoteHas) {
    await git.checkout(["-b", branch, "--track", `origin/${branch}`]);
    return;
  }
  // Orphan branch — empty history
  await git.checkout(["--orphan", branch]);
  // `git checkout --orphan` leaves the index full of whatever was staged from the
  // previous branch (if any). Clear it so the first commit only contains intended paths.
  await git.raw(["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
}

function pushWithProgress(cwd: string, branch: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(
      "git",
      ["push", "--progress", "--set-upstream", "origin", branch],
      { cwd, stdio: ["ignore", "inherit", "inherit"] },
    );
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

export async function commitAndPush(
  git: SimpleGit,
  message: string,
  paths: string[],
  branch: string,
  onProgress?: (stage: string) => void,
): Promise<{ committed: boolean; pushed: boolean }> {
  if (paths.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git add (${paths.length} paths)...`);
  await git.add(paths);
  const status = await git.status();
  if (status.staged.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git commit (${status.staged.length} staged)...`);
  await git.commit(message);
  onProgress?.(`git push origin ${branch} (live progress below):`);
  const cwd = await git.revparse(["--show-toplevel"]).then((s) => s.trim());
  const ok = await pushWithProgress(cwd, branch);
  return { committed: true, pushed: ok };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- git-ops-branches`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git-ops.ts tests/git-ops-branches.test.ts
git commit -m "feat(git-ops): ensureDeviceBranch + push to named branch with upstream tracking"
```

---

## Task 4: Wire device branch into sync

**Files:**
- Modify: `src/commands/sync.ts`

- [ ] **Step 1: Modify `src/commands/sync.ts`** — import ensureDeviceBranch, use deviceBranch from config

Change the existing sync file. Replace:

```ts
import { ensureRepo, commitAndPush } from "../git-ops.js";
```

with:

```ts
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
```

Add `deviceBranch` to `SyncOptions`:

```ts
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
}
```

Replace the push block at the end of `runSync`. Find:

```ts
  let committed = false, pushed = false;
  if (opts.push && opts.repoUrl) {
    console.log(chalk.gray(`\nOpening repo at ${opts.repoPath}...`));
    const git = await ensureRepo(opts.repoPath, opts.repoUrl);
    const all = [...pathsWritten, indexPath];
    console.log(chalk.gray(`Staging ${all.length} paths and committing...`));
    const r = await commitAndPush(
      git,
      `memvc sync: +${newCount} sessions`,
      all,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    committed = r.committed; pushed = r.pushed;
    if (committed && !pushed) console.log(chalk.yellow("Commit done, push failed or skipped."));
  }
```

Replace with:

```ts
  let committed = false, pushed = false;
  if (opts.push && opts.repoUrl && opts.deviceBranch) {
    console.log(chalk.gray(`\nOpening repo at ${opts.repoPath}...`));
    const git = await ensureRepo(opts.repoPath, opts.repoUrl);
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
```

Replace the `syncCmd` function body. Find:

```ts
export async function syncCmd(): Promise<void> {
  const cfg = readConfig();
  const passphrase = cfg.encrypt ? getPassphrase() : undefined;
  const r = await runSync({
    repoPath: cfg.repoPath,
    encrypt: cfg.encrypt,
    passphrase,
    saltB64: cfg.salt,
    push: true,
    repoUrl: cfg.repoUrl,
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed." : "Committed (push failed)."));
}
```

Replace with:

```ts
export async function syncCmd(): Promise<void> {
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
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed." : "Committed (push failed)."));
}
```

- [ ] **Step 2: Update existing sync test signature**

Open `tests/commands/sync.test.ts`. The existing test calls `runSync({ repoPath, claudeRoot, vscodeRoot, encrypt: false })` without `push`. Those calls still work because `push` defaults to falsy, so branch code is skipped. No test change needed.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all existing tests pass (21+ tests).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts
git commit -m "feat(sync): push to device branch instead of HEAD"
```

---

## Task 5: init command populates deviceBranch

**Files:**
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Modify `src/commands/init.ts`**

Replace the whole file with:

```ts
import { writeConfig, configExists, freshSaltBase64, type Config } from "../config.js";
import { ensureRepo } from "../git-ops.js";
import { deviceBranchFromHostname } from "../device.js";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl: string;
  localPath?: string;
  encrypt?: boolean;
  device?: string;
}

export async function initCmd(opts: InitOptions): Promise<void> {
  if (configExists()) {
    console.log(chalk.yellow("memvc already initialized — editing ~/.memvc/config.json manually if needed."));
  }
  const localPath = opts.localPath ?? join(homedir(), "memvc-repo");
  await ensureRepo(localPath, opts.repoUrl);
  const cfg: Config = {
    repoPath: localPath,
    repoUrl: opts.repoUrl,
    encrypt: !!opts.encrypt,
    salt: freshSaltBase64(),
    deviceBranch: opts.device ?? deviceBranchFromHostname(),
  };
  writeConfig(cfg);
  console.log(chalk.green(`memvc initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  device branch: ${cfg.deviceBranch}`);
  console.log(`  encrypt: ${cfg.encrypt}`);
  if (cfg.encrypt) console.log(chalk.cyan(`  set MEMVC_PASSPHRASE env var before running sync`));
}
```

- [ ] **Step 2: Wire `--device` flag in `src/cli.ts`**

Find the existing init command block:

```ts
program
  .command("init <repoUrl>")
  .description("Initialize memvc with a private repo")
  .option("--local-path <path>", "local checkout path (default ~/memvc-repo)")
  .option("--encrypt", "encrypt raw files before commit")
  .action(async (repoUrl: string, opts: { localPath?: string; encrypt?: boolean }) => {
    const { initCmd } = await import("./commands/init.js");
    await initCmd({ repoUrl, localPath: opts.localPath, encrypt: opts.encrypt });
  });
```

Replace with:

```ts
program
  .command("init <repoUrl>")
  .description("Initialize memvc with a private repo")
  .option("--local-path <path>", "local checkout path (default ~/memvc-repo)")
  .option("--encrypt", "encrypt raw files before commit")
  .option("--device <name>", "device branch name (default: sanitized os.hostname())")
  .action(async (repoUrl: string, opts: { localPath?: string; encrypt?: boolean; device?: string }) => {
    const { initCmd } = await import("./commands/init.js");
    await initCmd({ repoUrl, localPath: opts.localPath, encrypt: opts.encrypt, device: opts.device });
  });
```

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/init.ts src/cli.ts
git commit -m "feat(init): record deviceBranch in config (defaults to hostname, --device flag to override)"
```

---

## Task 6: Migration — rename legacy `main` → `<device>` on first run

**Files:**
- Create: `src/migrate.ts`
- Create: `tests/migrate.test.ts`
- Modify: `src/commands/sync.ts` — call migration once at start

- [ ] **Step 1: Write failing test**

```ts
// tests/migrate.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { migrateLegacyMainToDevice } from "../src/migrate.js";

async function initRepoOnMain(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-migrate-"));
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  writeFileSync(join(dir, "file.txt"), "hello\n");
  await git.add(["file.txt"]);
  await git.commit("initial");
  return dir;
}

describe("migrateLegacyMainToDevice", () => {
  it("renames main → <device> and leaves main unborn (unchanged working tree)", async () => {
    const dir = await initRepoOnMain();
    const git = simpleGit(dir);

    const result = await migrateLegacyMainToDevice(dir, "mbp2");

    expect(result.migrated).toBe(true);
    const branches = await git.branchLocal();
    expect(branches.all).toContain("mbp2");
    expect(branches.current).toBe("mbp2");
    // Old commit should be on mbp2
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("initial");
  });

  it("is a no-op when device branch already exists", async () => {
    const dir = await initRepoOnMain();
    const git = simpleGit(dir);
    await git.checkoutLocalBranch("mbp2");

    const result = await migrateLegacyMainToDevice(dir, "mbp2");
    expect(result.migrated).toBe(false);
  });

  it("is a no-op when there is no main branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memvc-empty-"));
    const git = simpleGit(dir);
    await git.init(["--initial-branch=mbp2"]);
    writeFileSync(join(dir, "f.txt"), "x\n");
    await git.add(["f.txt"]);
    await git.commit("x");

    const result = await migrateLegacyMainToDevice(dir, "mbp2");
    expect(result.migrated).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- migrate`
Expected: FAIL with "Cannot find module '../src/migrate.js'".

- [ ] **Step 3: Write `src/migrate.ts`**

```ts
import { simpleGit } from "simple-git";

/**
 * One-shot migration for repos created before per-device-branches existed.
 *
 * If the local repo has a `main` branch but no `<device>` branch, rename
 * main → <device> (preserving history) so the device branch becomes the
 * new write target. `main` is left unborn on purpose — it will be re-created
 * later (manually or by a future merge-to-main command) as the aggregate view.
 *
 * No-op when:
 *   - the device branch already exists (migration was already done, or a
 *     fresh clone is already on the right branch)
 *   - there is no `main` branch to rename
 */
export async function migrateLegacyMainToDevice(
  repoPath: string,
  deviceBranch: string,
): Promise<{ migrated: boolean }> {
  const git = simpleGit(repoPath);
  const local = await git.branchLocal();
  if (local.all.includes(deviceBranch)) return { migrated: false };
  if (!local.all.includes("main")) return { migrated: false };

  if (local.current !== "main") await git.checkout("main");
  await git.branch(["-m", "main", deviceBranch]);
  return { migrated: true };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- migrate`
Expected: PASS (3 tests).

- [ ] **Step 5: Call migration from sync.ts**

Open `src/commands/sync.ts`. Add import at the top:

```ts
import { migrateLegacyMainToDevice } from "../migrate.js";
```

In `runSync`, immediately after:

```ts
  if (opts.push && opts.repoUrl && opts.deviceBranch) {
    console.log(chalk.gray(`\nOpening repo at ${opts.repoPath}...`));
    const git = await ensureRepo(opts.repoPath, opts.repoUrl);
```

insert:

```ts
    const mig = await migrateLegacyMainToDevice(opts.repoPath, opts.deviceBranch);
    if (mig.migrated) {
      console.log(chalk.cyan(`Migrated legacy 'main' branch to '${opts.deviceBranch}'. 'main' is now unborn locally.`));
    }
```

- [ ] **Step 6: Build + full tests**

Run: `npm run build && npm test`
Expected: clean build, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/migrate.ts tests/migrate.test.ts src/commands/sync.ts
git commit -m "feat(migrate): rename legacy 'main' branch to device branch on first sync"
```

---

## Task 7: Update existing config (one-time, manual)

**Files:** none (documentation only — this is a runtime step for the user).

- [ ] **Step 1: Document in README**

Open `/Users/yueliu/edge/memvc/README.md`. Append the following section:

```markdown

## Per-device branches (v0.2+)

Each machine pushes to its own branch named after `os.hostname()` (sanitized).
`main` is left empty and serves only as an aggregation target. To see chats
from machine `yuedeMacBook-Pro-2.local`, check out that branch on the remote.

Override the auto-derived name:

    memvc init <repoUrl> --device mbp2

Existing repos initialized before v0.2 will auto-migrate on the next `memvc sync`:
the local `main` branch is renamed to `<device>`, and a fresh unborn `main` is left
for you to use as a merge target.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: per-device branches section"
```

---

## Task 8: Manual end-to-end smoke test

**Files:** none.

This is a **manual** task — exercise the new code against the real repo.

- [ ] **Step 1: Build + link**

Run: `npm run build && npm link`

- [ ] **Step 2: Inspect current repo state**

Run:
```bash
cd ~/memvc-repo
git branch -a
git log --oneline -3
```

Expected: you're on `main` with some commits.

- [ ] **Step 3: Set deviceBranch in config**

If the install predates Task 5, the saved config won't have `deviceBranch`. Edit it:

```bash
# Replace <your-branch> with the output of `node -e "console.log(require('os').hostname())"`
jq '. + {deviceBranch: "<your-branch>"}' ~/.memvc/config.json > ~/.memvc/config.json.tmp
mv ~/.memvc/config.json.tmp ~/.memvc/config.json
```

- [ ] **Step 4: First sync with new code**

Run: `memvc sync`

Expected output contains:
```
Migrated legacy 'main' branch to '<your-branch>'. 'main' is now unborn locally.
Ensuring branch '<your-branch>' is checked out...
git push origin <your-branch> (live progress below):
...
```

- [ ] **Step 5: Verify branch state**

Run:
```bash
cd ~/memvc-repo
git branch -a
```

Expected:
- Local shows `* <your-branch>` as current.
- `main` still listed (points at the same commit that was there before, or is gone if `--initial-branch` config had it unborn — either is fine).
- `remotes/origin/<your-branch>` exists.

- [ ] **Step 6: Second sync is idempotent**

Run: `memvc sync`
Expected: `+0 new, N unchanged`, no migration message, branch stays put.

- [ ] **Step 7: Verify on GitHub**

Visit the repo on github.com, open the branch dropdown. You should see both `main` and `<your-branch>`. `<your-branch>` has all the content; `main` is empty.

---

## Out of Scope for This Sprint (deliberately deferred)

- **`memvc merge-to-main` command** — explicit merge/aggregate step. Keep `main` untouched for now.
- **Cross-device conflict handling** — users who iCloud-sync `~/.claude/projects` between machines. Not common; defer.
- **`memvc switch-device <name>`** — change branch on a machine mid-project. YAGNI.

---

## Self-Review Notes

- **Spec coverage:**
  - (1a) hostname-based branch name ✓ (Task 1)
  - (1b) sync pushes to device branch ✓ (Task 3 + Task 4)
  - (1c) `main` untouched during sync ✓ (Task 4 pushes `<deviceBranch>`, never `main`)
  - (1d) orphan branch for new devices ✓ (Task 3 `ensureDeviceBranch` case 3)
  - (1e) migrate existing `main`-based repos ✓ (Task 6)
- **Placeholder scan:** no TBD/TODO; all code blocks complete; all tests have assertions.
- **Type consistency:** `deviceBranch` used identically in Config, SyncOptions, initCmd, migrate, git-ops signatures. Function names match across tasks: `sanitizeBranchName`, `deviceBranchFromHostname`, `ensureDeviceBranch`, `migrateLegacyMainToDevice`.
- **TDD:** every code-producing task (1, 3, 6) has failing-test-first. Config/wiring tasks (2, 4, 5) rely on existing test suite + build.
- **One breaking change:** `commitAndPush` signature gains a required `branch` parameter. Only caller is `runSync`, updated in Task 4. Test file `tests/commands/sync.test.ts` doesn't call `commitAndPush` directly (it only goes through `runSync` without `push: true`), so it's unaffected.
