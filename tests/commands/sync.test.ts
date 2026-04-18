import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { runSync } from "../../src/commands/sync.js";
import { loadIndex } from "../../src/index-store.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { loadBookIndex } from "../../src/digest/book-index.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

describe("runSync", () => {
  let repo: string;
  let claudeRoot: string;
  let vscodeRoot: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-repo-"));
    claudeRoot = mkdtempSync(join(tmpdir(), "memvc-claude-"));
    // put the claude fixture under claudeRoot/<project>
    const proj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
    // empty vscode root
    vscodeRoot = mkdtempSync(join(tmpdir(), "memvc-vscode-"));
  });

  it("extracts new sessions, writes files, updates index", async () => {
    const result = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
    });
    expect(result.newCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    const idx = loadIndex(repo);
    expect(Object.keys(idx.entries).length).toBe(1);
    const entry = Object.values(idx.entries)[0]!;
    expect(existsSync(join(repo, entry.relativePath))).toBe(true);
    // Markdown sibling exists
    const mdPath = entry.relativePath.replace(".raw.json", ".md");
    expect(existsSync(join(repo, mdPath))).toBe(true);
  });

  it("skips unchanged sessions on second run", async () => {
    await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    const result2 = await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    expect(result2.newCount).toBe(0);
    expect(result2.skippedCount).toBe(1);
  });
});

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
 * Helper: parse the fixture's first JSONL line (a meta header containing
 * `sessionId`) and return that uuid. Verified: the fixture's first line is
 * `{"type":"permission-mode",...,"sessionId":"abc12345-..."}` — stable.
 */
function extractedSessionId(_repo: string, _claudeRoot: string): string {
  const fixture = readFileSync(join(fixturesDir, "claude-session.jsonl"), "utf8");
  const firstLine = fixture.split("\n", 1)[0]!;
  const obj = JSON.parse(firstLine) as { sessionId?: string };
  if (!obj.sessionId) {
    throw new Error("fixture has no sessionId on its first line — adjust extractedSessionId helper");
  }
  return obj.sessionId;
}
