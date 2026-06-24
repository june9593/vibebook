import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("workflowInitCmd (local-only mode)", () => {
  let tmpHome: string;
  let repoPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-wf-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
    repoPath = join(tmpHome, "memvc-repo");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
    // Local-only: no repoUrl. Skips the main-push path.
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath, repoUrl: "",
      deviceBranch: "test-device",
      runner: "claude-cli",
      enableAggregateCI: true,
      threadingConcurrency: 4, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes both files into the working tree when local-only", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    const scriptOut = join(repoPath, "scripts", "merge-books.mjs");
    expect(existsSync(yamlOut)).toBe(true);
    expect(existsSync(scriptOut)).toBe(true);
    const yaml = readFileSync(yamlOut, "utf8");
    expect(yaml).toContain("vibebook aggregate book");
    expect(yaml).toContain("merge-books.mjs");
    expect(yaml).not.toContain("VIBEBOOK_PASSPHRASE");
    const script = readFileSync(scriptOut, "utf8");
    expect(script).toContain("Aggregate every device branch");
  });

  it("refuses to overwrite without --force in local-only mode", async () => {
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(yamlOut, "existing content\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});
    expect(readFileSync(yamlOut, "utf8")).toBe("existing content\n");
  });

  it("overwrites with --force in local-only mode", async () => {
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(yamlOut, "existing\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ force: true });
    expect(readFileSync(yamlOut, "utf8")).toContain("vibebook aggregate book");
  });
});

describe("workflowInitCmd (remote mode → writes to main via temp worktree)", () => {
  let tmpHome: string;
  let bareRemote: string;
  let workRepo: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-wf-push-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
    bareRemote = mkdtempSync(join(tmpdir(), "vibebook-wf-bare-"));
    const { simpleGit } = await import("simple-git");
    await simpleGit(bareRemote).init({ "--bare": null });
    workRepo = mkdtempSync(join(tmpdir(), "vibebook-wf-clone-"));
    const g = simpleGit(workRepo);
    await g.init();
    await g.addRemote("origin", bareRemote);
    await g.addConfig("user.email", "t@example.com");
    await g.addConfig("user.name", "Tester");
    // Simulate the user having pushed at least one commit on their device
    // branch — gives the bare remote at least one ref to fetch.
    await g.checkoutLocalBranch("test-device");
    writeFileSync(join(workRepo, "README.md"), "seed\n");
    await g.add(".");
    await g.commit("seed");
    await g.push("origin", "test-device");
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath: workRepo, repoUrl: bareRemote,
      deviceBranch: "test-device",
      runner: "claude-cli",
      enableAggregateCI: true,
      threadingConcurrency: 4, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(bareRemote, { recursive: true, force: true });
    rmSync(workRepo, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("works when primary working tree is already on main (regression: was hitting 'main is already used by worktree')", async () => {
    // Pre-condition: user's session-repo is on `main` branch (e.g. fresh init, no device branch yet)
    const { simpleGit } = await import("simple-git");
    const g = simpleGit(workRepo);
    // First, push device branch so origin has at least one ref
    // (already done in beforeEach via the "seed" commit + push to test-device)
    // Now switch primary working tree to main (creating it if needed)
    try {
      await g.checkout("main");
    } catch {
      await g.raw(["checkout", "--orphan", "main"]);
      await g.raw(["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
      writeFileSync(join(workRepo, ".keep"), "init\n");
      await g.add(".keep");
      await g.commit("init main");
      await g.push("origin", "main", ["-u"]);
    }
    // Sanity: confirm primary working tree is currently on main
    const status = await g.status();
    expect(status.current).toBe("main");

    // NOW run workflow init. Previously this failed with
    //   fatal: 'main' is already used by worktree at '<workRepo>'
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await expect(workflowInitCmd({})).resolves.not.toThrow();

    // Verify origin/main has the workflow + script
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-mainconflict-"));
    await simpleGit().clone(bareRemote, verifyClone);
    await simpleGit(verifyClone).checkout("main");
    expect(existsSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(true);
    expect(existsSync(join(verifyClone, "scripts", "merge-books.mjs"))).toBe(true);
    rmSync(verifyClone, { recursive: true, force: true });

    // Verify no leftover temp branches in the primary repo
    const branches = await g.branch();
    const tempBranches = branches.all.filter((b) => b.startsWith("vibebook-tmp-"));
    expect(tempBranches).toEqual([]);
  }, 30_000);

  it("commits and pushes workflow yaml + merge-books.mjs to origin/main (not device branch)", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});

    // Bare remote should now have a main ref with the workflow + script.
    const { simpleGit } = await import("simple-git");
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-verify-"));
    await simpleGit().clone(bareRemote, verifyClone);
    const g = simpleGit(verifyClone);
    await g.checkout("main");
    expect(existsSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(true);
    expect(existsSync(join(verifyClone, "scripts", "merge-books.mjs"))).toBe(true);
    // The yaml on main should have the locale placeholder substituted to "en"
    // (matches config's default bookLocale).
    const yamlBody = readFileSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"), "utf8");
    expect(yamlBody).toContain('VIBEBOOK_LOCALE: "en"');
    expect(yamlBody).not.toContain("__VIBEBOOK_LOCALE__");
    // Device branch test-device should NOT have these (clean separation)
    await g.checkout("test-device");
    expect(existsSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(false);
    expect(existsSync(join(verifyClone, "scripts", "merge-books.mjs"))).toBe(false);
    rmSync(verifyClone, { recursive: true, force: true });
  }, 30_000);

  it("substitutes bookLocale=zh from config into the workflow yaml", async () => {
    // Override config's bookLocale to zh
    const cfgPath = join(tmpHome, ".vibebook", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.bookLocale = "zh";
    writeFileSync(cfgPath, JSON.stringify(cfg));

    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});

    const { simpleGit } = await import("simple-git");
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-zh-"));
    await simpleGit().clone(bareRemote, verifyClone);
    await simpleGit(verifyClone).checkout("main");
    const yamlBody = readFileSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"), "utf8");
    expect(yamlBody).toContain('VIBEBOOK_LOCALE: "zh"');
    rmSync(verifyClone, { recursive: true, force: true });
  }, 30_000);

  it("leaves user's primary working tree on the device branch untouched", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});

    // The user's workRepo should still be on test-device with no .github/
    // or scripts/ written into the working tree (those went to main via
    // the temp worktree).
    const { simpleGit } = await import("simple-git");
    const g = simpleGit(workRepo);
    const status = await g.status();
    expect(status.current).toBe("test-device");
    expect(existsSync(join(workRepo, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(false);
    expect(existsSync(join(workRepo, "scripts", "merge-books.mjs"))).toBe(false);
  }, 30_000);

  it("is idempotent — running twice doesn't double-commit", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({});
    await workflowInitCmd({});

    const { simpleGit } = await import("simple-git");
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-verify2-"));
    await simpleGit().clone(bareRemote, verifyClone);
    const g = simpleGit(verifyClone);
    await g.checkout("main");
    const log = await g.log();
    // Only one workflow-install commit (no Tester seed on main).
    expect(log.all.length).toBe(1);
    expect(log.all[0].message).toMatch(/install.*workflow/i);
    rmSync(verifyClone, { recursive: true, force: true });
  }, 30_000);

  it("--no-push warns and exits cleanly without touching either branch", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });

    // Bare remote should NOT have a main ref.
    const { simpleGit } = await import("simple-git");
    const branches = await simpleGit(bareRemote).branch();
    expect(branches.all).not.toContain("main");
    // User's working tree untouched.
    expect(existsSync(join(workRepo, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(false);
  }, 30_000);
});
