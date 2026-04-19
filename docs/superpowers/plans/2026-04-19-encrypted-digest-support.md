# Encrypted Digest Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `memvc sync` and `memvc digest --redo` run the digest pipeline (article/chapter/toc generation) even when raw sessions are AES-encrypted on disk, by passing the already-derived AES key down to the pipeline so it can decrypt `.enc` files in memory before feeding them to the LLM.

**Architecture:**
- The AES key is already derived in `runSync` from `MEMVC_PASSPHRASE` + per-repo salt. It's just never passed to the digest layer. We thread an optional `key: Buffer | null` parameter through `runSync → runDigest → pipeline.buildBatchingInput / buildArticleInputForThread`. When present, `.enc` paths are decrypted with `crypto.decrypt(buf, key)` before use; when null, current `.enc`-throws behavior is preserved (so callers without a key still fail loud). For `memvc digest --redo` we do the same: `digestCmd` derives the key when `cfg.encrypt` is true and passes it through.
- `book/` files (article markdown, chapter markdown, toc) stay plaintext per spec — `chapter.ts` reads `articlePath` which already lives under `book/**`. No decryption needed there.
- The `skipped-encrypted` status / branches in `sync.ts` and `digest.ts` are removed — encryption is no longer a digest blocker.

**Tech Stack:** Node 20+, TypeScript (ESM, `.js` extension imports), vitest. Reuses existing `src/crypto.ts` (`deriveKey`, `decrypt`).

**Spec reference:** `docs/superpowers/specs/2026-04-17-layered-knowledge-base-design.md` "raw 走加密；book 永远 plaintext"; the original Sprint 2.8.3 deferred encrypted-pipeline support as a known limitation.

---

## Scope

This is one focused fix, not a sprint. **Three small tasks** in one plan:

- **Task 1**: Plumb optional `key` through `pipeline.ts` + decrypt on read.
- **Task 2**: Plumb `key` through `orchestrator.ts` + `redo.ts`; remove `skipped-encrypted` from sync.ts and digest.ts.
- **Task 3**: Manual smoke test note + commit summary.

No new files, no new types beyond a `Buffer | null` parameter.

---

## File Structure

**Modified files:**
- `src/digest/pipeline.ts` — accept `key: Buffer | null`, decrypt `.enc` reads
- `src/digest/orchestrator.ts` — accept `key`, pass to pipeline + the inline buildStaleArticleInputs reads (already delegated to pipeline helper, so just thread the param)
- `src/digest/redo.ts` — accept `key`, pass to `buildArticleInputForThread`
- `src/commands/sync.ts` — pass `key` to `runDigest`; drop `skipped-encrypted` status + branches
- `src/commands/digest.ts` — derive key when `cfg.encrypt`; pass to `runDigestRedo` via `runDigestRedoFromRepo`; drop the encrypted-skip branch
- `tests/digest/pipeline.test.ts` — add tests for encrypted-path read with valid key + invalid key
- `tests/commands/sync.test.ts` — change the `encrypt:true` integration test from "is skipped" to "runs digest end-to-end against encrypted raw"

**New files:** none.

**Untouched:** `src/digest/chapter.ts` (reads only `book/**`, always plaintext), `src/digest/article.ts` (writes plaintext to `book/**`), `src/digest/toc.ts`, `src/crypto.ts`.

---

## Task 1: Decrypt-on-read in `pipeline.ts`

**Files:**
- Modify: `src/digest/pipeline.ts`
- Modify: `tests/digest/pipeline.test.ts`

### Step 1.1 — Update `pipeline.ts` to accept and use `key`

- [ ] **Replace `buildBatchingInput` and `buildArticleInputForThread` with key-aware versions**

In `src/digest/pipeline.ts`:

(a) Add `Buffer` to the existing imports:

```ts
import { Buffer } from "node:buffer";
import { decrypt } from "../crypto.js";
```

(b) Add a private helper at the top of the file (right after `sessionLookupBySid`, or inline above the two callers — your choice):

