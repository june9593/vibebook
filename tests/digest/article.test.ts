import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateArticle, ARTICLE_VERSION, articleFilename } from "../../src/digest/article.js";
import { saveBookIndex, loadBookIndex } from "../../src/digest/book-index.js";
import type { BookIndex } from "../../src/digest/book-index.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { silentReporter } from "../../src/digest/reporter.js";

function fakeRunner(reply: RunResult): LlmRunner {
  return { run: async () => reply };
}

function emptyIndex(): BookIndex {
  return { version: 1, threads: {}, chapters: {} };
}

function baseInput() {
  return {
    threadId: "fix-auth-bug",
    project: "edge-memvc",
    title: "修 auth 跳转",
    sessionIds: ["s1", "s2"],
    sessionShas: ["sha-s1", "sha-s2"],
    sessionsMd: "## session 1\n...\n## session 2\n...",
    endedAt: "2026-04-15T10:30:00Z",
  };
}

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "memvc-article-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("articleFilename", () => {
  it("produces book/<project>/articles/YYYY-MM-DD__<threadSlug>__<tid8>.md", () => {
    expect(articleFilename(baseInput())).toBe(
      "book/edge-memvc/articles/2026-04-15__fix-auth-bug__fix-auth.md",
    );
  });

  it("uses the first 8 chars of threadId for the tid8 segment, even for short slugs", () => {
    const f = articleFilename({ ...baseInput(), threadId: "fix" });
    expect(f).toBe("book/edge-memvc/articles/2026-04-15__fix__fix.md");
  });
});

describe("generateArticle — happy path", () => {
  it("writes the markdown body verbatim and updates BookIndex with status=ok", async () => {
    const body = "# 修 auth 跳转\n\n背景...\n\n## 附：原始对话\n- raw_sessions/...";
    const runner = fakeRunner({ ok: true, text: body, durationMs: 1 });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx, silentReporter());

    expect(res.status).toBe("ok");
    expect(res.articlePath).toBe(
      "book/edge-memvc/articles/2026-04-15__fix-auth-bug__fix-auth.md",
    );

    const written = readFileSync(join(repoRoot, res.articlePath!), "utf8");
    expect(written).toBe(body);

    const entry = idx.threads["fix-auth-bug"];
    expect(entry).toBeDefined();
    expect(entry.articleStatus).toBe("ok");
    expect(entry.articlePath).toBe(res.articlePath);
    expect(entry.articleVersion).toBe(ARTICLE_VERSION);
    expect(entry.sessionIds).toEqual(["s1", "s2"]);
    expect(entry.title).toBe("修 auth 跳转");
    expect(entry.project).toBe("edge-memvc");
    expect(entry.skip).toBeUndefined();
    expect(entry.articleError).toBeUndefined();
    expect(entry.latestSourceSha).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls the runner with outputFormat:'text' and the rendered prompt vars", async () => {
    let capturedVars: Record<string, string> | undefined;
    let capturedOpts: { outputFormat?: string } | undefined;
    const runner: LlmRunner = {
      run: async (_p, vars, opts) => {
        capturedVars = vars;
        capturedOpts = opts;
        return { ok: true, text: "# t\n\nbody", durationMs: 1 };
      },
    };
    await generateArticle(runner, repoRoot, baseInput(), emptyIndex(), silentReporter());
    expect(capturedOpts?.outputFormat).toBe("text");
    expect(capturedVars?.title).toBe("修 auth 跳转");
    expect(capturedVars?.sessionsMd).toBe("## session 1\n...\n## session 2\n...");
  });
});

describe("generateArticle — SKIP sentinel", () => {
  it("does not write a file, marks BookEntry skip:true with skipReason, returns status=skipped", async () => {
    const runner = fakeRunner({
      ok: true,
      text: "SKIP: 内容只有几句寒暄，没有工程价值",
      durationMs: 1,
    });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx, silentReporter());

    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("内容只有几句寒暄，没有工程价值");

    // No article file should exist.
    expect(existsSync(join(repoRoot, "book", "edge-memvc", "articles"))).toBe(false);

    const entry = idx.threads["fix-auth-bug"];
    expect(entry.skip).toBe(true);
    expect(entry.skipReason).toBe("内容只有几句寒暄，没有工程价值");
    expect(entry.articleStatus).toBe("ok");
    expect(entry.articlePath).toBe("");
  });

  it("tolerates leading whitespace before SKIP:", async () => {
    const runner = fakeRunner({ ok: true, text: "  \n  SKIP: 太短", durationMs: 1 });
    const res = await generateArticle(runner, repoRoot, baseInput(), emptyIndex(), silentReporter());
    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("太短");
  });

  it("does NOT trigger SKIP when the body merely contains 'SKIP:' mid-text", async () => {
    const runner = fakeRunner({
      ok: true,
      text: "# 标题\n\n这里讨论了 SKIP: 标志的实现",
      durationMs: 1,
    });
    const res = await generateArticle(runner, repoRoot, baseInput(), emptyIndex(), silentReporter());
    expect(res.status).toBe("ok");
  });
});

describe("generateArticle — failure path", () => {
  it("on runner ok:false, sets articleStatus=failed + articleError and returns failed (does NOT throw)", async () => {
    const runner = fakeRunner({ ok: false, error: "timeout after 180s", durationMs: 180_000 });
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, baseInput(), idx, silentReporter());

    expect(res.status).toBe("failed");
    expect(res.error).toBe("timeout after 180s");

    const entry = idx.threads["fix-auth-bug"];
    expect(entry.articleStatus).toBe("failed");
    expect(entry.articleError).toBe("timeout after 180s");
    expect(entry.articlePath).toBe("");
  });

  it("on filesystem write error, returns failed and marks BookEntry without throwing", async () => {
    // Force a write error by making the project segment something the FS rejects.
    // Use a NUL byte — illegal in posix paths.
    const runner = fakeRunner({ ok: true, text: "# t\n\nbody", durationMs: 1 });
    const input = { ...baseInput(), project: "bad\0name" };
    const idx = emptyIndex();

    const res = await generateArticle(runner, repoRoot, input, idx, silentReporter());

    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/.+/); // non-empty
    const entry = idx.threads["fix-auth-bug"];
    expect(entry.articleStatus).toBe("failed");
  });
});

describe("generateArticle — index persistence integration", () => {
  it("BookEntry survives saveBookIndex → loadBookIndex round-trip", async () => {
    const runner = fakeRunner({ ok: true, text: "# t\n\nbody", durationMs: 1 });
    const idx = emptyIndex();
    await generateArticle(runner, repoRoot, baseInput(), idx, silentReporter());
    saveBookIndex(repoRoot, idx);
    const loaded = loadBookIndex(repoRoot);
    expect(loaded.threads["fix-auth-bug"].articleStatus).toBe("ok");
    expect(loaded.threads["fix-auth-bug"].articleVersion).toBe(ARTICLE_VERSION);
  });
});
