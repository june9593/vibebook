import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";

/**
 * Integration test for assets/scripts/merge-books.mjs.
 *
 * Sets up a fake bare remote with two device branches, each carrying a v2
 * BookIndex (.vibebook/index.book.json) + book/<proj>/chronicle/ +
 * book/<proj>/topics/ + book/<proj>/cards/. Runs merge-books.mjs on a
 * clone of main and asserts:
 *   - chronicles deduped by threadId (latest updatedAt wins) + file copied
 *   - topics preserved per-device as <slug>.<device>.md
 *   - cards unioned by (project, slug); collision → latest updatedAt
 *   - book/index.md + book/_meta/timeline.md regenerated with v2 vocabulary
 *   - commit created on main
 */

const SCRIPT_PATH = new URL("../../assets/scripts/merge-books.mjs", import.meta.url).pathname;

interface ChronicleSeed {
  threadId: string;
  title: string;
  updatedAt: string;
  body: string;
}

interface TopicSeed {
  topicSlug: string;
  updatedAt: string;
  contributingThreads: string[];
  body: string;
}

interface CardSeed {
  cardSlug: string;
  type: "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other";
  updatedAt: string;
  body: string;
}

interface RawSessionSeed {
  /** e.g. "claude:abc12345-..." — the key in .vibebook/index.json */
  sessionId: string;
  tool: "claude" | "copilot";
  project: string;
  startedAt: string;
  sourceMtimeMs: number;
  body: string;
}

interface MemorySeed {
  id: string;
  type: string;
  project: string | null;
  updatedAt: string;
  title: string;
  body: string;
}

interface BranchSeed {
  device: string;
  /** project → chronicles[] */
  chronicles?: Record<string, ChronicleSeed[]>;
  /** project → topics[] (project may be "_global") */
  topics?: Record<string, TopicSeed[]>;
  /** project → cards[] (project may be "_global") */
  cards?: Record<string, CardSeed[]>;
  /** raw_sessions to plant + register in .vibebook/index.json (P7) */
  rawSessions?: RawSessionSeed[];
  /** typed memory entries to plant + register in .vibebook/index.memory.json (0.9) */
  memories?: MemorySeed[];
}

let bareRemote: string;
let workspace: string;

// git init/clone/push under load easily exceed vitest's 5s default. Each
// it() spins up a bare remote + 2-3 clones; bump per-test + per-hook budget.
const T = 60_000;