```ts
/**
 * Read a session body from disk, decrypting if its path ends with .enc.
 * Throws when path is .enc but no key is provided (this preserves the previous
 * "encryption not supported in digest" failure mode for callers that haven't
 * yet been updated to thread the key).
 */
function readSessionBody(
  repoRoot: string,
  relativePath: string,
  key: Buffer | null,
  contextLabel: string,
): string {
  const abs = join(repoRoot, relativePath);
  let raw: Buffer;
  try {
    raw = readFileSync(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${contextLabel}: cannot read session ${relativePath}: ${msg}`);
  }
  if (relativePath.endsWith(".enc")) {
    if (!key) {
      throw new Error(
        `${contextLabel}: encrypted session ${relativePath} but no key provided`,
      );
    }
    try {
      return decrypt(raw, key).toString("utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${contextLabel}: failed to decrypt ${relativePath}: ${msg}`);
    }
  }
  return raw.toString("utf8");
}
```

(c) Replace the body of `buildBatchingInput` to use the helper and accept `key`:

```ts
export function buildBatchingInput(
  entries: IndexEntry[],
  repoRoot: string,
  key: Buffer | null = null,
): SessionForBatching[] {
  const out: SessionForBatching[] = [];
  for (const e of entries) {
    const body = readSessionBody(repoRoot, e.relativePath, key, "pipeline.ts");
    out.push({
      sessionId: e.sessionId,
      project: e.project,
      endedAt: e.endedAt,
      tokenEstimate: Math.ceil(body.length / 3.5),
    });
  }
  return out;
}
```

(d) Replace the body of `buildArticleInputForThread` to use the helper and accept `key`:

```ts
export function buildArticleInputForThread(
  threadId: string,
  title: string,
  sessionIds: string[],
  indexFile: IndexFile,
  repoRoot: string,
  contextLabel: string,
  key: Buffer | null = null,
): ArticleInput | null {
  const lookup = sessionLookupBySid(indexFile);
  const entries: IndexEntry[] = [];
  for (const sid of sessionIds) {
    const ie = lookup.get(sid);
    if (!ie) {
      console.warn(
        `${contextLabel}: thread ${threadId} references unknown sessionId ${sid} — skipping`,
      );
      return null;
    }
    entries.push(ie);
  }

  const projects = new Set(entries.map((e) => e.project));
  if (projects.size > 1) {
    throw new Error(
      `${contextLabel}: thread ${threadId} spans multiple projects (${[...projects].join(", ")})`,
    );
  }
  const project = entries[0]!.project;

  entries.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

  const bodies: string[] = [];
  for (const e of entries) {
    const body = readSessionBody(repoRoot, e.relativePath, key, contextLabel);
    bodies.push(`--- SESSION ${e.shortId} (${e.endedAt}) ---\n\n${body}`);
  }

  return {
    threadId,
    project,
    title,
    sessionIds: entries.map((e) => e.sessionId),
    sessionShas: entries.map((e) => e.sourceSha256),
    sessionsMd: bodies.join("\n\n"),
    endedAt: entries[entries.length - 1]!.endedAt,
  };
}
```

(e) Update `buildArticleInputs` (the public-API caller of `buildArticleInputForThread`) to accept and forward `key`:

```ts
export function buildArticleInputs(
  candidates: ThreadCandidate[],
  indexFile: IndexFile,
  repoRoot: string,
  key: Buffer | null = null,
): ArticleInput[] {
  const out: ArticleInput[] = [];
  for (const c of candidates) {
    if (c.skip) continue;
    const input = buildArticleInputForThread(
      c.threadId, c.title, c.sessionIds, indexFile, repoRoot, "pipeline.ts", key,
    );
    if (input !== null) out.push(input);
  }
  return out;
}
```

(f) Update the JSDoc on `buildBatchingInput` and `buildArticleInputForThread` to mention the new `key` param and that `.enc` paths now decrypt when a key is provided.

### Step 1.2 — Tests

- [ ] **Add encrypted-path tests to `tests/digest/pipeline.test.ts`**

In `tests/digest/pipeline.test.ts`:

(a) Add to the top-of-file imports:

```ts
import { Buffer } from "node:buffer";
import { encrypt as encryptBuf, deriveKey } from "../../src/crypto.js";
```

(b) **Replace** the existing test `"throws when relativePath ends with .enc (encryption is out of scope for 2.8.1)"` inside `describe("buildBatchingInput", ...)` with three new tests:

```ts
  it("decrypts .enc paths when a key is provided", () => {
    const key = deriveKey("test-pass", Buffer.from("0123456789abcdef"));
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/secret.md.enc" });
    const ciphertext = encryptBuf(Buffer.from("x".repeat(35)), key);
    const abs = join(repoRoot, e.relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, ciphertext);
    const got = buildBatchingInput([e], repoRoot, key);
    expect(got[0]!.tokenEstimate).toBe(10);
  });

  it("throws when relativePath ends with .enc but no key is provided", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/secret.md.enc" });
    writeSessionMd(e.relativePath, "some bytes");
    expect(() => buildBatchingInput([e], repoRoot, null)).toThrow(/encrypted session/);
  });

  it("throws clearly when decryption fails (wrong key)", () => {
    const right = deriveKey("right-pass", Buffer.from("0123456789abcdef"));
    const wrong = deriveKey("wrong-pass", Buffer.from("0123456789abcdef"));
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/secret.md.enc" });
    const ciphertext = encryptBuf(Buffer.from("body"), right);
    const abs = join(repoRoot, e.relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, ciphertext);
    expect(() => buildBatchingInput([e], repoRoot, wrong)).toThrow(/decrypt/);
  });
