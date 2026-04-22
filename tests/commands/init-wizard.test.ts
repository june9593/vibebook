import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

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
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-wiz-"));
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
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook", "config.json"), "utf8"));
    expect(cfg.repoUrl).toBe(originUrl);
    expect(cfg.repoPath).toBe(localPath);
    expect(cfg.encrypt).toBe(true);
    expect(cfg.digestEnabled).toBe(true);
    expect(cfg.runner).toBe("claude-cli");
    const pp = readFileSync(join(tmpHome, ".vibebook", "passphrase"), "utf8").trim();
    expect(pp).toBe("secret");
    expect(statSync(join(tmpHome, ".vibebook", "passphrase")).mode & 0o777).toBe(0o600);
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
    expect(existsSync(join(tmpHome, ".vibebook", "passphrase"))).toBe(false);
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
        runnerBinary: () => "fake-but-mocked",
        runnerInstallUrl: () => "https://example.com",
        checkBinary: async () => ({ ok: true, output: "v99.0.0\n" }),
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

describe("runWizard end-to-end transcript", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("walks through all 7 questions and returns expected answers", async () => {
    const lines = [
      "y",                             // Q0 sync to remote
      "git@github.com:you/repo.git",  // Q1 repo URL
      "",                              // Q2 path → default
      "y",                             // Q3 encrypt
      "secret123",                     // Q4 passphrase
      "secret123",                     // Q4 confirm
      "y",                             // Q5 digest
      "1",                             // Q6 runner = claude-cli
      "claude-sonnet-4-6",             // Q7 model
    ];
    const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
    stdin.isTTY = true;
    let i = 0;
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        const s = chunk.toString();
        // Feed next line whenever readline writes a prompt ending with ": ".
        if (s.endsWith(": ") && i < lines.length) {
          const line = lines[i++]!;
          setImmediate(() => stdin.push(line + "\n"));
        }
        cb();
      },
    }) as Writable & { isTTY?: boolean; columns?: number };
    stdout.isTTY = true;
    stdout.columns = 80;
    vi.stubGlobal("process", { ...process, stdin, stdout });
    vi.resetModules();
    const m = await import("../../src/commands/init-wizard.js");
    const { closePrompts } = await import("../../src/prompts.js");
    const a = await m.runWizard();
    closePrompts();
    expect(a.repoUrl).toBe("git@github.com:you/repo.git");
    expect(a.encrypt).toBe(true);
    expect(a.passphraseEntered).toBe("secret123");
    expect(a.digestEnabled).toBe(true);
    expect(a.runner).toBe("claude-cli");
    expect(a.runnerModel).toBe("claude-sonnet-4-6");
  });

  it("local-only mode (Q0=n) skips repo URL + encryption questions", async () => {
    const lines = [
      "n",                              // Q0 sync to remote → no
      "y",                              // Q5 digest
      "",                               // Q7 model (Q6 auto since only one runner)
    ];
    const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
    stdin.isTTY = true;
    let i = 0;
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        const s = chunk.toString();
        if (s.endsWith(": ") && i < lines.length) {
          const line = lines[i++]!;
          setImmediate(() => stdin.push(line + "\n"));
        }
        cb();
      },
    }) as Writable & { isTTY?: boolean; columns?: number };
    stdout.isTTY = true;
    stdout.columns = 80;
    vi.stubGlobal("process", { ...process, stdin, stdout });
    vi.resetModules();
    const m = await import("../../src/commands/init-wizard.js");
    const { closePrompts } = await import("../../src/prompts.js");
    const a = await m.runWizard();
    closePrompts();
    expect(a.repoUrl).toBe("");
    expect(a.encrypt).toBe(false);
    expect(a.passphraseEntered).toBeUndefined();
    expect(a.digestEnabled).toBe(true);
    expect(a.runner).toBe("claude-cli");
  });
});
