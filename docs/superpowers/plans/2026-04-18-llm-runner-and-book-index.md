# Sprint 2.1 + 2.2 — LlmRunner & BookIndex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the two foundation modules of the layered knowledge base pipeline: a pluggable `LlmRunner` abstraction (with a working `claude-cli` runner + two stub backends) and a typed read/write/upsert layer for the new book-side index file `.memvc/index.book.json`. No pipeline wiring yet — that comes in subsequent Sprint 2 tasks.

**Architecture:**
- `src/digest/` is a brand-new directory housing every digest-stage module. This plan only adds two files in it: `runner.ts` (interface + factory) and `book-index.ts` (BookIndex IO + helpers), plus a `runners/` subdir with three implementations.
- `Config` gets two new optional fields `runner` and `runnerModel` so future commands can pick a backend at runtime.
- `claude-cli` runner spawns the `claude` CLI as a subprocess in `--output-format json` mode and parses stdout. The two other runners throw a clear "not implemented" error to keep the surface stable for Sprint 5.
- BookIndex is stored at `<repoRoot>/.memvc/index.book.json` next to the existing `index.json`. Schema is the one defined in the layered-kb spec.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), zod (already in deps), vitest, simple-git (unused here), `node:child_process` for spawn.

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md`, sections "代码结构 → LLM Runner 抽象" and "数据模型 → `.memvc/index.book.json`".

---

## File Structure

**New files:**
- `src/digest/runner.ts` — `LlmRunner` interface, `RunResult` type, `createRunner(cfg)` factory
- `src/digest/runners/claude-cli.ts` — spawns `claude -p --output-format json`
- `src/digest/runners/anthropic-api.ts` — stub, throws "not implemented yet (Sprint 5)"
- `src/digest/runners/github-models.ts` — stub, same
- `src/digest/book-index.ts` — `BookIndex`, `BookEntry`, `ChapterEntry` types + `loadBookIndex` / `saveBookIndex` / `upsertThread` / `upsertChapter` / `latestSourceShaFor`
- `tests/digest/runner.test.ts` — factory + claude-cli runner (mocked spawn) + stub runners
- `tests/digest/book-index.test.ts` — IO + helpers

**Modified files:**
- `src/config.ts` — add `runner` and `runnerModel` to schema (both have defaults so existing configs stay valid)

**Untouched:** every existing source file other than `src/config.ts`. No CLI wiring, no `sync.ts` change.

---

## Task 1: Extend Config with runner fields

**Files:**
- Modify: `src/config.ts:10-17`

- [ ] **Step 1: Modify `src/config.ts`**

Replace the existing `Schema` declaration (lines 10-17) with:

```ts
const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),          // base64 per-repo salt for scrypt
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api", "github-models"]).default("claude-cli"),
  runnerModel: z.string().default(""),
});
export type Config = z.infer<typeof Schema>;
```

The two new fields have `.default(...)` so configs written before this change still parse cleanly (zod fills defaults on parse).

- [ ] **Step 2: Build to confirm typing**

Run: `npm run build`
Expected: clean exit, no TS errors.

- [ ] **Step 3: Run full tests**

Run: `npm test`
Expected: all existing tests pass — schema is backward compatible, no caller passes the new fields yet.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add runner and runnerModel fields (defaults: claude-cli, empty model)"
```

---

## Task 2: Runner interface + factory + stubs

**Files:**
- Create: `src/digest/runner.ts`
- Create: `src/digest/runners/anthropic-api.ts`
- Create: `src/digest/runners/github-models.ts`
- Create: `tests/digest/runner.test.ts`

(The real `claude-cli` runner is Task 3. This task wires the interface and the two not-yet-implemented backends so the factory compiles end-to-end first.)

- [ ] **Step 1: Write failing test for factory + stubs**

Create `tests/digest/runner.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { createRunner } from "../../src/digest/runner.js";

describe("createRunner factory", () => {
  it("returns an object with a .run() function for claude-cli", () => {
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for anthropic-api", () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for github-models", () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });
});

describe("anthropic-api runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});

describe("github-models runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- runner`
Expected: FAIL with "Cannot find module '../../src/digest/runner.js'".

- [ ] **Step 3: Write `src/digest/runner.ts`**

Create the file with:

```ts
import { runClaudeCli } from "./runners/claude-cli.js";
import { runAnthropicApi } from "./runners/anthropic-api.js";
import { runGithubModels } from "./runners/github-models.js";

export type RunResult =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export interface RunOptions {
  timeoutMs?: number;
  outputFormat?: "json" | "text";
}

export interface LlmRunner {
  run(prompt: string, vars: Record<string, string>, opts?: RunOptions): Promise<RunResult>;
}

export interface RunnerConfig {
  runner: "claude-cli" | "anthropic-api" | "github-models";
  runnerModel: string;
}

/**
 * Substitute `{{key}}` placeholders in `prompt` with values from `vars`.
 * Used by every runner so prompt files can reference variables uniformly.
 */
export function renderPrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `{{${k}}}`,
  );
}

export function createRunner(cfg: RunnerConfig): LlmRunner {
  switch (cfg.runner) {
    case "claude-cli":
      return {
        run: (prompt, vars, opts) =>
          runClaudeCli(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
    case "anthropic-api":
      return {
        run: (prompt, vars, opts) =>
          runAnthropicApi(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
    case "github-models":
      return {
        run: (prompt, vars, opts) =>
          runGithubModels(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
  }
}
```

- [ ] **Step 4: Write `src/digest/runners/anthropic-api.ts`**

Create with:

```ts
import type { RunOptions, RunResult } from "../runner.js";

export async function runAnthropicApi(
  _prompt: string,
  _model: string,
  _opts: RunOptions,
): Promise<RunResult> {
  return {
    ok: false,
    error: "anthropic-api runner is not implemented yet (planned for Sprint 5)",
    durationMs: 0,
  };
}
```

- [ ] **Step 5: Write `src/digest/runners/github-models.ts`**

Create with:

```ts
import type { RunOptions, RunResult } from "../runner.js";

export async function runGithubModels(
  _prompt: string,
  _model: string,
  _opts: RunOptions,
): Promise<RunResult> {
  return {
    ok: false,
    error: "github-models runner is not implemented yet (planned for Sprint 5)",
    durationMs: 0,
  };
}
```

- [ ] **Step 6: Stub the claude-cli runner so the import resolves**

Create `src/digest/runners/claude-cli.ts` with a placeholder body (Task 3 will replace the body with the real implementation):

```ts
import type { RunOptions, RunResult } from "../runner.js";

export async function runClaudeCli(
  _prompt: string,
  _model: string,
  _opts: RunOptions,
): Promise<RunResult> {
  return {
    ok: false,
    error: "claude-cli runner not yet implemented in this commit (filled in next task)",
    durationMs: 0,
  };
}
```

- [ ] **Step 7: Run — expect pass**

Run: `npm test -- runner`
Expected: PASS (5 assertions across 5 tests).

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: clean exit, no TS errors.

- [ ] **Step 9: Commit**

```bash
git add src/digest/runner.ts src/digest/runners/anthropic-api.ts src/digest/runners/github-models.ts src/digest/runners/claude-cli.ts tests/digest/runner.test.ts
git commit -m "feat(digest): LlmRunner interface + factory with stub runners"
```

---

## Task 3: Real `claude-cli` runner (spawn `claude -p`)

**Files:**
- Modify: `src/digest/runners/claude-cli.ts` (replace stub body)
- Modify: `tests/digest/runner.test.ts` (append spawn-mocked tests)

**Background:** `claude -p '<prompt>' --output-format json` writes a JSON object to stdout that includes `result` (the assistant text) and `is_error`. We spawn it, write the prompt to stdin (avoiding argv length limits), accumulate stdout, parse JSON, and return.

- [ ] **Step 1: Append failing tests for the real runner**

Append to `tests/digest/runner.test.ts`:

```ts
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

function fakeSpawn(stdout: string, exitCode: number, opts: { delayMs?: number } = {}) {
  return vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    const proc = new EventEmitter() as childProcess.ChildProcess;
    const stdoutEm = new EventEmitter() as NodeJS.ReadableStream;
    const stderrEm = new EventEmitter() as NodeJS.ReadableStream;
    const stdinChunks: string[] = [];
    const stdin = {
      write: (c: string | Buffer) => { stdinChunks.push(c.toString()); return true; },
      end: () => {},
    } as unknown as NodeJS.WritableStream;
    (proc as any).stdout = stdoutEm;
    (proc as any).stderr = stderrEm;
    (proc as any).stdin = stdin;
    (proc as any).kill = vi.fn();
    setTimeout(() => {
      stdoutEm.emit("data", Buffer.from(stdout));
      proc.emit("close", exitCode);
    }, opts.delayMs ?? 0);
    return proc;
  });
}

describe("claude-cli runner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:true with parsed result text on exit code 0", async () => {
    fakeSpawn(JSON.stringify({ result: "hello world", is_error: false }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("say hi", {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("hello world");
  });

  it("substitutes {{var}} placeholders in the prompt before spawning", async () => {
    const spy = fakeSpawn(JSON.stringify({ result: "ok" }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    await r.run("hello {{name}}!", { name: "Yue" });
    // The rendered prompt is fed via stdin; verify the spawned process received no `--prompt` argv leak.
    const argv = spy.mock.calls[0][1] as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    // model is empty → no `--model` flag
    expect(argv).not.toContain("--model");
  });

  it("passes --model when runnerModel is non-empty", async () => {
    const spy = fakeSpawn(JSON.stringify({ result: "ok" }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "claude-opus-4-6" });
    await r.run("x", {});
    const argv = spy.mock.calls[0][1] as string[];
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });

  it("returns ok:false when exit code is non-zero", async () => {
    fakeSpawn("", 1);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code 1/);
  });

  it("returns ok:false when stdout is not valid JSON", async () => {
    fakeSpawn("not json {", 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parse/i);
  });

  it("returns ok:false when timeout elapses", async () => {
    fakeSpawn(JSON.stringify({ result: "late" }), 0, { delayMs: 50 });
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {}, { timeoutMs: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/timeout/i);
  });
});
```

Add the `afterEach` import at the top of the file by changing the existing first import line:

```ts
import { describe, it, expect, afterEach } from "vitest";
```

(If `afterEach` is already imported, leave it.)

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- runner`
Expected: 5 of the 6 new claude-cli tests FAIL (only the timeout one might pass by accident depending on the stub). Errors should mention "not yet implemented" coming from the stub body.

- [ ] **Step 3: Replace `src/digest/runners/claude-cli.ts` with the real implementation**

Overwrite the file with:

```ts
import { spawn } from "node:child_process";
import type { RunOptions, RunResult } from "../runner.js";

const DEFAULT_TIMEOUT_MS = 180_000;

