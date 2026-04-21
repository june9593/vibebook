import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("defaultLocalPath", () => {
  it("returns ./.memvc/repo under cwd", async () => {
    const m = await import("../../src/commands/init-wizard.js");
    expect(m.defaultLocalPath().endsWith("/.memvc/repo")).toBe(true);
  });
});

describe("applyWizardAnswers", () => {
  let tmpHome: string;
  let originUrl: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-wiz-"));
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
    const { writeFileSync } = await import("node:fs");
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

  it("clones the repo, writes config, and writes passphrase when encrypt=true", async () => {
    const localPath = join(tmpHome, "checkout");
    const m = await import("../../src/commands/init-wizard.js");
    await m.applyWizardAnswers({
      repoUrl: originUrl,
      localPath,
      encrypt: true,
      passphraseEntered: "secret",
      digestEnabled: true,
      runner: "claude-cli",
      runnerModel: "",
    });
    const { existsSync, readFileSync, statSync } = await import("node:fs");
    expect(existsSync(join(localPath, ".git"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".memvc", "config.json"), "utf8"));
    expect(cfg.repoUrl).toBe(originUrl);
    expect(cfg.repoPath).toBe(localPath);
    expect(cfg.encrypt).toBe(true);
    expect(cfg.digestEnabled).toBe(true);
    expect(cfg.runner).toBe("claude-cli");
    const pp = readFileSync(join(tmpHome, ".memvc", "passphrase"), "utf8").trim();
    expect(pp).toBe("secret");
    expect(statSync(join(tmpHome, ".memvc", "passphrase")).mode & 0o777).toBe(0o600);
  });

  it("does NOT write passphrase when encrypt=false", async () => {
    const localPath = join(tmpHome, "checkout");
    const m = await import("../../src/commands/init-wizard.js");
    await m.applyWizardAnswers({
      repoUrl: originUrl,
      localPath,
      encrypt: false,
      digestEnabled: false,
      runner: "claude-cli",
      runnerModel: "",
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpHome, ".memvc", "passphrase"))).toBe(false);
  });
});

describe("verifyRunner", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../../src/runner-check.js");
    vi.doUnmock("../../src/prompts.js");
    vi.resetModules();
  });

  it("returns true for a usable binary", async () => {
    vi.doMock("../../src/runner-check.js", async () => {
      const real = await vi.importActual<typeof import("../../src/runner-check.js")>("../../src/runner-check.js");
      return {
        ...real,
        runnerBinary: () => "node",
        runnerInstallUrl: () => "https://nodejs.org",
      };
    });
    vi.doMock("../../src/prompts.js", () => ({
      prompt: vi.fn(),
      promptYesNo: vi.fn(async () => false),
      promptChoice: vi.fn(),
      promptHidden: vi.fn(),
      closePrompts: vi.fn(),
    }));
    const m2 = await import("../../src/commands/init-wizard.js");
    expect(await m2.verifyRunner("claude-cli")).toBe(true);
  });

  it("returns false for missing binary", async () => {
    vi.doMock("../../src/runner-check.js", async () => {
      const real = await vi.importActual<typeof import("../../src/runner-check.js")>("../../src/runner-check.js");
      return {
        ...real,
        runnerBinary: () => "definitely-not-real-xyz",
        runnerInstallUrl: () => "https://example.com",
      };
    });
    vi.doMock("../../src/prompts.js", () => ({
      prompt: vi.fn(),
      promptYesNo: vi.fn(async () => false),
      promptChoice: vi.fn(),
      promptHidden: vi.fn(),
      closePrompts: vi.fn(),
    }));
    const m = await import("../../src/commands/init-wizard.js");
    expect(await m.verifyRunner("claude-cli")).toBe(false);
  });
});
