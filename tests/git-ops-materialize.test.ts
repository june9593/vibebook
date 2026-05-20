import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { materializeRepoAtPath, adoptPluginDir } from "../src/git-ops.js";

describe("materializeRepoAtPath", () => {
  let tmp: string;
  let originPath: string;
  let originUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memvc-mat-"));
    // Build a tiny bare repo to act as a fake origin.
    originPath = join(tmp, "origin.git");
    mkdirSync(originPath);
    await simpleGit(originPath).init(true);
    // Seed with one commit via a working dir.
    const seed = join(tmp, "seed");
    mkdirSync(seed);
    const sg = simpleGit(seed);
    await sg.init();
    writeFileSync(join(seed, "README.md"), "x\n");
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    await sg.add(".");
    await sg.commit("init");
    await sg.addRemote("origin", originPath);
    await sg.push("origin", "master").catch(() => sg.push("origin", "main"));
    originUrl = originPath;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clones into a non-existent dir", async () => {
    const target = join(tmp, "target");
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("cloned");
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("clones into an existing-but-empty dir", async () => {
    const target = join(tmp, "empty");
    mkdirSync(target);
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("cloned");
  });

  it("reuses an existing checkout and reports remote URL", async () => {
    const target = join(tmp, "existing");
    await simpleGit().clone(originUrl, target);
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("existing");
    expect(r.existingRemote).toBe(originUrl);
  });

  it("reports mismatched remote on existing checkout", async () => {
    const target = join(tmp, "existing-mismatch");
    await simpleGit().clone(originUrl, target);
    const r = await materializeRepoAtPath(target, "https://other.example/different.git");
    expect(r.kind).toBe("existing");
    expect(r.existingRemote).toBe(originUrl);
  });

  it("refuses non-empty non-repo dir", async () => {
    const target = join(tmp, "junk");
    mkdirSync(target);
    writeFileSync(join(target, "file.txt"), "x");
    await expect(materializeRepoAtPath(target, originUrl)).rejects.toThrow(/not a git repo/);
  });
});

describe("adoptPluginDir", () => {
  let tmp: string;
  let originPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memvc-adopt-"));
    originPath = join(tmp, "origin.git");
    mkdirSync(originPath);
    await simpleGit(originPath).init(true);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adopts a non-git dir full of plugin data into a git repo on the requested branch", async () => {
    // Simulate the plugin-first dir: book/ + raw_sessions/ present, no .git
    const target = join(tmp, "session-repo");
    mkdirSync(join(target, "book/edge-memvc/chronicle"), { recursive: true });
    mkdirSync(join(target, "raw_sessions/claude/edge-memvc/2026-05-20"), { recursive: true });
    writeFileSync(join(target, "book/edge-memvc/chronicle/test.md"), "# test\n");
    writeFileSync(
      join(target, "raw_sessions/claude/edge-memvc/2026-05-20/sess__abc.jsonl"),
      "{}\n",
    );

    const r = await adoptPluginDir(target, originPath, "mini2");
    expect(r.kind).toBe("adopted");

    // .git was created
    expect(existsSync(join(target, ".git"))).toBe(true);

    // Plugin files preserved
    expect(existsSync(join(target, "book/edge-memvc/chronicle/test.md"))).toBe(true);
    expect(existsSync(join(target, "raw_sessions/claude/edge-memvc/2026-05-20/sess__abc.jsonl"))).toBe(true);

    // Correct branch ref (unborn until first commit lands, but HEAD is pointed)
    const sg = simpleGit(target);
    const head = await sg.raw(["symbolic-ref", "HEAD"]);
    expect(head.trim()).toBe("refs/heads/mini2");

    // Origin set
    const remote = (await sg.getConfig("remote.origin.url")).value;
    expect(remote).toBe(originPath);
  });

  it("refuses to adopt a dir that already has .git/", async () => {
    const target = join(tmp, "already-git");
    mkdirSync(target);
    await simpleGit(target).init();
    await expect(adoptPluginDir(target, originPath, "mini2")).rejects.toThrow(/already has a \.git/);
  });

  it("refuses to adopt a non-existent dir", async () => {
    await expect(adoptPluginDir(join(tmp, "nope"), originPath, "mini2")).rejects.toThrow(/does not exist/);
  });
});
