import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";

/**
 * Integration test for assets/scripts/merge-books.mjs.
 *
 * Sets up a fake bare remote with two device branches, each carrying a
 * .vibebook/index.book.json + book/<proj>/articles/ + book/<proj>/chapter.md.
 * Runs merge-books.mjs on a clone of main (orphan-created here) and asserts:
 *   - article files are copied, deduped by threadId, latest-updatedAt wins
 *   - each device's chapter.md becomes book/<proj>/chapter.<device>.md
 *   - book/index.md + book/_meta/timeline.md are regenerated
 *   - commit is created on main
 */

const SCRIPT_PATH = new URL("../../assets/scripts/merge-books.mjs", import.meta.url).pathname;

interface BranchSeed {
  device: string;
  /** project → article-path → { title, threadId, updatedAt, body } */
  articles: Record<string, Record<string, {
    threadId: string;
    title: string;
    updatedAt: string;
    body: string;
  }>>;
  /** project → chapter body */
  chapters: Record<string, string>;
}

let bareRemote: string;
let workspace: string;

async function setupBranch(seed: BranchSeed): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `vibebook-merge-seed-${seed.device}-`));
  await simpleGit().clone(bareRemote, dir);
  const g = simpleGit(dir);
  await g.addConfig("user.email", "t@example.com");
  await g.addConfig("user.name", "Tester");
  try {
    await g.checkout(["-b", seed.device]);
  } catch {
    await g.checkout(seed.device);
  }

  // Build BookIndex + article files.
  const bookIndex = {
    version: 1,
    threads: {} as Record<string, unknown>,
    chapters: {} as Record<string, { chapterVersion: number; lastFullRewrite: string; latestArticleHash: string }>,
  };
  for (const [project, articles] of Object.entries(seed.articles)) {
    for (const [articlePath, info] of Object.entries(articles)) {
      const absPath = join(dir, articlePath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, info.body);
      bookIndex.threads[info.threadId] = {
        threadId: info.threadId,
        project,
        title: info.title,
        sessionIds: [`sess-${info.threadId}`],
        articlePath,
        articleVersion: 2,
        latestSourceSha: "shafake",
        articleStatus: "ok",
        updatedAt: info.updatedAt,
      };
    }
    if (seed.chapters[project]) {
      writeFileSync(join(dir, `book/${project}/chapter.md`), seed.chapters[project]);
      bookIndex.chapters[project] = {
        chapterVersion: 1,
        lastFullRewrite: "2026-04-23T00:00:00.000Z",
        latestArticleHash: "hashfake",
      };
    }
  }
  mkdirSync(join(dir, ".vibebook"), { recursive: true });
  writeFileSync(join(dir, ".vibebook", "index.book.json"), JSON.stringify(bookIndex, null, 2));

  await g.add(".");
  await g.commit(`seed ${seed.device}`);
  await g.push("origin", seed.device, ["-u"]);
  rmSync(dir, { recursive: true, force: true });
}

