import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

describe("defaultLocalPath", () => {
  it("returns ~/.vibebook/session-repo", async () => {
    const m = await import("../../src/commands/init-wizard.js");
    expect(m.defaultLocalPath().endsWith("/.vibebook/session-repo")).toBe(true);
  });
});

describe("stripVolatileSuffixes", () => {
  it("strips .local (Bonjour / mDNS)", async () => {
    const { stripVolatileSuffixes } = await import("../../src/commands/init-wizard.js");
    expect(stripVolatileSuffixes("Mac-mini-2.local")).toBe("Mac-mini-2");
    expect(stripVolatileSuffixes("yuedeMacBook-Pro-2.local")).toBe("yuedeMacBook-Pro-2");
  });
  it("strips .lan", async () => {
    const { stripVolatileSuffixes } = await import("../../src/commands/init-wizard.js");
    expect(stripVolatileSuffixes("Mac.lan")).toBe("Mac");
  });
  it("strips corp FQDN suffixes", async () => {
    const { stripVolatileSuffixes } = await import("../../src/commands/init-wizard.js");
    expect(stripVolatileSuffixes("MIS-EV2-BB1.surfacescenarios.org")).toBe("MIS-EV2-BB1");
    expect(stripVolatileSuffixes("host42.corp.example.com")).toBe("host42");
  });
  it("leaves a bare label unchanged", async () => {
    const { stripVolatileSuffixes } = await import("../../src/commands/init-wizard.js");
    expect(stripVolatileSuffixes("mini2")).toBe("mini2");
    expect(stripVolatileSuffixes("work-laptop")).toBe("work-laptop");
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

  it("clones the repo and writes config", async () => {
    const localPath = join(tmpHome, "checkout");
    const m = await import("../../src/commands/init-wizard.js");
    await m.applyWizardAnswers({
      repoUrl: originUrl,
      localPath,
      enableAggregateCI: true,
      deviceBranch: "test-device",
    });
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(join(localPath, ".git"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook", "config.json"), "utf8"));
    expect(cfg.repoUrl).toBe(originUrl);
    expect(cfg.repoPath).toBe(localPath);
    expect(cfg.runner).toBe("claude-cli");
    expect(cfg.enableAggregateCI).toBe(true);
    expect(cfg.deviceBranch).toBe("test-device");
  });
});

describe("runWizard end-to-end transcript", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("walks through all questions and returns expected answers (remote mode)", async () => {
    const lines = [
      "y",                             // Q0 sync to remote
      "git@github.com:you/repo.git",  // Q1 repo URL
      "",                              // Q2 path → default
      "mini2",                         // Q6 stable device name (override hostname default)
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
    // 0.6.1: Q6 dropped — enableAggregateCI auto-set true for sync-to-remote
    expect(a.enableAggregateCI).toBe(true);
    expect(a.deviceBranch).toBe("mini2");
  });

  it("local-only mode (Q0=n) skips remote-only questions (including aggregate CI)", async () => {
    const lines = [
      "n",                              // Q0 sync to remote → no
      "",                               // Q6 → accept hostname default
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
    expect(a.enableAggregateCI).toBe(false); // local-only mode → no CI
    expect(a.deviceBranch.length).toBeGreaterThan(0); // hostname() default accepted
  });
});
