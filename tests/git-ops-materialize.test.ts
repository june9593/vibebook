import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { materializeRepoAtPath } from "../src/git-ops.js";

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