function chroniclePath(project: string, c: ChronicleSeed): string {
  const date = c.updatedAt.slice(0, 10);
  const tid8 = c.threadId.slice(0, 8);
  return `book/${project}/chronicle/${date}__${c.threadId}__${tid8}.md`;
}

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

  const bookIndex = {
    version: 2,
    chronicles: {} as Record<string, unknown>,
    topics: {} as Record<string, unknown>,
    cards: {} as Record<string, unknown>,
  };

  for (const [project, chrs] of Object.entries(seed.chronicles ?? {})) {
    for (const c of chrs) {
      const path = chroniclePath(project, c);
      writeFileTo(dir, path, c.body);
      bookIndex.chronicles[c.threadId] = {
        threadId: c.threadId,
        project,
        title: c.title,
        sessionIds: [`sess-${c.threadId}`],
        path,
        createdAt: c.updatedAt,
        updatedAt: c.updatedAt,
        tags: [],
      };
    }
  }

  for (const [project, tops] of Object.entries(seed.topics ?? {})) {
    for (const t of tops) {
      const path = `book/${project}/topics/${t.topicSlug}.md`;
      writeFileTo(dir, path, t.body);
      bookIndex.topics[`${project}/${t.topicSlug}`] = {
        topicSlug: t.topicSlug,
        project,
        path,
        createdAt: t.updatedAt,
        updatedAt: t.updatedAt,
        contributingThreads: t.contributingThreads,
      };
    }
  }

  for (const [project, crds] of Object.entries(seed.cards ?? {})) {
    for (const c of crds) {
      const path = `book/${project}/cards/${c.cardSlug}.md`;
      writeFileTo(dir, path, c.body);
      bookIndex.cards[`${project}/${c.cardSlug}`] = {
        cardSlug: c.cardSlug,
        project,
        type: c.type,
        path,
        createdAt: c.updatedAt,
        updatedAt: c.updatedAt,
        tags: [],
      };
    }
  }

  mkdirSync(join(dir, ".vibebook"), { recursive: true });
  writeFileSync(join(dir, ".vibebook", "index.book.json"), JSON.stringify(bookIndex, null, 2));

  // P7: raw_sessions + .vibebook/index.json (spool index, separate from
  // index.book.json which only carries the digested book artifacts).
  if (seed.rawSessions && seed.rawSessions.length > 0) {
    const spoolIndex = {
      version: 1,
      entries: {} as Record<string, unknown>,
    };
    for (const rs of seed.rawSessions) {
      const date = rs.startedAt.slice(0, 10);
      const shortId = rs.sessionId.slice(0, 8);
      const rel = `raw_sessions/${rs.tool}/${rs.project}/${date}/seed__${shortId}.md`;
      writeFileTo(dir, rel, rs.body);
      spoolIndex.entries[`${rs.tool}:${rs.sessionId}`] = {
        sessionId: rs.sessionId,
        shortId,
        tool: rs.tool,
        project: rs.project,
        projectRaw: `/Users/test/${rs.project}`,
        startedAt: rs.startedAt,
        endedAt: rs.startedAt,
        nameSlug: "seed",
        displayName: "seed",
        relativePath: rel,
        sourcePath: `/fake/${rs.sessionId}.jsonl`,
        sourceMtimeMs: rs.sourceMtimeMs,
        sourceSha256: `sha-${rs.sessionId}`,
      };
    }
    writeFileSync(join(dir, ".vibebook", "index.json"), JSON.stringify(spoolIndex, null, 2));
  }

  // memories: plant .md files + .vibebook/index.memory.json (0.9)
  if (seed.memories && seed.memories.length > 0) {
    const entries: Record<string, unknown> = {};
    for (const m of seed.memories) {
      const scope = m.project ?? "_global";
      const slug = m.id.split("/").pop()!;
      const rel = `memory/${m.type}/${scope}/${slug}.md`;
      const mdContent = `---\nid: ${m.id}\ntype: ${m.type}\nupdatedAt: ${m.updatedAt}\ntitle: ${m.title}\n---\n\n${m.body}`;
      writeFileTo(dir, rel, mdContent);
      entries[m.id] = {
        id: m.id,
        type: m.type,
        project: m.project,
        updatedAt: m.updatedAt,
        title: m.title,
        path: rel,
        status: "active",
        originDevice: null,
      };
    }
    writeFileSync(join(dir, ".vibebook", "index.memory.json"), JSON.stringify({ version: 1, entries }, null, 2));
  }

  await g.add(".");
  await g.commit(`seed ${seed.device}`);
  await g.push("origin", seed.device, ["-u"]);
  rmSync(dir, { recursive: true, force: true });
}

function writeFileTo(dir: string, rel: string, body: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
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
  await setupMainOrphan();
  workspace = mkdtempSync(join(tmpdir(), "vibebook-merge-work-"));
}, T);

afterEach(() => {
  if (bareRemote) rmSync(bareRemote, { recursive: true, force: true, maxRetries: 3 });
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
});

async function runMerge(env: NodeJS.ProcessEnv = {}): Promise<{ clone: string }> {
  await simpleGit().clone(bareRemote, workspace);
  const g = simpleGit(workspace);
  await g.addConfig("user.email", "bot@example.com");
  await g.addConfig("user.name", "vibebook-bot");
  await g.checkout("main");
  execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: { ...process.env, ...env } });
  return { clone: workspace };
}

