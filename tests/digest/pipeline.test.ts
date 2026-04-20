import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  findNewSessionEntries,
  buildBatchingInput,
  recordSkippedThreadCandidates,
  buildArticleInputs,
} from "../../src/digest/pipeline.js";
import { encrypt as encryptBuf, deriveKey } from "../../src/crypto.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex, BookEntry } from "../../src/digest/book-index.js";
import type { ThreadCandidate } from "../../src/digest/types.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-pipeline-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function ie(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    sessionId: "sid-1",
    shortId: "sid-1",
    tool: "claude" as Tool,
    project: "proj-a",
    startedAt: "2026-04-15T09:00:00Z",
    endedAt: "2026-04-15T10:00:00Z",
    nameSlug: "first-session",
    displayName: "First session",
    relativePath: "raw_sessions/claude/proj-a/2026-04-15/first-session__sid-1.md",
    sourcePath: "/tmp/orig/first.jsonl",
    sourceMtimeMs: 1_000_000,
    sourceSha256: "shaA",
    ...over,
  };
}

function be(over: Partial<BookEntry> = {}): BookEntry {
  return {
    threadId: "t1",
    project: "proj-a",
    title: "标题",
    sessionIds: ["sid-1"],
    articlePath: "book/proj-a/articles/2026-04-15__t1__t1.md",
    articleVersion: 1,
    latestSourceSha: "deadbeef",
    articleStatus: "ok",
    updatedAt: "2026-04-15T10:00:00Z",
    ...over,
  };
}

function makeIndex(entries: IndexEntry[]): IndexFile {
  const out: IndexFile = { version: 1, entries: {} };
  for (const e of entries) out.entries[`${e.tool}:${e.sessionId}`] = e;
  return out;
}

function writeSessionMd(rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

// =====================================================================
describe("findNewSessionEntries", () => {
  it("returns empty when every IndexEntry sessionId appears in some BookEntry", () => {
    const e = ie({ sessionId: "sid-1" });
    const idx = makeIndex([e]);
    const book: BookIndex = {
      version: 1,
      threads: { t1: be({ sessionIds: ["sid-1"] }) },
      chapters: {},
    };
    expect(findNewSessionEntries(idx, book)).toEqual([]);
  });

  it("returns entries whose sessionId is NOT in any BookEntry.sessionIds", () => {
    const e1 = ie({ sessionId: "sid-1", endedAt: "2026-04-15T10:00:00Z" });
    const e2 = ie({ sessionId: "sid-2", endedAt: "2026-04-16T10:00:00Z" });
    const idx = makeIndex([e1, e2]);
    const book: BookIndex = {
      version: 1,
      threads: { t1: be({ sessionIds: ["sid-1"] }) },
      chapters: {},
    };
    const got = findNewSessionEntries(idx, book);
    expect(got.map((x) => x.sessionId)).toEqual(["sid-2"]);
  });

  it("returns all entries when bookIndex is empty", () => {
    const e1 = ie({ sessionId: "sid-1", endedAt: "2026-04-15T10:00:00Z" });
    const e2 = ie({ sessionId: "sid-2", endedAt: "2026-04-14T10:00:00Z" });
    const idx = makeIndex([e1, e2]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const got = findNewSessionEntries(idx, book);
    // Sorted by endedAt ASC.
    expect(got.map((x) => x.sessionId)).toEqual(["sid-2", "sid-1"]);
  });

  it("considers an IndexEntry covered if ANY thread's sessionIds contain it (not just one project)", () => {
    const e1 = ie({ sessionId: "sid-1" });
    const idx = makeIndex([e1]);
    const book: BookIndex = {
      version: 1,
      threads: {
        ta: be({ threadId: "ta", project: "proj-a", sessionIds: ["other"] }),
        tb: be({ threadId: "tb", project: "proj-b", sessionIds: ["sid-1"] }),
      },
      chapters: {},
    };
    expect(findNewSessionEntries(idx, book)).toEqual([]);
  });
});

// =====================================================================
describe("buildBatchingInput", () => {
  it("reads each session's .md, sets project/endedAt, and computes ceil(charCount/3.5) tokens", () => {
    const body = "x".repeat(35); // 35 chars → ceil(35/3.5) = 10 tokens
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/x.md" });
    writeSessionMd(e.relativePath, body);
    const got = buildBatchingInput([e], repoRoot, null);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      sessionId: e.sessionId,
      project: e.project,
      endedAt: e.endedAt,
      tokenEstimate: 10,
    });
  });

  it("rounds up partial token estimates", () => {
    const body = "x".repeat(36); // 36/3.5 = 10.28 → 11
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/y.md" });
    writeSessionMd(e.relativePath, body);
    const got = buildBatchingInput([e], repoRoot, null);
    expect(got[0]!.tokenEstimate).toBe(11);
  });

  it("processes multiple entries preserving input order", () => {
    const e1 = ie({ sessionId: "s1", relativePath: "raw_sessions/c/p/2026-04-15/a.md" });
    const e2 = ie({ sessionId: "s2", relativePath: "raw_sessions/c/p/2026-04-15/b.md" });
    writeSessionMd(e1.relativePath, "aa");
    writeSessionMd(e2.relativePath, "bbb");
    const got = buildBatchingInput([e1, e2], repoRoot, null);
    expect(got.map((x) => x.sessionId)).toEqual(["s1", "s2"]);
  });

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

  it("throws clearly when a session's .md is missing on disk", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/missing.md" });
    expect(() => buildBatchingInput([e], repoRoot, null)).toThrow(/missing\.md/);
  });

  it("buildBatchingInput attaches signals from extractSessionSignals", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/2026-04-15/x.md" });
    writeSessionMd(e.relativePath, `# Disp\n\n## User\n\nfix bug, learn from architecture decision\n`);
    const got = buildBatchingInput([e], repoRoot, null);
    expect(got[0]!.title).toContain("fix bug");
    expect(got[0]!.preview).toBeTruthy();
    expect(got[0]!.insightScore).toBeGreaterThan(0);
  });
});