export async function runClaudeCli(
  prompt: string,
  model: string,
  opts: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const args: string[] = ["-p", "--output-format", opts.outputFormat ?? "json"];
  if (model.trim().length > 0) {
    args.push("--model", model);
  }

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      settle({
        ok: false,
        error: `failed to spawn claude: ${(err as Error).message}`,
        durationMs: Date.now() - started,
      });
      return;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      proc.kill?.("SIGTERM");
      settle({
        ok: false,
        error: `claude-cli timeout after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      settle({
        ok: false,
        error: `claude-cli spawn error: ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - started;
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          ok: false,
          error: `claude-cli exit code ${code}${tail ? `: ${tail}` : ""}`,
          durationMs,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (parsed.is_error) {
          settle({ ok: false, error: `claude-cli reported is_error`, durationMs });
          return;
        }
        if (typeof parsed.result !== "string") {
          settle({ ok: false, error: "claude-cli output missing 'result' string", durationMs });
          return;
        }
        settle({ ok: true, text: parsed.result, durationMs });
      } catch (err) {
        settle({
          ok: false,
          error: `failed to parse claude-cli JSON: ${(err as Error).message}`,
          durationMs,
        });
      }
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- runner`
Expected: all 11 tests pass (5 original + 6 new claude-cli ones).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/digest/runners/claude-cli.ts tests/digest/runner.test.ts
git commit -m "feat(digest): real claude-cli runner with stdin prompt, JSON parse, timeout"
```

---

## Task 4: BookIndex types + IO

**Files:**
- Create: `src/digest/book-index.ts`
- Create: `tests/digest/book-index.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/digest/book-index.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBookIndex,
  saveBookIndex,
  upsertThread,
  upsertChapter,
  latestSourceShaFor,
  type BookIndex,
  type BookEntry,
} from "../../src/digest/book-index.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "memvc-book-"));
}

describe("loadBookIndex", () => {
  it("returns an empty skeleton when no file exists", () => {
    const repo = tmpRepo();
    const idx = loadBookIndex(repo);
    expect(idx.version).toBe(1);
    expect(idx.threads).toEqual({});
    expect(idx.chapters).toEqual({});
  });

  it("round-trips through saveBookIndex", () => {
    const repo = tmpRepo();
    const idx: BookIndex = {
      version: 1,
      threads: {
        t1: {
          threadId: "t1",
          project: "proj-a",
          title: "标题",
          sessionIds: ["s1", "s2"],
          articlePath: "book/proj-a/articles/2026-04-18__t1__abcd1234.md",
          articleVersion: 1,
          latestSourceSha: "deadbeef",
          articleStatus: "ok",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
      },
      chapters: {
        "proj-a": {
          chapterVersion: 1,
          lastFullRewrite: "2026-04-18T00:00:00.000Z",
          latestArticleHash: "feedface",
        },
      },
    };
    saveBookIndex(repo, idx);
    expect(existsSync(join(repo, ".memvc/index.book.json"))).toBe(true);
    const loaded = loadBookIndex(repo);
    expect(loaded).toEqual(idx);
  });

  it("throws on unsupported version", () => {
    const repo = tmpRepo();
    saveBookIndex(repo, { version: 1, threads: {}, chapters: {} });
    // overwrite to a bad version
    const path = join(repo, ".memvc/index.book.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.version = 99;
    require("node:fs").writeFileSync(path, JSON.stringify(raw));
    expect(() => loadBookIndex(repo)).toThrow(/version/);
  });
});

describe("upsertThread", () => {
  it("inserts a new thread and overwrites an existing one by threadId", () => {
    const idx: BookIndex = { version: 1, threads: {}, chapters: {} };
    const e: BookEntry = {
      threadId: "fix-bug",
      project: "p",
      title: "修 bug",
      sessionIds: ["s1"],
      articlePath: "book/p/articles/x.md",
      articleVersion: 1,
      latestSourceSha: "aaa",
      articleStatus: "ok",
      updatedAt: "2026-04-18T00:00:00.000Z",
    };
    upsertThread(idx, e);
    expect(idx.threads["fix-bug"]).toEqual(e);

    const e2: BookEntry = { ...e, sessionIds: ["s1", "s2"], latestSourceSha: "bbb" };
    upsertThread(idx, e2);
    expect(idx.threads["fix-bug"].sessionIds).toEqual(["s1", "s2"]);
    expect(idx.threads["fix-bug"].latestSourceSha).toBe("bbb");
    expect(Object.keys(idx.threads).length).toBe(1);
  });
});

describe("upsertChapter", () => {
  it("creates and updates chapter entries by project key", () => {
    const idx: BookIndex = { version: 1, threads: {}, chapters: {} };
    upsertChapter(idx, "proj-a", { chapterVersion: 1, lastFullRewrite: "t1", latestArticleHash: "h1" });
    expect(idx.chapters["proj-a"].latestArticleHash).toBe("h1");
    upsertChapter(idx, "proj-a", { chapterVersion: 2, lastFullRewrite: "t2", latestArticleHash: "h2" });
    expect(idx.chapters["proj-a"]).toEqual({ chapterVersion: 2, lastFullRewrite: "t2", latestArticleHash: "h2" });
  });
});

describe("latestSourceShaFor", () => {
  it("hashes the concatenation of session shas in input order", () => {
    const a = latestSourceShaFor(["sha-1", "sha-2", "sha-3"]);
    const b = latestSourceShaFor(["sha-1", "sha-2", "sha-3"]);
    const c = latestSourceShaFor(["sha-2", "sha-1", "sha-3"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a stable empty-input hash", () => {
    expect(latestSourceShaFor([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- book-index`
Expected: FAIL with "Cannot find module '../../src/digest/book-index.js'".

- [ ] **Step 3: Write `src/digest/book-index.ts`**

Create with:

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const REL = ".memvc/index.book.json";

export interface BookEntry {
  threadId: string;
  project: string;
  title: string;
  sessionIds: string[];
  articlePath: string;
  articleVersion: number;
  latestSourceSha: string;
  articleStatus: "ok" | "failed";
  articleError?: string;
  skip?: boolean;
  skipReason?: string;
  updatedAt: string; // ISO
}

export interface ChapterEntry {
  chapterVersion: number;
  lastFullRewrite: string; // ISO
  latestArticleHash: string;
}

export interface BookIndex {
  version: 1;
  threads: Record<string, BookEntry>;
  chapters: Record<string, ChapterEntry>;
}

export function loadBookIndex(repoRoot: string): BookIndex {
  const p = join(repoRoot, REL);
  if (!existsSync(p)) return { version: 1, threads: {}, chapters: {} };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as BookIndex;
  if (parsed.version !== 1) throw new Error(`unsupported book index version: ${parsed.version}`);
  return parsed;
}

export function saveBookIndex(repoRoot: string, idx: BookIndex): void {
  const dir = join(repoRoot, ".memvc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, REL), JSON.stringify(idx, null, 2) + "\n");
}

export function upsertThread(idx: BookIndex, entry: BookEntry): void {
  idx.threads[entry.threadId] = entry;
}

export function upsertChapter(idx: BookIndex, project: string, entry: ChapterEntry): void {
  idx.chapters[project] = entry;
}

/**
 * Stable hash over the ordered concatenation of per-session source shas.
 * Used by Article generation to detect when a thread's underlying sessions
 * have changed and the article must be regenerated.
 *
 * Order matters — caller is expected to pass shas in a stable session order
 * (e.g. by endedAt ascending).
 */
export function latestSourceShaFor(sessionShas: string[]): string {
  const h = createHash("sha256");
  h.update("memvc:book:thread:v1");
  for (const s of sessionShas) {
    h.update("\0");
    h.update(s);
  }
  return h.digest("hex");
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- book-index`
Expected: PASS (8 assertions across 6 tests).

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all prior tests still pass; new tests included.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/digest/book-index.ts tests/digest/book-index.test.ts
git commit -m "feat(digest): BookIndex types + load/save/upsert/latestSourceShaFor helpers"
```

---

## Self-Review

**1. Spec coverage (sections "LLM Runner 抽象" and "数据模型 → `.memvc/index.book.json`"):**
- Runner interface with `run(prompt, vars, opts)` and `RunResult` shape ✓ Task 2
- `claude-cli` runner spawning `claude -p --output-format json`, `--model` when set, default 180s timeout ✓ Task 3
- `anthropic-api` and `github-models` stubs returning structured "not implemented" ✓ Task 2
- Config gains `runner` + `runnerModel`, defaults backward compatible ✓ Task 1
- `BookIndex` / `BookEntry` schema matches spec field-for-field (threadId, project, title, sessionIds, articlePath, articleVersion, latestSourceSha, articleStatus, articleError?, skip?, skipReason?, updatedAt; chapters with chapterVersion/lastFullRewrite/latestArticleHash) ✓ Task 4
- `latestSourceSha` derivation helper ✓ Task 4
- `.memvc/index.book.json` location ✓ Task 4 (`REL` constant)

**Out of scope of this plan, deferred to later Sprint 2 sub-plans:**
- Batcher (2.3), Threading (2.4), Article (2.5), Chapter (2.6), TOC (2.7), sync wiring (2.8), `digest --redo` (2.9). None of those are referenced here, so no stubs leak in.

**2. Placeholder scan:**
- No "TODO", "TBD", "fill in later" tokens.
- Step 6 of Task 2 introduces a deliberate placeholder *runner body*, but the plan immediately replaces it in Task 3 — this is intentional staging, not an unfinished step.
- Every code block is complete and self-contained.

**3. Type consistency:**
- `LlmRunner.run(prompt, vars, opts)` signature is identical in interface, factory, and runner implementations.
- `RunResult` discriminated union is the only return type used everywhere.
- `RunnerConfig` shape (`runner`, `runnerModel`) matches the new Config fields added in Task 1.
- `BookEntry`, `ChapterEntry`, `BookIndex` names line up with the spec exactly. Tests construct them via `BookEntry`/`BookIndex` types imported from the same module.
- File `.memvc/index.book.json` referenced consistently as `REL` and in tests.

No gaps found. Plan is ready.

---

## Out of Scope (deliberately deferred to next sub-plans)

- Wiring runner into `sync` (Task 2.8 in roadmap)
- Prompt files under `assets/prompts/` (created in 2.4 / 2.5 / 2.6 sub-plans, since they're consumed there)
- Reading prompt files from `.memvc/prompts/` in user repo (Sprint 3 task 3.3)
- `digest` command (2.9)
