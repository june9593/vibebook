import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDigestRedoFromRepo } from "../../src/commands/digest.js";
import { saveBookIndex, loadBookIndex } from "../../src/digest/book-index.js";
import { saveIndex } from "../../src/index-store.js";
import type { IndexFile, IndexEntry, Tool } from "../../src/types.js";
import type { BookIndex } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { ARTICLE_VERSION } from "../../src/digest/article.js";

describe("runDigestRedoFromRepo (integration)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-cmd-redo-"));
  });

  it("loads IndexFile + BookIndex from disk, runs redo, persists BookIndex", async () => {
    // Stage: a session on disk + IndexFile + BookEntry marked failed.
    const ie: IndexEntry = {
      sessionId: "sid-1", shortId: "sid-1", tool: "claude" as Tool,
      project: "proj-a",
      startedAt: "2026-04-15T09:00:00Z", endedAt: "2026-04-15T10:00:00Z",
      nameSlug: "first", displayName: "First",
      relativePath: "raw_sessions/c/proj-a/2026-04-15/first__sid-1.md",
      sourcePath: "/tmp/x.jsonl", sourceMtimeMs: 1, sourceSha256: "shaA",
    };
    mkdirSync(join(repo, "raw_sessions/c/proj-a/2026-04-15"), { recursive: true });
    writeFileSync(join(repo, ie.relativePath), "session body");
    const idx: IndexFile = { version: 1, entries: { [`claude:sid-1`]: ie } };
    saveIndex(repo, idx);
    const book: BookIndex = {
      version: 1,
      threads: {
        "t-fail": {
          threadId: "t-fail", project: "proj-a", title: "失败",
          sessionIds: ["sid-1"],
          articlePath: "", articleVersion: ARTICLE_VERSION, latestSourceSha: "shaA",
          articleStatus: "failed", updatedAt: "2026-04-10T00:00:00Z",
        },
      },
      chapters: {},
    };
    saveBookIndex(repo, book);

    const queue: RunResult[] = [
      { ok: true, durationMs: 1, text: "# 失败\n\n这次成功。" },
      { ok: true, durationMs: 1, text: "# proj-a\n\n章。" },
    ];
    const fakeRunner: LlmRunner = {
      async run() {
        const n = queue.shift();
        if (!n) throw new Error("exhausted");
        return n;
      },
    };

    const report = await runDigestRedoFromRepo({
      repoPath: repo,
      runnerConfig: { runner: "claude-cli", runnerModel: "" },
      runner: fakeRunner, // injection point used only by tests
    });

    expect(report.threadsRecovered).toBe(1);
    expect(report.chaptersRewritten).toEqual(["proj-a"]);
    // BookIndex was persisted.
    const reloaded = loadBookIndex(repo);
    expect(reloaded.threads["t-fail"]!.articleStatus).toBe("ok");
    expect(reloaded.chapters["proj-a"]).toBeDefined();
    // Files exist.
    expect(existsSync(join(repo, "book/proj-a/chapter.md"))).toBe(true);
    expect(existsSync(join(repo, "book/index.md"))).toBe(true);
  });

  it("returns a report with threadsRecovered=0 when there are no failed threads", async () => {
    saveIndex(repo, { version: 1, entries: {} });
    saveBookIndex(repo, { version: 1, threads: {}, chapters: {} });

    const fakeRunner: LlmRunner = { async run() { throw new Error("not called"); } };
    const report = await runDigestRedoFromRepo({
      repoPath: repo,
      runnerConfig: { runner: "claude-cli", runnerModel: "" },
      runner: fakeRunner,
    });
    expect(report.threadsAttempted).toBe(0);
    expect(report.tocFilesWritten).toContain("book/index.md");
  });
});
