import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { runSync, ensureDeviceBranchOnConfig } from "../../src/commands/sync.js";
import { loadIndex } from "../../src/index-store.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { loadBookIndex } from "../../src/digest/book-index.js";
import type { Config } from "../../src/config.js";

function baseCfg(overrides: Partial<Config> = {}): Config {
  return {
    repoPath: "/tmp/x",
    repoUrl: "git@example.com:x.git",
    encrypt: false,
    salt: "AAAA",
    deviceBranch: "",
    runner: "claude-cli",
    runnerModel: "",
    threadingConcurrency: 4,
    threadingMaxAttempts: 3,
    ...overrides,
  };
}

describe("ensureDeviceBranchOnConfig", () => {
  it("migrates when deviceBranch is empty string", () => {
    const r = ensureDeviceBranchOnConfig(baseCfg({ deviceBranch: "" }));
    expect(r.migrated).toBe(true);
    expect(r.cfg.deviceBranch.length).toBeGreaterThan(0);
  });
  it("no-op when deviceBranch is set", () => {
    const r = ensureDeviceBranchOnConfig(baseCfg({ deviceBranch: "my-device" }));
    expect(r.migrated).toBe(false);
    expect(r.cfg.deviceBranch).toBe("my-device");
  });
});

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

  it("with noDigest=false but no runnerConfig: digest is skipped with skipped-no-runner status", async () => {
    const r = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
    });
    // No runnerConfig provided → digest skipped silently (treated like --no-digest).
    expect(r.digestStatus).toBe("skipped-no-runner");
    expect(existsSync(join(repo, "book"))).toBe(false);
  });

  it("with noDigest=false + fake runner: writes book/ files and saves BookIndex", async () => {
    const sessionId = await discoverSessionId(claudeRoot, vscodeRoot);
    // Stage canned LLM responses for: 1 thread, 1 article, 1 chapter.
    const canned: RunResult[] = [
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-int", title: "集成", sessionIds: [sessionId] },
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

  it("with encrypt=true + valid passphrase: digest runs end-to-end against encrypted raw", async () => {
    const sessionId = await discoverSessionId(claudeRoot, vscodeRoot);
    // Stage the same canned LLM responses as the happy-path test.
    const queue: RunResult[] = [
      { ok: true, durationMs: 1, text: JSON.stringify([
        { threadId: "t-enc", title: "加密", sessionIds: [sessionId] },
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

  it("with noDigest=false + fake runner returning failed thread: threading batch soft-fails, digest still ok", async () => {
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runSync({
        repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
        runnerConfig: { runner: "claude-cli", runnerModel: "" },
        threadingMaxAttempts: 1,
      });
      expect(r.digestStatus).toBe("ok");
      expect(r.digestReport!.threadingBatchesFailed).toBe(1);
      expect(r.digestReport!.articlesOk).toBe(0);
      // Toc still ran, so book/index.md exists; but no per-project chapter.
      expect(existsSync(join(repo, "book/edge-memvc"))).toBe(false);
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }
  });
});

/**
 * Discover the sessionId by running a one-shot no-digest sync into a temp
 * directory, then reading it from the resulting IndexFile. Decoupled from
 * fixture format — survives any change to the JSONL shape that the adapter
 * still understands.
 */
async function discoverSessionId(claudeRoot: string, vscodeRoot: string): Promise<string> {
  const probeRepo = mkdtempSync(join(tmpdir(), "memvc-probe-"));
  try {
    await runSync({
      repoPath: probeRepo, claudeRoot, vscodeRoot, encrypt: false, noDigest: true,
    });
    const idx = loadIndex(probeRepo);
    const ids = Object.values(idx.entries).map((e) => e.sessionId);
    if (ids.length !== 1) {
      throw new Error(`discoverSessionId expected exactly 1 entry, got ${ids.length}`);
    }
    return ids[0]!;
  } finally {
    rmSync(probeRepo, { recursive: true, force: true });
  }
}