// =====================================================================
describe("recordSkippedThreadCandidates", () => {
  it("upserts a skip:true BookEntry for each skip candidate, leaves non-skip alone", () => {
    const idx = makeIndex([
      ie({ sessionId: "sid-1", project: "proj-a" }),
      ie({ sessionId: "sid-2", project: "proj-a" }),
    ]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const cands: ThreadCandidate[] = [
      { threadId: "skip-thread", title: "略过", sessionIds: ["sid-1"], skip: true, reason: "太短" },
      { threadId: "keep-thread", title: "保留", sessionIds: ["sid-2"] },
    ];
    const skipped = recordSkippedThreadCandidates(book, cands, idx);
    expect(skipped).toEqual(["skip-thread"]);
    expect(book.threads["skip-thread"]).toMatchObject({
      threadId: "skip-thread",
      project: "proj-a",
      title: "略过",
      sessionIds: ["sid-1"],
      articlePath: "",
      articleStatus: "ok",
      skip: true,
      skipReason: "太短",
    });
    expect(book.threads["keep-thread"]).toBeUndefined();
  });

  it("skip BookEntry's project is taken from the first session's IndexEntry", () => {
    const idx = makeIndex([ie({ sessionId: "sid-1", project: "from-index" })]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    recordSkippedThreadCandidates(
      book,
      [{ threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "x" }],
      idx,
    );
    expect(book.threads["t"]!.project).toBe("from-index");
  });

  it("skip BookEntry has updatedAt set to an ISO string", () => {
    const idx = makeIndex([ie({ sessionId: "sid-1" })]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    recordSkippedThreadCandidates(
      book,
      [{ threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "" }],
      idx,
    );
    expect(book.threads["t"]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("warns and falls back to project=unknown when the first sessionId is not in indexFile", () => {
    const idx = makeIndex([]);
    const book: BookIndex = { version: 1, threads: {}, chapters: {} };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordSkippedThreadCandidates(
      book,
      [{ threadId: "ghost", title: "", sessionIds: ["nope"], skip: true, reason: "x" }],
      idx,
    );
    expect(book.threads["ghost"]!.project).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost/));
    warn.mockRestore();
  });
});

// =====================================================================
describe("buildArticleInputs", () => {
  it("produces an ArticleInput per non-skip candidate, joining session bodies in endedAt ASC order", () => {
    const eOld = ie({
      sessionId: "old", shortId: "old",
      relativePath: "raw_sessions/c/p/2026-04-10/old.md",
      sourceSha256: "shaOld",
      endedAt: "2026-04-10T10:00:00Z",
    });
    const eNew = ie({
      sessionId: "new", shortId: "new",
      relativePath: "raw_sessions/c/p/2026-04-15/new.md",
      sourceSha256: "shaNew",
      endedAt: "2026-04-15T10:00:00Z",
    });
    writeSessionMd(eOld.relativePath, "OLD BODY");
    writeSessionMd(eNew.relativePath, "NEW BODY");
    const idx = makeIndex([eOld, eNew]);
    const cands: ThreadCandidate[] = [
      { threadId: "t1", title: "题", sessionIds: ["new", "old"] }, // intentionally out of order
    ];
    const got = buildArticleInputs(cands, idx, repoRoot, null);
    expect(got).toHaveLength(1);
    const input = got[0]!;
    expect(input.threadId).toBe("t1");
    expect(input.project).toBe("proj-a");
    expect(input.title).toBe("题");
    // sessionIds reordered to endedAt ASC.
    expect(input.sessionIds).toEqual(["old", "new"]);
    expect(input.sessionShas).toEqual(["shaOld", "shaNew"]);
    // sessionsMd: old comes first, joined with separator referencing the session.
    expect(input.sessionsMd.indexOf("OLD BODY")).toBeLessThan(input.sessionsMd.indexOf("NEW BODY"));
    expect(input.sessionsMd).toMatch(/--- SESSION old/);
    expect(input.sessionsMd).toMatch(/--- SESSION new/);
    // endedAt = max.
    expect(input.endedAt).toBe("2026-04-15T10:00:00Z");
  });

  it("excludes skip candidates", () => {
    const e = ie({ relativePath: "raw_sessions/c/p/x/y.md" });
    writeSessionMd(e.relativePath, "body");
    const idx = makeIndex([e]);
    const cands: ThreadCandidate[] = [
      { threadId: "t", title: "", sessionIds: ["sid-1"], skip: true, reason: "x" },
    ];
    expect(buildArticleInputs(cands, idx, repoRoot, null)).toEqual([]);
  });

  it("throws when a candidate's sessions span multiple projects", () => {
    const eA = ie({ sessionId: "a", project: "proj-a", relativePath: "raw_sessions/c/a/x/a.md" });
    const eB = ie({ sessionId: "b", project: "proj-b", relativePath: "raw_sessions/c/b/x/b.md" });
    writeSessionMd(eA.relativePath, "a");
    writeSessionMd(eB.relativePath, "b");
    const idx = makeIndex([eA, eB]);
    const cands: ThreadCandidate[] = [
      { threadId: "mixed", title: "", sessionIds: ["a", "b"] },
    ];
    expect(() => buildArticleInputs(cands, idx, repoRoot, null)).toThrow(/multiple projects/);
  });

  it("warns and drops only the bad candidate, keeping siblings", () => {
    const eReal = ie({ sessionId: "real", relativePath: "raw_sessions/c/p/x/r.md", sourceSha256: "shaR" });
    const eOk = ie({ sessionId: "ok", relativePath: "raw_sessions/c/p/x/o.md", sourceSha256: "shaO" });
    writeSessionMd(eReal.relativePath, "x");
    writeSessionMd(eOk.relativePath, "y");
    const idx = makeIndex([eReal, eOk]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cands: ThreadCandidate[] = [
      { threadId: "ghost", title: "", sessionIds: ["real", "missing-from-index"] },
      { threadId: "good", title: "ok", sessionIds: ["ok"] },
    ];
    const got = buildArticleInputs(cands, idx, repoRoot, null);
    expect(got.map((x) => x.threadId)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost/));
    warn.mockRestore();
  });

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
});