```

(c) Inside `describe("buildArticleInputs", ...)`, add a fourth test that exercises the encrypted path through the article-input builder:

```ts
  it("decrypts .enc session bodies when a key is provided", () => {
    const key = deriveKey("test-pass", Buffer.from("0123456789abcdef"));
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/secret.md.enc" });
    const ciphertext = encryptBuf(Buffer.from("PLAINTEXT BODY"), key);
    const abs = join(repoRoot, e.relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, ciphertext);
    const idx = makeIndex([e]);
    const cands: ThreadCandidate[] = [
      { threadId: "t", title: "T", sessionIds: ["sid-1"] },
    ];
    const got = buildArticleInputs(cands, idx, repoRoot, key);
    expect(got).toHaveLength(1);
    expect(got[0]!.sessionsMd).toContain("PLAINTEXT BODY");
  });
```

### Step 1.3 — Run + commit

- [ ] **Run `npm test -- pipeline`** — expect all green (was 17 tests; the existing `.enc` test was replaced by 3 new + 1 added, so now 20).
- [ ] **Run `npm test`** — full suite green; expect 162 tests.
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/pipeline.ts tests/digest/pipeline.test.ts
git commit -m "feat(digest): pipeline accepts AES key and decrypts .enc sessions on read"
```

---

## Task 2: Thread `key` through orchestrator/redo, remove sync's skipped-encrypted

