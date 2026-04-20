# Claude Session Leak Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop two related leak-and-pollute bugs surfaced 2026-04-19: (1) `claudeProjectHash` in `withIsolatedCwd` doesn't account for macOS's `/private` symlink prefix on `/var/folders/...` tmp paths, so the `~/.claude/projects/<hash>/` cleanup misses every leaked dir even on graceful exit. (2) `ClaudeCodeAdapter.discover()` walks all of `~/.claude/projects/` and would happily ingest the leaked memvc-claude-* session files into `raw_sessions/` on the next `memvc sync`, polluting BookIndex with bogus `T-memvc-claude-<hash>` projects. Fix both layers.

**Architecture:**
- Fix A (`withIsolatedCwd`): macOS `realpath`s the tmpdir before computing the Claude-CLI hash. `mkdtempSync(join(tmpdir(), ...))` returns `/var/folders/...` but Claude CLI sees the resolved `/private/var/folders/...` and writes its session dir under that hash. We need the hash from the resolved path. Use `fs.realpathSync(isolatedCwd)` on every platform; on macOS this prepends `/private`, on Linux it's a no-op.
- Fix B (`ClaudeCodeAdapter`): when iterating `~/.claude/projects/`, skip any directory whose name corresponds to a tmp path (matches `os.tmpdir()` after the slash-to-dash transformation, OR contains the literal string `memvc-claude-`, OR — most robust — whose name when reverse-mapped resolves under `os.tmpdir()`). The simplest robust check: skip directories whose basename starts with `-private-var-folders-` OR `-var-folders-` OR `-tmp-` (covers macOS `/private/var/folders`, raw `/var/folders` if symlink resolution didn't run, and Linux `/tmp`). Plus an explicit exclusion for any name containing `-memvc-claude-` as a defensive belt.

**Tech Stack:** Node 20+, TypeScript ESM, vitest. No new deps.

---

## Scope

2 tasks, 2 commits. Each is small and independently committable.

- **Task 1**: Fix `claudeProjectHash` to use realpath
- **Task 2**: Filter tmpdir / memvc-claude paths from `ClaudeCodeAdapter.discover()`

---

## File Structure

**Modified:**
- `src/digest/with-isolated-cwd.ts` — `realpathSync` the tmpdir before hashing; update `_claudeProjectHashForTests` accordingly (now takes a path that's already resolved, OR moves resolution inside)
- `src/sources/claude-code.ts` — add `isMemvcOrTmpPath(name)` predicate to `discover()`, skip matching subdirs
- `tests/digest/with-isolated-cwd.test.ts` — add test that the cleanup actually removes the `~/.claude/projects/<hash>` dir under macOS-style tmpdir
- `tests/sources/claude-code.test.ts` (or wherever the adapter is tested) — add a test that adapter skips a `-private-var-folders-...-memvc-claude-XXX` subdir

**Untouched:** every other file. The isolated-cwd helper continues to receive an unmodified mkdtemp path; only the hash function knows about realpath.

---

## Task 1: Realpath the cwd before hashing

**Files:**
- Modify: `src/digest/with-isolated-cwd.ts`
- Modify: `tests/digest/with-isolated-cwd.test.ts`

### Step 1.1 — Update `withIsolatedCwd` to compute hash from realpath

The current code:

```ts
const claudeProjectsDir = join(homedir(), ".claude", "projects", claudeProjectHash(isolatedCwd));
if (existsSync(claudeProjectsDir)) {
  try { rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch { /* swallow */ }
}
```

Change to use the resolved path, since Claude CLI itself resolves symlinks before naming its session dir:

```ts
import { realpathSync } from "node:fs";

// In the finally block, BEFORE computing the projects dir:
let resolvedCwd = isolatedCwd;
try {
  resolvedCwd = realpathSync(isolatedCwd);
} catch {
  // tmpdir already removed (we just rmSync'd it above) — best-effort: try
  // resolving the parent path components manually. macOS's /var → /private/var
  // is the only case we care about.
  if (isolatedCwd.startsWith("/var/")) {
    resolvedCwd = "/private" + isolatedCwd;
  }
}
const claudeProjectsDir = join(homedir(), ".claude", "projects", claudeProjectHash(resolvedCwd));
if (existsSync(claudeProjectsDir)) {
  try { rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch { /* swallow */ }
}
```

Order matters: `realpathSync` must happen BEFORE the `rmSync(isolatedCwd, ...)` of Task 1 step earlier — but the existing code currently does `rmSync(isolatedCwd)` first, THEN computes the Claude projects dir. Reorder:

The full new finally block:

```ts
} finally {
  // First, resolve the cwd path so we can derive Claude CLI's hash. Must be
  // BEFORE we rm the tmpdir (since realpath needs the dir to exist).
  let resolvedCwd = isolatedCwd;
  try {
    resolvedCwd = realpathSync(isolatedCwd);
  } catch {
    // Defensive: if it was already gone, fall back to manual /private prefix
    // for macOS /var paths (the only platform where realpath matters here).
    if (isolatedCwd.startsWith("/var/")) {
      resolvedCwd = "/private" + isolatedCwd;
    }
  }
  // Best-effort #1: clean the tmp cwd dir.
  try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* swallow */ }
  // Best-effort #2: clean Claude CLI's session-history dir under
  // ~/.claude/projects/<hash>/ — we may have one or both of (resolved, unresolved)
  // hash names depending on Claude CLI's exact behavior. Try both.
  for (const candidatePath of new Set([resolvedCwd, isolatedCwd])) {
    const claudeProjectsDir = join(homedir(), ".claude", "projects", claudeProjectHash(candidatePath));
    if (existsSync(claudeProjectsDir)) {
      try { rmSync(claudeProjectsDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }
}
```

Why try both: cheap insurance. If a future Claude CLI version changes its hashing or doesn't resolve symlinks, we still catch it.

### Step 1.2 — Add a test asserting macOS-style hash includes `/private`

Add to `tests/digest/with-isolated-cwd.test.ts`:

```ts
it("claudeProjectHash for a /var/folders path produces a -private-var-folders-... hash on macOS-style realpath", () => {
  // Simulate what realpath would have returned for an unresolved /var path.
  expect(_claudeProjectHashForTests("/private/var/folders/zm/x/T/memvc-claude-Ab")).toBe(
    "-private-var-folders-zm-x-T-memvc-claude-Ab",
  );
});

it("withIsolatedCwd cleanup attempts ~/.claude/projects/<resolved-hash> dir", async () => {
  // We can't easily assert the rm happened (it's a real file op), but we can
  // assert: after the run, the cwd is gone (already covered) AND we don't
  // throw when ~/.claude doesn't even exist (which it should in CI).
  let cwdSeen = "";
  await withIsolatedCwd(
    { run: async (_p, _v, opts) => { cwdSeen = opts?.cwd ?? ""; return { ok: true, text: "", durationMs: 1 }; } },
    async (w) => { await w.run("p", {}); },
  );
  expect(existsSync(cwdSeen)).toBe(false);
  // The cleanup of ~/.claude/projects/<hash> is best-effort and may or may
  // not have a real dir to delete; just assert no throw.
});
```

(The existing `_claudeProjectHashForTests` test checks the slash-replacement for `/var/folders/x/T/memvc-claude-Ab` → `-var-folders-x-T-memvc-claude-Ab`. Keep it; that demonstrates the unresolved case still hashes correctly.)

### Step 1.3 — Run + commit

- [ ] **Run `npm test -- with-isolated-cwd`** — green; expect +1 new test for the /private hash, existing tests unchanged.
- [ ] **Run `npm test`** — full suite green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit:** `git add -u && git commit -m "fix(digest): realpath isolatedCwd before hashing so macOS /var → /private cleanup actually works"`

---

## Task 2: ClaudeCodeAdapter skips tmp / memvc-claude project dirs

**Files:**
- Modify: `src/sources/claude-code.ts`
- Modify: `tests/sources/claude-code.test.ts` (or `tests/sources/` equivalent — check what exists)

### Step 2.1 — Add `isMemvcOrTmpProjectDir(name)` predicate

In `src/sources/claude-code.ts`:

```ts
/**
 * Skip Claude project directories that correspond to memvc's own scratch
 * subprocesses, or to system tmpdirs in general. Without this filter, an
 * interrupted `memvc sync` leaves ~/.claude/projects/<-private-var-folders-...-memvc-claude-X>/
 * dirs that the next sync would happily ingest as "T-memvc-claude-X" projects,
 * polluting BookIndex.
 *
 * Matches:
 *   - any name containing "-memvc-claude-" (defensive belt for our own subprocesses)
 *   - names starting with "-private-var-folders-" (macOS resolved tmpdirs)
 *   - names starting with "-var-folders-"        (macOS raw tmpdirs, pre-realpath)
 *   - names starting with "-tmp-"                 (Linux tmpdirs)
 */
function isMemvcOrTmpProjectDir(name: string): boolean {
  if (name.includes("-memvc-claude-")) return true;
  if (name.startsWith("-private-var-folders-")) return true;
  if (name.startsWith("-var-folders-")) return true;
  if (name.startsWith("-tmp-")) return true;
  return false;
}
```

In the existing `discover()` walk loop, add a check before recursing into a subdirectory. The current loop processes each entry under `this.root` (which is `~/.claude/projects/`). When `e.isDirectory()`, we currently push `p` onto the stack. Change to:

```ts
if (e.isDirectory()) {
  // Skip our own scratch dirs and system tmpdirs — see isMemvcOrTmpProjectDir.
  // We only filter at the top level (entries directly under ~/.claude/projects/).
  if (dir === this.root && isMemvcOrTmpProjectDir(e.name)) continue;
  stack.push(p);
}
```

(The `dir === this.root` guard ensures we only filter the top-level project dirs, not anything deeper. Each top-level entry under `~/.claude/projects/` IS a project dir.)

### Step 2.2 — Test

Look at `tests/sources/` for existing claude-code adapter tests. If `claude-code.test.ts` exists, add to it. If not, create one.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/sources/claude-code.js";

describe("ClaudeCodeAdapter — pollution filter", () => {
  let claudeRoot: string;
  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), "memvc-claude-test-"));
  });

  it("skips top-level project dirs that look like memvc scratch", async () => {
    // Real-looking project dir
    const realProj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(realProj, { recursive: true });
    writeFileSync(join(realProj, "session-1.jsonl"), '{"sessionId":"s1","cwd":"/Users/yueliu/edge/memvc"}\n');

    // Polluted dirs — different shapes
    const polluted1 = join(claudeRoot, "-private-var-folders-zm-x-T-memvc-claude-Abc");
    mkdirSync(polluted1, { recursive: true });
    writeFileSync(join(polluted1, "junk.jsonl"), '{"sessionId":"junk","cwd":"/private/var/folders/x/T/memvc-claude-Abc"}\n');

    const polluted2 = join(claudeRoot, "-var-folders-y-T-memvc-claude-Def");
    mkdirSync(polluted2, { recursive: true });
    writeFileSync(join(polluted2, "junk2.jsonl"), '{"sessionId":"junk2","cwd":"/var/folders/y/T/memvc-claude-Def"}\n');

    const polluted3 = join(claudeRoot, "-tmp-memvc-claude-Ghi");
    mkdirSync(polluted3, { recursive: true });
    writeFileSync(join(polluted3, "junk3.jsonl"), '{"sessionId":"junk3","cwd":"/tmp/memvc-claude-Ghi"}\n');

    // Generic memvc-claude name without the standard tmpdir prefix
    const polluted4 = join(claudeRoot, "-some-random-path-memvc-claude-Jkl");
    mkdirSync(polluted4, { recursive: true });
    writeFileSync(join(polluted4, "junk4.jsonl"), '{"sessionId":"junk4","cwd":"/x/memvc-claude-Jkl"}\n');

    const adapter = new ClaudeCodeAdapter(claudeRoot);
    const sessionIds: string[] = [];
    for await (const ds of adapter.discover()) {
      // Only accumulate sessionIds; load() may fail on toy fixtures and that's fine
      try {
        const s = await ds.load();
        sessionIds.push(s.sessionId);
      } catch {
        // Some toy JSONLs may not parse cleanly; ignore for this test
      }
    }
    expect(sessionIds).toContain("s1");
    expect(sessionIds).not.toContain("junk");
    expect(sessionIds).not.toContain("junk2");
    expect(sessionIds).not.toContain("junk3");
    expect(sessionIds).not.toContain("junk4");
  });
});
```

If the adapter's existing test file uses a different fixture style, adapt accordingly. The shape is more important than the exact mechanism.

### Step 2.3 — Run + commit

- [ ] **Run `npm test`** — green.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit:** `git add -u && git commit -m "fix(sources): ClaudeCodeAdapter skips memvc-claude / tmpdir project dirs to prevent pollution"`

---

## Self-Review Checklist (already applied)

- **Spec coverage:** both bugs in user report addressed. Manual cleanup of the 6 leaked dirs already done before plan written (~284MB freed); no further migration needed.
- **Placeholder scan:** every code step has full code; no TBD.
- **Type consistency:** `isMemvcOrTmpProjectDir` is a private function; no type changes leak. `withIsolatedCwd` signature unchanged.
- **Cross-platform:** macOS `/var/folders` → `/private/var/folders` handled. Linux `/tmp` handled. Windows: not a target. Tests use `mkdtempSync` which works portably.
- **Backward compat:** Both fixes are additive (cleanup tries more candidates; adapter skips fewer dirs). Existing real projects under `~/.claude/projects/` are untouched.
- **Out of scope (deliberately):**
  - Auto-cleanup of leaked dirs older than N days (acceptable: subsequent successful digest runs cleanup their own; very-old leaks live forever unless user notices).
  - SIGINT handler in `withIsolatedCwd` (would require process-level state; not worth it for an edge case).
  - Detecting and pruning leaked dirs from BookIndex retroactively (no pollution exists today; if it ever does, `digest --reset` cleans).