async function setupMainOrphan(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vibebook-merge-main-seed-"));
  await simpleGit().clone(bareRemote, dir);
  const g = simpleGit(dir);
  await g.addConfig("user.email", "t@example.com");
  await g.addConfig("user.name", "Tester");
  await g.checkout(["--orphan", "main"]);
  await g.raw(["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
  writeFileSync(join(dir, ".keep"), "initial\n");
  await g.add(".keep");
  await g.commit("init main");
  await g.push("origin", "main", ["-u"]);
  rmSync(dir, { recursive: true, force: true });
}

beforeEach(async () => {
  bareRemote = mkdtempSync(join(tmpdir(), "vibebook-merge-bare-"));
  await simpleGit(bareRemote).init({ "--bare": null });
  // Seed main first so device branches clone from a non-empty remote.
  await setupMainOrphan();
  workspace = mkdtempSync(join(tmpdir(), "vibebook-merge-work-"));
});

afterEach(() => {
  rmSync(bareRemote, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function runMerge(): Promise<{ clone: string }> {
  // Clone main into workspace, switch to main, run the script, return path.
  await simpleGit().clone(bareRemote, workspace);
  const g = simpleGit(workspace);
  await g.addConfig("user.email", "bot@example.com");
  await g.addConfig("user.name", "vibebook-bot");
  await g.checkout("main");
  execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe" });
  return { clone: workspace };
}

describe("merge-books.mjs", () => {
  it("merges articles from two devices, dedupes by threadId (latest-updatedAt wins)", async () => {
    await setupBranch({
      device: "Mac.lan",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-20__thread-shared__t1234567.md": {
            threadId: "thread-shared",
            title: "Shared thread (Mac.lan older)",
            updatedAt: "2026-04-20T10:00:00.000Z",
            body: "# Old version from Mac.lan\n",
          },
          "book/proj-a/articles/2026-04-21__mac-only__m1111111.md": {
            threadId: "mac-only",
            title: "Mac only",
            updatedAt: "2026-04-21T10:00:00.000Z",
            body: "# Mac.lan exclusive\n",
          },
        },
      },
      chapters: { "proj-a": "# proj-a chapter from Mac.lan\n" },
    });
    await setupBranch({
      device: "Mac-mini.local",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-22__thread-shared__t1234567.md": {
            threadId: "thread-shared",
            title: "Shared thread (Mac-mini newer)",
            updatedAt: "2026-04-22T10:00:00.000Z",
            body: "# NEW version from Mac-mini\n",
          },
          "book/proj-a/articles/2026-04-22__mini-only__n2222222.md": {
            threadId: "mini-only",
            title: "Mini only",
            updatedAt: "2026-04-22T11:00:00.000Z",
            body: "# Mac-mini exclusive\n",
          },
        },
      },
      chapters: { "proj-a": "# proj-a chapter from Mac-mini\n" },
    });

    await runMerge();

    // Shared article: Mac-mini's newer body wins.
    const sharedMiniPath = join(workspace, "book/proj-a/articles/2026-04-22__thread-shared__t1234567.md");
    const sharedMacPath = join(workspace, "book/proj-a/articles/2026-04-20__thread-shared__t1234567.md");
    expect(existsSync(sharedMiniPath)).toBe(true);
    expect(readFileSync(sharedMiniPath, "utf8")).toContain("NEW version from Mac-mini");
    // Old version pruned.
    expect(existsSync(sharedMacPath)).toBe(false);
    // Each device's exclusive article is present.
    expect(existsSync(join(workspace, "book/proj-a/articles/2026-04-21__mac-only__m1111111.md"))).toBe(true);
    expect(existsSync(join(workspace, "book/proj-a/articles/2026-04-22__mini-only__n2222222.md"))).toBe(true);
  });

  it("writes per-device chapter files so neither device overwrites the other", async () => {
    await setupBranch({
      device: "Mac.lan",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-20__a1__aaaaaaaa.md": {
            threadId: "a1",
            title: "A1",
            updatedAt: "2026-04-20T10:00:00.000Z",
            body: "x",
          },
        },
      },
      chapters: { "proj-a": "# From Mac.lan\n" },
    });
    await setupBranch({
      device: "Mac-mini.local",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-22__b1__bbbbbbbb.md": {
            threadId: "b1",
            title: "B1",
            updatedAt: "2026-04-22T10:00:00.000Z",
            body: "y",
          },
        },
      },
      chapters: { "proj-a": "# From Mac-mini\n" },
    });

    await runMerge();

    const macChapter = join(workspace, "book/proj-a/chapter.Mac.lan.md");
    const miniChapter = join(workspace, "book/proj-a/chapter.Mac-mini.local.md");
    expect(existsSync(macChapter)).toBe(true);
    expect(readFileSync(macChapter, "utf8")).toContain("From Mac.lan");
    expect(existsSync(miniChapter)).toBe(true);
    expect(readFileSync(miniChapter, "utf8")).toContain("From Mac-mini");
  });

  it("regenerates book/index.md + book/_meta/timeline.md listing every article", async () => {
    await setupBranch({
      device: "Mac.lan",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-20__a1__aaaaaaaa.md": {
            threadId: "a1",
            title: "First article",
            updatedAt: "2026-04-20T10:00:00.000Z",
            body: "# First\n",
          },
        },
      },
      chapters: { "proj-a": "# c\n" },
    });
    await setupBranch({
      device: "Mac-mini.local",
      articles: {
        "proj-b": {
          "book/proj-b/articles/2026-04-22__b1__bbbbbbbb.md": {
            threadId: "b1",
            title: "Second article",
            updatedAt: "2026-04-22T10:00:00.000Z",
            body: "# Second\n",
          },
        },
      },
      chapters: {},
    });

    await runMerge();

    const index = readFileSync(join(workspace, "book/index.md"), "utf8");
    expect(index).toContain("Aggregated across 2 device(s)");
    expect(index).toContain("proj-a");
    expect(index).toContain("proj-b");

    const timeline = readFileSync(join(workspace, "book/_meta/timeline.md"), "utf8");
    expect(timeline).toContain("First article");
    expect(timeline).toContain("Second article");
    expect(timeline).toContain("Mac.lan");
    expect(timeline).toContain("Mac-mini.local");
    // Newest-first ordering check: Second article (2026-04-22) appears before First (2026-04-20)
    expect(timeline.indexOf("Second article")).toBeLessThan(timeline.indexOf("First article"));
  });

  it("skips branches without a BookIndex and exits cleanly when no device has one", async () => {
    // Create a branch with no .vibebook/index.book.json
    const dir = mkdtempSync(join(tmpdir(), "vibebook-merge-noindex-"));
    await simpleGit().clone(bareRemote, dir);
    const g = simpleGit(dir);
    await g.addConfig("user.email", "t@t");
    await g.addConfig("user.name", "t");
    await g.checkout(["-b", "empty-device"]);
    writeFileSync(join(dir, "random.txt"), "hi");
    await g.add(".");
    await g.commit("no vibebook data");
    await g.push("origin", "empty-device", ["-u"]);
    rmSync(dir, { recursive: true, force: true });

    await expect(runMerge()).resolves.toBeDefined();
    // Main branch shouldn't have gained a book/ directory.
    expect(existsSync(join(workspace, "book"))).toBe(false);
  });

  it("creates a commit with aggregate message when there's work to do", async () => {
    await setupBranch({
      device: "Mac.lan",
      articles: {
        "proj-a": {
          "book/proj-a/articles/2026-04-20__a1__aaaaaaaa.md": {
            threadId: "a1",
            title: "t",
            updatedAt: "2026-04-20T10:00:00.000Z",
            body: "x",
          },
        },
      },
      chapters: {},
    });
    const { clone } = await runMerge();
    const g = simpleGit(clone);
    const log = await g.log();
    expect(log.all[0].message).toMatch(/vibebook aggregate/);
  });
});