describe("merge-books.mjs (v2 schema)", () => {
  it("dedups chronicles by threadId, latest-updatedAt wins", async () => {
    await setupBranch({
      device: "Mac.lan",
      chronicles: {
        "edge-src": [
          { threadId: "thread-shared", title: "Shared (older)",
            updatedAt: "2026-04-20T10:00:00.000Z",
            body: "# Old version from Mac.lan\n" },
          { threadId: "mac-only", title: "Mac only",
            updatedAt: "2026-04-21T10:00:00.000Z",
            body: "# Mac.lan exclusive\n" },
        ],
      },
    });
    await setupBranch({
      device: "Mac-mini.local",
      chronicles: {
        "edge-src": [
          { threadId: "thread-shared", title: "Shared (newer)",
            updatedAt: "2026-04-22T10:00:00.000Z",
            body: "# NEW version from Mac-mini\n" },
          { threadId: "mini-only", title: "Mini only",
            updatedAt: "2026-04-22T11:00:00.000Z",
            body: "# Mac-mini exclusive\n" },
        ],
      },
    });

    await runMerge();

    // Shared: Mac-mini's newer body wins; the old chronicle path (different
    // because filename embeds date) is pruned.
    const sharedNew = join(workspace, "book/edge-src/chronicle/2026-04-22__thread-shared__thread-s.md");
    const sharedOld = join(workspace, "book/edge-src/chronicle/2026-04-20__thread-shared__thread-s.md");
    expect(existsSync(sharedNew)).toBe(true);
    expect(readFileSync(sharedNew, "utf8")).toContain("NEW version from Mac-mini");
    expect(existsSync(sharedOld)).toBe(false);
    // Each device's exclusive chronicle survives.
    expect(existsSync(join(workspace, "book/edge-src/chronicle/2026-04-21__mac-only__mac-only.md"))).toBe(true);
    expect(existsSync(join(workspace, "book/edge-src/chronicle/2026-04-22__mini-only__mini-onl.md"))).toBe(true);
  }, T);

  it("preserves per-device topic versions as <slug>.<device>.md", async () => {
    await setupBranch({
      device: "Mac.lan",
      topics: { "edge-src": [{
        topicSlug: "fullscreen", updatedAt: "2026-04-20T10:00:00.000Z",
        contributingThreads: ["fix-1"], body: "# Mac.lan version\n",
      }] },
    });
    await setupBranch({
      device: "Mac-mini.local",
      topics: { "edge-src": [{
        topicSlug: "fullscreen", updatedAt: "2026-04-22T10:00:00.000Z",
        contributingThreads: ["fix-2"], body: "# Mac-mini version\n",
      }] },
    });

    await runMerge();

    const macTopic = join(workspace, "book/edge-src/topics/fullscreen.Mac.lan.md");
    const miniTopic = join(workspace, "book/edge-src/topics/fullscreen.Mac-mini.local.md");
    expect(existsSync(macTopic)).toBe(true);
    expect(readFileSync(macTopic, "utf8")).toContain("Mac.lan version");
    expect(existsSync(miniTopic)).toBe(true);
    expect(readFileSync(miniTopic, "utf8")).toContain("Mac-mini version");
    // No bare fullscreen.md
    expect(existsSync(join(workspace, "book/edge-src/topics/fullscreen.md"))).toBe(false);
  }, T);

  it("unions cards across devices; slug collision picks latest updatedAt", async () => {
    await setupBranch({
      device: "Mac.lan",
      cards: {
        "edge-src": [
          { cardSlug: "gotcha-x", type: "gotcha",
            updatedAt: "2026-04-20T10:00:00.000Z", body: "OLD card\n" },
          { cardSlug: "pattern-mac-only", type: "pattern",
            updatedAt: "2026-04-20T10:00:00.000Z", body: "Mac-only card\n" },
        ],
      },
    });
    await setupBranch({
      device: "Mac-mini.local",
      cards: {
        "edge-src": [
          { cardSlug: "gotcha-x", type: "gotcha",
            updatedAt: "2026-04-22T10:00:00.000Z", body: "NEW card\n" },
          { cardSlug: "tool-mini-only", type: "tool",
            updatedAt: "2026-04-22T10:00:00.000Z", body: "Mini-only card\n" },
        ],
      },
    });

    await runMerge();

    const collision = join(workspace, "book/edge-src/cards/gotcha-x.md");
    expect(readFileSync(collision, "utf8")).toBe("NEW card\n");
    expect(existsSync(join(workspace, "book/edge-src/cards/pattern-mac-only.md"))).toBe(true);
    expect(existsSync(join(workspace, "book/edge-src/cards/tool-mini-only.md"))).toBe(true);
  }, T);

  it("supports _global cards (cross-project pool)", async () => {
    await setupBranch({
      device: "Mac.lan",
      cards: {
        "_global": [{ cardSlug: "tool-rg", type: "tool",
          updatedAt: "2026-04-20T10:00:00.000Z", body: "ripgrep tips\n" }],
      },
    });
    await setupBranch({
      device: "Mac-mini.local",
      cards: {
        "_global": [{ cardSlug: "howto-git-worktree", type: "howto",
          updatedAt: "2026-04-22T10:00:00.000Z", body: "git worktree howto\n" }],
      },
    });

    await runMerge();

    expect(existsSync(join(workspace, "book/_global/cards/tool-rg.md"))).toBe(true);
    expect(existsSync(join(workspace, "book/_global/cards/howto-git-worktree.md"))).toBe(true);
  }, T);

  it("regenerates book/index.md + book/_meta/timeline.md with v2 vocabulary", async () => {
    await setupBranch({
      device: "Mac.lan",
      chronicles: { "edge-src": [{
        threadId: "fix-foo", title: "Fix foo",
        updatedAt: "2026-04-20T10:00:00.000Z", body: "# Fix foo\n",
      }] },
      topics: { "edge-src": [{
        topicSlug: "fullscreen", updatedAt: "2026-04-20T10:00:00.000Z",
        contributingThreads: ["fix-foo"], body: "# Fullscreen\n",
      }] },
      cards: { "_global": [{
        cardSlug: "tool-rg", type: "tool",
        updatedAt: "2026-04-20T10:00:00.000Z", body: "rg\n",
      }] },
    });
    await setupBranch({
      device: "Mac-mini.local",
      chronicles: { "chromium-src": [{
        threadId: "trace-leak", title: "Trace memory leak",
        updatedAt: "2026-04-22T10:00:00.000Z", body: "# leak\n",
      }] },
    });

    await runMerge();

    const front = readFileSync(join(workspace, "book/index.md"), "utf8");
    // Default locale = English. Generated strings come from STRINGS_EN.
    expect(front).toContain("Aggregated from 2 devices");
    expect(front).toContain("edge-src");
    expect(front).toContain("chromium-src");
    expect(front).toContain("_global");
    expect(front).toContain("chronicle");

    const timeline = readFileSync(join(workspace, "book/_meta/timeline.md"), "utf8");
    expect(timeline).toContain("Global timeline");
    expect(timeline).toContain("📝 [Fix foo]");
    expect(timeline).toContain("📝 [Trace memory leak]");
    expect(timeline).toContain("📚 fullscreen");
    expect(timeline).toContain("💡 [tool-rg]");
    // Newest first: chromium fix on 04-22 > edge-src on 04-20
    expect(timeline.indexOf("Trace memory leak")).toBeLessThan(timeline.indexOf("Fix foo"));
  }, T);

  it("renders Chinese strings when VIBEBOOK_LOCALE=zh", async () => {
    await setupBranch({
      device: "Mac.lan",
      chronicles: { "edge-src": [{
        threadId: "fix-foo", title: "Fix foo",
        updatedAt: "2026-04-20T10:00:00.000Z", body: "# Fix foo\n",
      }] },
    });

    await runMerge({ VIBEBOOK_LOCALE: "zh" });

    const front = readFileSync(join(workspace, "book/index.md"), "utf8");
    expect(front).toContain("聚合自 1 台设备");
    expect(front).toContain("篇流水账");
    expect(front).toContain("# 笔记本");
    const timeline = readFileSync(join(workspace, "book/_meta/timeline.md"), "utf8");
    expect(timeline).toContain("# 全局时间线");
  }, T);

  it("skips branches without a v2 BookIndex and exits cleanly when none have one", async () => {
    // Branch with no .vibebook/index.book.json
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
    expect(existsSync(join(workspace, "book"))).toBe(false);
  }, T);

  it("creates a commit with v2 aggregate message", async () => {
    await setupBranch({
      device: "Mac.lan",
      chronicles: { "edge-src": [{
        threadId: "a1", title: "t",
        updatedAt: "2026-04-20T10:00:00.000Z", body: "x",
      }] },
    });
    const { clone } = await runMerge();
    const g = simpleGit(clone);
    const log = await g.log();
    expect(log.all[0].message).toMatch(/vibebook aggregate/);
    expect(log.all[0].message).toMatch(/chronicles?/);
  }, T);

  it("v1 BookIndex on a device branch is silently skipped (no migration)", async () => {
    // simulate an old-vibebook device that hasn't run v0.2 yet
    const dir = mkdtempSync(join(tmpdir(), "vibebook-merge-v1-"));
    await simpleGit().clone(bareRemote, dir);
    const g = simpleGit(dir);
    await g.addConfig("user.email", "t@t");
    await g.addConfig("user.name", "t");
    await g.checkout(["-b", "old-device"]);
    mkdirSync(join(dir, ".vibebook"), { recursive: true });
    writeFileSync(join(dir, ".vibebook", "index.book.json"), JSON.stringify({
      version: 1, threads: { "x": { threadId: "x", project: "p", title: "X",
        sessionIds: [], articlePath: "book/p/articles/x.md",
        articleVersion: 2, latestSourceSha: "s", articleStatus: "ok",
        updatedAt: "2026-04-20T10:00:00Z" }}, chapters: {},
    }));
    writeFileTo(dir, "book/p/articles/x.md", "old article\n");
    await g.add(".");
    await g.commit("v1 device");
    await g.push("origin", "old-device", ["-u"]);
    rmSync(dir, { recursive: true, force: true });

    await expect(runMerge()).resolves.toBeDefined();
    // Old article path was NOT carried over (we only read v2)
    expect(existsSync(join(workspace, "book/p/articles/x.md"))).toBe(false);
  }, T);

  it("aggregates raw_sessions/ + writes .vibebook/index.aggregated.json (P7)", async () => {
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [
        {
          sessionId: "sess-mac-aaaa", tool: "claude", project: "edge-src",
          startedAt: "2026-04-20T10:00:00.000Z", sourceMtimeMs: 1_000_000,
          body: "# md from Mac.lan (sess-mac)\n",
        },
        {
          sessionId: "sess-shared", tool: "claude", project: "edge-src",
          startedAt: "2026-04-20T11:00:00.000Z", sourceMtimeMs: 1_000_000,
          body: "# OLD body from Mac.lan\n",
        },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      rawSessions: [
        {
          sessionId: "sess-mini-bbbb", tool: "copilot", project: "chromium",
          startedAt: "2026-04-22T09:00:00.000Z", sourceMtimeMs: 2_000_000,
          body: "# md from Mac-mini (sess-mini)\n",
        },
        {
          sessionId: "sess-shared", tool: "claude", project: "edge-src",
          startedAt: "2026-04-20T11:00:00.000Z", sourceMtimeMs: 2_000_000,
          body: "# NEW body from Mac-mini (won via higher mtime)\n",
        },
      ],
    });

    await runMerge();

    const macMd = join(workspace, "raw_sessions/claude/edge-src/2026-04-20/seed__sess-mac.md");
    const miniMd = join(workspace, "raw_sessions/copilot/chromium/2026-04-22/seed__sess-min.md");
    const sharedMd = join(workspace, "raw_sessions/claude/edge-src/2026-04-20/seed__sess-sha.md");
    expect(existsSync(macMd)).toBe(true);
    expect(existsSync(miniMd)).toBe(true);
    expect(existsSync(sharedMd)).toBe(true);
    // dedupe by tool:sessionId — Mac-mini's newer body wins for sess-shared
    expect(readFileSync(sharedMd, "utf8")).toContain("NEW body from Mac-mini");

    const aggPath = join(workspace, ".vibebook/index.aggregated.json");
    expect(existsSync(aggPath)).toBe(true);
    const agg = JSON.parse(readFileSync(aggPath, "utf8"));
    expect(agg.version).toBe(1);
    expect(Object.keys(agg.entries).sort()).toEqual([
      "claude:sess-mac-aaaa",
      "claude:sess-shared",
      "copilot:sess-mini-bbbb",
    ]);
    // originDevice annotation lets consumers tell "which machine wrote this"
    expect(agg.entries["claude:sess-mac-aaaa"].originDevice).toBe("Mac.lan");
    expect(agg.entries["copilot:sess-mini-bbbb"].originDevice).toBe("Mac-mini");
    expect(agg.entries["claude:sess-shared"].originDevice).toBe("Mac-mini");
  }, T);

  it("doesn't write raw_sessions/ or .vibebook/index.aggregated.json when no device has a spool index", async () => {
    // Existing chronicle-only seeds (no rawSessions) should still merge book/
    // cleanly, and the new aggregated files should NOT appear.
    await setupBranch({
      device: "Mac.lan",
      chronicles: { p: [{ threadId: "t1", title: "T1",
        updatedAt: "2026-04-20T10:00:00.000Z", body: "# c1\n" }] },
    });
    await runMerge();
    expect(existsSync(join(workspace, "raw_sessions"))).toBe(false);
    expect(existsSync(join(workspace, ".vibebook/index.aggregated.json"))).toBe(false);
    // chronicle still aggregated normally
    expect(existsSync(join(workspace, "book/p/chronicle/2026-04-20__t1__t1.md"))).toBe(true);
  }, T);

  it("aggregates raw_sessions even when NO device has a v2 BookIndex (0.8.3 fix)", async () => {
    // Devices have only raw_sessions (no /vibebook digest has been run
    // anywhere yet). Pre-0.8.3 the script early-returned on empty
    // perDevice and raw_sessions aggregation was silently skipped.
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [{
        sessionId: "sess-only-raw", tool: "claude", project: "edge-src",
        startedAt: "2026-04-20T10:00:00.000Z", sourceMtimeMs: 1_000_000,
        body: "# md from a device that never ran /vibebook digest\n",
      }],
    });

    await runMerge();

    // raw_sessions IS aggregated even without books
    expect(existsSync(join(workspace, "raw_sessions/claude/edge-src/2026-04-20/seed__sess-onl.md"))).toBe(true);
    const agg = JSON.parse(readFileSync(join(workspace, ".vibebook/index.aggregated.json"), "utf8"));
    expect(Object.keys(agg.entries)).toEqual(["claude:sess-only-raw"]);
    // book/index.md may exist (the test helper plants an empty BookIndex
    // unconditionally) but no chronicle files were aggregated
    expect(existsSync(join(workspace, "book/edge-src"))).toBe(false);
  }, T);

  it("aggregates memory/ + index.memory.json across devices, union by id, latest wins (0.9 memory)", async () => {
    await setupBranch({
      device: "Mac.lan",
      memories: [
        { id: "semantic/edge-src/a", type: "semantic", project: "edge-src",
          updatedAt: "2026-06-01", body: "older", title: "fact A" },
        { id: "core/_global/rule", type: "core", project: null,
          updatedAt: "2026-06-01", body: "never publish", title: "rule" },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      memories: [
        { id: "semantic/edge-src/a", type: "semantic", project: "edge-src",
          updatedAt: "2026-06-09", body: "NEWER wins", title: "fact A" },
        { id: "procedural/edge-src/b", type: "procedural", project: "edge-src",
          updatedAt: "2026-06-09", body: "how-to", title: "playbook B" },
      ],
    });

    await runMerge();

    const aMd = readFileSync(join(workspace, "memory/semantic/edge-src/a.md"), "utf8");
    expect(aMd).toContain("NEWER wins");
    expect(existsSync(join(workspace, "memory/core/_global/rule.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory/procedural/edge-src/b.md"))).toBe(true);

    const idx = JSON.parse(readFileSync(join(workspace, ".vibebook/index.memory.json"), "utf8"));
    expect(Object.keys(idx.entries).sort()).toEqual([
      "core/_global/rule", "procedural/edge-src/b", "semantic/edge-src/a",
    ]);
    expect(idx.entries["semantic/edge-src/a"].originDevice).toBe("Mac-mini");
  }, T);
});
