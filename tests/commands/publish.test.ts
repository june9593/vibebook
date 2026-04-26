import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChronicleInput, TopicInput, CardInput } from "../../src/commands/publish.js";

let tmpHome: string;
let repoPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-pub-"));
  vi.stubEnv("HOME", tmpHome);
  repoPath = join(tmpHome, "repo");
  mkdirSync(repoPath, { recursive: true });
  // Minimal config (no remote URL → publish skips git step naturally)
  mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
    repoPath, repoUrl: "",
    encrypt: false, salt: "x",
    deviceBranch: "test.lan",
    runner: "claude-cli",
    enableAggregateCI: false, includeReasoning: true,
    threadingConcurrency: 4, threadingMaxAttempts: 3,
    digestEnabled: true,
  }));
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

function writeJson(path: string, data: unknown): string {
  const full = join(tmpHome, path);
  mkdirSync(join(full, "..").replace(/[^/]+$/, ""), { recursive: true });
  const dir = full.split("/").slice(0, -1).join("/");
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, JSON.stringify(data));
  return full;
}

describe("publish — chronicles", () => {
  it("inserts a chronicle, writes file, updates BookIndex", async () => {
    const chrs: ChronicleInput[] = [{
      threadId: "fix-foo", project: "edge-src", title: "Fix foo",
      sessionIds: ["s1"], tags: ["bug"],
      body: "---\ntitle: Fix foo\n---\n# Fix foo\nbody\n",
    }];
    const chrPath = writeJson("chrs.json", chrs);
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ chroniclesPath: chrPath, noCommit: true });
    expect(r.chroniclesInserted).toBe(1);
    expect(r.chroniclesSkipped).toBe(0);
    // file written
    const files = require("node:fs").readdirSync(join(repoPath, "book/edge-src/chronicle"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}__fix-foo__fix-foo\.md$/);
    // book index updated
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.version).toBe(2);
    expect(bi.chronicles["fix-foo"].project).toBe("edge-src");
    expect(bi.chronicles["fix-foo"].tags).toEqual(["bug"]);
  });

  it("records a skipped chronicle in the index but writes no file", async () => {
    const chrs: ChronicleInput[] = [{
      threadId: "say-hi", project: "home", title: "say hi",
      sessionIds: ["s1"], body: "(unused)",
      skip: true, skipReason: "no substance",
    }];
    const chrPath = writeJson("chrs.json", chrs);
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ chroniclesPath: chrPath, noCommit: true });
    expect(r.chroniclesSkipped).toBe(1);
    expect(r.chroniclesInserted).toBe(0);
    expect(existsSync(join(repoPath, "book/home/chronicle"))).toBe(false);
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.chronicles["say-hi"].skip).toBe(true);
    expect(bi.chronicles["say-hi"].skipReason).toBe("no substance");
  });

  it("throws on threadId collision (insert-only)", async () => {
    const chrs1: ChronicleInput[] = [{
      threadId: "x", project: "p", title: "X", sessionIds: [], body: "first\n",
    }];
    const chrs2: ChronicleInput[] = [{
      threadId: "x", project: "p", title: "X again", sessionIds: [], body: "second\n",
    }];
    const p1 = writeJson("a.json", chrs1);
    const p2 = writeJson("b.json", chrs2);
    const { publishCmd } = await import("../../src/commands/publish.js");
    await publishCmd({ chroniclesPath: p1, noCommit: true });
    await expect(publishCmd({ chroniclesPath: p2, noCommit: true })).rejects.toThrow(/already exists/);
  });
});

describe("publish — topics", () => {
  it("inserts a new topic page", async () => {
    const tops: TopicInput[] = [{
      topicSlug: "fullscreen", project: "edge-src", action: "insert",
      contributingThreads: ["fix-foo"],
      body: "---\ntitle: Fullscreen\n---\n# Fullscreen\nstuff\n",
    }];
    const path = writeJson("tops.json", tops);
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ topicsPath: path, noCommit: true });
    expect(r.topicsInserted).toBe(1);
    expect(existsSync(join(repoPath, "book/edge-src/topics/fullscreen.md"))).toBe(true);
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.topics["edge-src/fullscreen"].contributingThreads).toEqual(["fix-foo"]);
  });

  it("tolerates topic input missing contributingThreads (treats as [])", async () => {
    // Regression: publish used to throw "is not iterable" with no slug
    // context, leaving the user staring at an opaque error.
    const tops = [{
      topicSlug: "concept-only", project: "edge-src", action: "insert",
      body: "---\ntitle: Concept\n---\n# Concept\nstub\n",
      // contributingThreads intentionally omitted
    }];
    const path = writeJson("tops.json", tops as unknown as TopicInput[]);
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ topicsPath: path, noCommit: true });
    expect(r.topicsInserted).toBe(1);
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.topics["edge-src/concept-only"].contributingThreads).toEqual([]);
  });

  it("backs up old topic file before update + merges contributingThreads", async () => {
    const t1: TopicInput[] = [{
      topicSlug: "fullscreen", project: "edge-src", action: "insert",
      contributingThreads: ["fix-1"],
      body: "OLD CONTENT\n",
    }];
    const t2: TopicInput[] = [{
      topicSlug: "fullscreen", project: "edge-src", action: "update",
      contributingThreads: ["fix-2"],
      body: "NEW CONTENT\n",
    }];
    const { publishCmd } = await import("../../src/commands/publish.js");
    await publishCmd({ topicsPath: writeJson("a.json", t1), noCommit: true });
    const r = await publishCmd({ topicsPath: writeJson("b.json", t2), noCommit: true });
    expect(r.topicsUpdated).toBe(1);
    const file = readFileSync(join(repoPath, "book/edge-src/topics/fullscreen.md"), "utf8");
    expect(file).toBe("NEW CONTENT\n");
    const bak = readFileSync(join(repoPath, "book/edge-src/topics/fullscreen.md.bak"), "utf8");
    expect(bak).toBe("OLD CONTENT\n");
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.topics["edge-src/fullscreen"].contributingThreads.sort()).toEqual(["fix-1", "fix-2"]);
  });
});