**Files:**
- Modify: `src/digest/orchestrator.ts`
- Modify: `src/digest/redo.ts`
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/digest.ts`
- Modify: `tests/commands/sync.test.ts`
- Modify: `tests/commands/digest.test.ts` (if needed — see note in step 2.5)

### Step 2.1 — `src/digest/orchestrator.ts`

- [ ] **Add optional `key: Buffer | null` to `runDigest` and forward it**

(a) Add to imports:

```ts
import { Buffer } from "node:buffer";
```

(b) Change the `runDigest` signature to accept an optional `key`:

```ts
export async function runDigest(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null = null,
): Promise<DigestReport> {
```

(c) Inside `runDigest`, update the two existing pipeline calls in the threading branch to pass `key`:

```ts
    const sessionsForBatching = buildBatchingInput(newEntries, repoRoot, key);
    const batches = makeBatches(sessionsForBatching);
    const candidates = await runThreading(runner, batches);
    report.threadCandidates = candidates.length;
    report.threadsSkipped = recordSkippedThreadCandidates(bookIndex, candidates, indexFile).length;
    articleInputs = buildArticleInputs(candidates, indexFile, repoRoot, key);
```

(d) Find the call to `buildStaleArticleInputs(bookIndex, indexFile, repoRoot)` and add `key` as the fourth argument:

```ts
const staleInputs = buildStaleArticleInputs(bookIndex, indexFile, repoRoot, key)
  .filter((i) => !freshThreadIds.has(i.threadId));
```

(e) Update `buildStaleArticleInputs`'s signature and forward `key` to `buildArticleInputForThread`:

```ts
function buildStaleArticleInputs(
  bookIndex: BookIndex,
  indexFile: IndexFile,
  repoRoot: string,
  key: Buffer | null,
): ArticleInput[] {
  const out: ArticleInput[] = [];
  for (const be of Object.values(bookIndex.threads)) {
    if (be.skip) continue;
    if (be.articleStatus === "failed") continue;
    if (be.articleVersion === ARTICLE_VERSION) continue;
    const input = buildArticleInputForThread(
      be.threadId, be.title, be.sessionIds, indexFile, repoRoot, "orchestrator.ts", key,
    );
    if (input !== null) out.push(input);
  }
  return out;
}
```

### Step 2.2 — `src/digest/redo.ts`

- [ ] **Add optional `key: Buffer | null` to `runDigestRedo` and forward it**

(a) Add `import { Buffer } from "node:buffer";` to the imports.

(b) Change the signature:

```ts
export async function runDigestRedo(
  runner: LlmRunner,
  repoRoot: string,
  indexFile: IndexFile,
  bookIndex: BookIndex,
  key: Buffer | null = null,
): Promise<RedoReport> {
```

(c) In Phase 1, change the `buildArticleInputForThread` call to pass `key` as the 7th argument:

```ts
    const input = buildArticleInputForThread(
      be.threadId,
      be.title,
      be.sessionIds,
      indexFile,
      repoRoot,
      "redo.ts",
      key,
    );
```

### Step 2.3 — `src/commands/sync.ts`

- [ ] **Pass key to runDigest; remove `skipped-encrypted` branch**

(a) Change the `DigestStatus` type on line 35 to drop `"skipped-encrypted"`:

```ts
export type DigestStatus = "ok" | "skipped-flag" | "skipped-no-runner" | "failed" | "not-attempted";
```

(b) In `runSync`, locate the gating cascade `if (opts.noDigest) ... else if (opts.encrypt) ...`. Delete the entire `else if (opts.encrypt)` branch (4 lines including the warning console.log). The cascade now jumps straight from the `noDigest` branch to the `!opts.runnerConfig` branch.

(c) Inside the `else` branch where `runDigest` is called, find:

```ts
      digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex);
```

Replace with:

```ts
      digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex, key);
```

(`key` is the local already declared at the top of `runSync` from `deriveKey(...)`).

(d) In `syncCmd`, remove the entire `else if (r.digestStatus === "skipped-encrypted")` branch (2 lines: the conditional + the chalk.yellow console.log).

### Step 2.4 — `src/commands/digest.ts`

- [ ] **Derive key when encrypted, pass to redo; remove encrypted-skip branch**

(a) Add to the imports:

```ts
import { Buffer } from "node:buffer";
import { deriveKey } from "../crypto.js";
import { getPassphrase } from "../config.js";
```

(b) In `digestCmd`, **delete** the `if (cfg.encrypt) { ... return; }` block entirely.

(c) After `const cfg = readConfig();`, add key derivation:

```ts
  const key = cfg.encrypt
    ? deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64"))
    : null;
```

(d) In the call to `runDigestRedoFromRepo`, add `key` to the args object:

```ts
  const report = await runDigestRedoFromRepo({
    repoPath: cfg.repoPath,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
    key,
  });
```

(e) Update the `runDigestRedoFromRepo` signature to accept `key`:

```ts
export async function runDigestRedoFromRepo(args: {
  repoPath: string;
  runnerConfig: Pick<Config, "runner" | "runnerModel">;
  /** Test-only override for createRunner. */
  runner?: LlmRunner;
  /** AES key (when raw is encrypted); null/omitted otherwise. */
  key?: Buffer | null;
}): Promise<RedoReport> {
  const idx = loadIndex(args.repoPath);
  const book = loadBookIndex(args.repoPath);
  const runner = args.runner ?? createRunner(args.runnerConfig);
  const report = await runDigestRedo(runner, args.repoPath, idx, book, args.key ?? null);
  saveBookIndex(args.repoPath, book);
  return report;
}
```

### Step 2.5 — Update `tests/commands/sync.test.ts`

- [ ] **Replace the "encrypt skipped" test with an "encrypted digest runs" test**

In `tests/commands/sync.test.ts`, find the test currently named `"with encrypt=true: digest is skipped with status skipped-encrypted"` inside `describe("runSync — digest integration", ...)`. **Replace** it with:

```ts
  it("with encrypt=true + valid passphrase: digest runs end-to-end against encrypted raw", async () => {
    // Stage the same canned LLM responses as the happy-path test.
    const queue: RunResult[] = [
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-enc", title: "加密", sessionIds: [extractedSessionId(repo, claudeRoot)] },
      ])},
      { ok: true, durationMs: 1, text: "# 加密\n\n文章。" },
      { ok: true, durationMs: 1, text: "# edge-memvc\n\n章。" },
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
        repoPath: repo, claudeRoot, vscodeRoot,
        encrypt: true,
        passphrase: "test-pass",
        saltB64: Buffer.from("0123456789abcdef").toString("base64"),
        runnerConfig: { runner: "claude-cli", runnerModel: "" },
      });
      expect(r.digestStatus).toBe("ok");
      expect(r.digestReport!.articlesOk).toBe(1);
      expect(r.digestReport!.chaptersRewritten).toEqual(["edge-memvc"]);
      // Article + chapter are plaintext on disk.
      expect(existsSync(join(repo, "book/edge-memvc/chapter.md"))).toBe(true);
      // Raw session is encrypted on disk.
      const idxFile = loadIndex(repo);
      const entry = Object.values(idxFile.entries)[0]!;
      expect(entry.relativePath).toMatch(/\.enc$/);
    } finally {
      spy.mockRestore();
    }
  });
