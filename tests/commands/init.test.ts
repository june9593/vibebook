import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("initCmd flag mode", () => {
  let tmpHome: string;
  let originUrl: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-init-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
    const { simpleGit } = await import("simple-git");
    originUrl = join(tmpHome, "origin.git");
    mkdirSync(originUrl);
    await simpleGit(originUrl).init(true);
    const seed = join(tmpHome, "seed");
    mkdirSync(seed);
    const sg = simpleGit(seed);
    await sg.init();
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    writeFileSync(join(seed, "r"), "x");
    await sg.add(".");
    await sg.commit("c");
    await sg.addRemote("origin", originUrl);
    await sg.push("origin", "master").catch(() => sg.push("origin", "main"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("flag mode with --encrypt + --passphrase persists config and passphrase", async () => {
    const localPath = join(tmpHome, "checkout");
    const { initCmd } = await import("../../src/commands/init.js");
    await initCmd({
      repoUrl: originUrl,
      localPath,
      encrypt: true,
      passphrase: "abc",
      digestEnabled: false,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook", "config.json"), "utf8"));
    expect(cfg.encrypt).toBe(true);
    expect(cfg.digestEnabled).toBe(false);
    expect(readFileSync(join(tmpHome, ".vibebook", "passphrase"), "utf8").trim()).toBe("abc");
    // repo-salt.json is written into the repo so the GH Action can read it.
    const saltFile = join(localPath, ".vibebook", "repo-salt.json");
    expect(existsSync(saltFile)).toBe(true);
    expect(JSON.parse(readFileSync(saltFile, "utf8")).salt).toBe(cfg.salt);
  });

  it("flag mode default localPath is ./.vibebook/repo under cwd", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "vibebook-cwd-")));
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      const { initCmd } = await import("../../src/commands/init.js");
      await initCmd({ repoUrl: originUrl });
      const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook", "config.json"), "utf8"));
      expect(cfg.repoPath).toBe(join(cwd, ".vibebook", "repo"));
      expect(existsSync(join(cwd, ".vibebook", "repo", ".git"))).toBe(true);
    } finally {
      process.chdir(orig);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("flag mode without repoUrl throws", async () => {
    const { initCmd } = await import("../../src/commands/init.js");
    await expect(initCmd({ encrypt: true })).rejects.toThrow(/repoUrl is required/);
  });
});