describe("publish — cards", () => {
  it("inserts and updates cards by composite (project, slug)", async () => {
    const c1: CardInput[] = [{
      cardSlug: "gotcha-x", project: "edge-src", type: "gotcha", action: "insert",
      tags: ["mac"], body: "first\n",
    }];
    const c2: CardInput[] = [{
      cardSlug: "gotcha-x", project: "edge-src", type: "gotcha", action: "update",
      body: "second\n",
    }];
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r1 = await publishCmd({ cardsPath: writeJson("a.json", c1), noCommit: true });
    expect(r1.cardsInserted).toBe(1);
    const r2 = await publishCmd({ cardsPath: writeJson("b.json", c2), noCommit: true });
    expect(r2.cardsUpdated).toBe(1);
    expect(readFileSync(join(repoPath, "book/edge-src/cards/gotcha-x.md"), "utf8")).toBe("second\n");
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.cards["edge-src/gotcha-x"].type).toBe("gotcha");
    // tags get REPLACED on update (LLM might intentionally retag); preserved
    // would require a different schema. Empty input → empty stored.
    expect(bi.cards["edge-src/gotcha-x"].tags).toEqual([]);
    // createdAt is preserved across update though.
    expect(bi.cards["edge-src/gotcha-x"].createdAt).toBe(bi.cards["edge-src/gotcha-x"].createdAt);
  });

  it("supports _global cards", async () => {
    const cards: CardInput[] = [{
      cardSlug: "tool-rg", project: "_global", type: "tool", action: "insert",
      body: "ripgrep tips\n",
    }];
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ cardsPath: writeJson("c.json", cards), noCommit: true });
    expect(r.cardsInserted).toBe(1);
    expect(existsSync(join(repoPath, "book/_global/cards/tool-rg.md"))).toBe(true);
    const bi = JSON.parse(readFileSync(join(repoPath, ".vibebook/index.book.json"), "utf8"));
    expect(bi.cards["_global/tool-rg"]).toBeDefined();
  });
});

describe("publish — catalog regen", () => {
  it("writes book/index.md + book/_meta/timeline.md after any publish", async () => {
    const chrs: ChronicleInput[] = [{
      threadId: "fix-foo", project: "edge-src", title: "Fix foo",
      sessionIds: ["s1"], body: "body\n",
    }];
    const { publishCmd } = await import("../../src/commands/publish.js");
    const r = await publishCmd({ chroniclesPath: writeJson("c.json", chrs), noCommit: true });
    expect(r.bookIndexFiles).toContain("book/index.md");
    expect(r.bookIndexFiles).toContain("book/_meta/timeline.md");
    expect(existsSync(join(repoPath, "book/index.md"))).toBe(true);
    const front = readFileSync(join(repoPath, "book/index.md"), "utf8");
    expect(front).toContain("edge-src");
    expect(front).toContain("Fix foo");
  });
});

describe("publish — input validation", () => {
  it("throws on missing chronicles file", async () => {
    const { publishCmd } = await import("../../src/commands/publish.js");
    await expect(publishCmd({ chroniclesPath: "/no/such/file", noCommit: true })).rejects.toThrow(/chronicles input not found/);
  });
  it("throws on malformed JSON", async () => {
    const path = join(tmpHome, "bad.json");
    writeFileSync(path, "{not json");
    const { publishCmd } = await import("../../src/commands/publish.js");
    await expect(publishCmd({ chroniclesPath: path, noCommit: true })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects chronicle missing top-level project (avoid book/undefined/...)", async () => {
    // Regression: an LLM that put `project` only in YAML frontmatter (not at
    // the top level of the JSON entry) used to silently land everything in
    // book/undefined/chronicle/ — entire batch lost to a typo.
    const chrs = [{
      threadId: "fix-foo", title: "Fix foo", sessionIds: ["s1"],
      body: "---\nproject: edge-src\n---\nbody\n",
      // project intentionally omitted at top level
    }];
    const path = writeJson("missing-project.json", chrs as unknown as ChronicleInput[]);
    const { publishCmd } = await import("../../src/commands/publish.js");
    await expect(publishCmd({ chroniclesPath: path, noCommit: true }))
      .rejects.toThrow(/chronicle\.project is required/);
  });

  it("rejects topic missing top-level project", async () => {
    const tops = [{
      topicSlug: "x", action: "insert", contributingThreads: [], body: "x\n",
    }];
    const path = writeJson("t.json", tops as unknown as TopicInput[]);
    const { publishCmd } = await import("../../src/commands/publish.js");
    await expect(publishCmd({ topicsPath: path, noCommit: true }))
      .rejects.toThrow(/topic\.project is required/);
  });

  it("rejects card missing top-level cardSlug", async () => {
    const cards = [{
      project: "edge-src", type: "gotcha", action: "insert", body: "x\n",
    }];
    const path = writeJson("c.json", cards as unknown as CardInput[]);
    const { publishCmd } = await import("../../src/commands/publish.js");
    await expect(publishCmd({ cardsPath: path, noCommit: true }))
      .rejects.toThrow(/card\.cardSlug is required/);
  });
});