```

(You may need to add `import { loadIndex } from "../../src/index-store.js";` to the top imports if not already present.)

### Step 2.6 — Run + commit

- [ ] **Run `npm test`** — full suite green. (Was 162 from Task 1; one test renamed/retargeted, no count change → still 162.)
- [ ] **Run `npm run build`** — clean.
- [ ] **Commit**:

```bash
git add src/digest/orchestrator.ts src/digest/redo.ts src/commands/sync.ts src/commands/digest.ts tests/commands/sync.test.ts
git commit -m "feat(sync,digest): run digest pipeline against encrypted raw using derived AES key"
```

---

## Task 3: Manual smoke + final verification

- [ ] **Step 3.1: Manual smoke test**

```bash
npm run build
export MEMVC_PASSPHRASE='your-actual-passphrase'
memvc sync
```

Expected output: no `Digest pipeline skipped: encrypted raw is not yet supported` line. The summary should now show `+N articles` and `+M chapters` instead of `Digest skipped (encrypted mode).`. After the run, `book/<project>/chapter.md` files should exist on disk.

- [ ] **Step 3.2: If smoke is clean, no further commits.** If something breaks, file findings; otherwise, this fix is complete. Sprint roadmap is unaffected (this is a bugfix, not a sprint deliverable).

---

## Self-Review Checklist (already applied)

- **Spec coverage:**
  - Spec line "raw 走加密；book 永远 plaintext" → preserved: `chapter.ts` and `article.ts` continue to read/write only `book/**` plaintext; only `pipeline.ts` decrypts inputs.
  - Sprint 2.8.3's "encrypted-pipeline support is a future sprint" deferral → resolved here.

- **Placeholder scan:** Every code step has full code; no TBD; no "similar to"; no "add validation".

- **Type consistency:**
  - `Buffer | null` used uniformly across `pipeline.ts` / `orchestrator.ts` / `redo.ts` / `sync.ts` / `digest.ts`.
  - `key` parameter is always optional with `= null` default to preserve existing callers (e.g., other tests).
  - `DigestStatus` union pruned to remove `"skipped-encrypted"`; no remaining references to it after Task 2.
  - `runDigestRedoFromRepo` keeps its `runner` test-injection field; new `key` field is sibling-optional.

- **Backwards compatibility:**
  - All new params default to `null`/`undefined` so the existing 159 tests that pass `(runner, repoRoot, idx, bookIndex)` without a key still compile and behave as before.
  - Encrypted-mode behavior changes from "silently skip digest" to "actually run digest" — this is the explicit goal, not a regression.

- **Out of scope (deliberately):**
  - Encrypted `book/` outputs — spec mandates plaintext.
  - Key rotation / re-encryption of existing files.
  - Per-session keys / multi-passphrase support.
  - Anthropic-API runner encrypted-mode quirks (those runners are stubs anyway).

- **Test brittleness:**
  - The new sync test reuses `extractedSessionId` (parses fixture's first JSONL line); already validated by sibling tests.
  - The pipeline encryption tests use a deterministic salt + pass to keep runs reproducible.
