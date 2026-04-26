import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("workflowInitCmd", () => {
  let tmpHome: string;
  let repoPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-wf-"));
    vi.stubEnv("HOME", tmpHome);
    repoPath = join(tmpHome, "memvc-repo");
    mkdirSync(repoPath, { recursive: true });
    // Minimal config for readConfig().
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath, repoUrl: "git@example.com:u/r.git",
      encrypt: false, salt: "x",
      deviceBranch: "test.lan",
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

  it("writes both the workflow yaml and the merge-books.mjs script", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    const scriptOut = join(repoPath, "scripts", "merge-books.mjs");
    expect(existsSync(yamlOut)).toBe(true);
    expect(existsSync(scriptOut)).toBe(true);
    const yaml = readFileSync(yamlOut, "utf8");
    expect(yaml).toContain("vibebook aggregate book");
    expect(yaml).toContain("branches-ignore");
    expect(yaml).toContain("merge-books.mjs");
    // No longer calls an LLM → no GitHub Models / VIBEBOOK_PASSPHRASE refs.
    expect(yaml).not.toContain("VIBEBOOK_PASSPHRASE");
    expect(yaml).not.toContain("models.github.ai");
    expect(yaml).not.toContain("models: read");
    const script = readFileSync(scriptOut, "utf8");
    expect(script).toContain("Aggregate every device branch");
  });

  it("refuses to overwrite without --force", async () => {
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(yamlOut, "existing content\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    expect(readFileSync(yamlOut, "utf8")).toBe("existing content\n");
  });

  it("overwrites with --force", async () => {
    const yamlOut = join(repoPath, ".github", "workflows", "vibebook-aggregate.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(yamlOut, "existing\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ force: true, noPush: true });
    const body = readFileSync(yamlOut, "utf8");
    expect(body).not.toBe("existing\n");
    expect(body).toContain("vibebook aggregate book");
  });
});

describe("workflowInitCmd auto-push integration", () => {
  let tmpHome: string;
  let bareRemote: string;
  let workRepo: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "vibebook-wf-push-"));
    vi.stubEnv("HOME", tmpHome);
    bareRemote = mkdtempSync(join(tmpdir(), "vibebook-wf-bare-"));
    const { simpleGit } = await import("simple-git");
    await simpleGit(bareRemote).init({ "--bare": null });
    workRepo = mkdtempSync(join(tmpdir(), "vibebook-wf-clone-"));
    const g = simpleGit(workRepo);
    await g.init();
    await g.addRemote("origin", bareRemote);
    await g.addConfig("user.email", "t@example.com");
    await g.addConfig("user.name", "Tester");
    await g.checkoutLocalBranch("test.lan");
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath: workRepo, repoUrl: bareRemote,
      encrypt: false, salt: "x",
      deviceBranch: "test.lan",
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

  it("commits and pushes workflow yaml + merge-books.mjs to origin", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd();

    // bare remote should now have a commit on test.lan with both files.
    const { simpleGit } = await import("simple-git");
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-verify-"));
    await simpleGit().clone(bareRemote, verifyClone);
    const g = simpleGit(verifyClone);
    await g.checkout("test.lan");
    expect(existsSync(join(verifyClone, ".github", "workflows", "vibebook-aggregate.yml"))).toBe(true);
    expect(existsSync(join(verifyClone, "scripts", "merge-books.mjs"))).toBe(true);
    const log = await g.log();
    expect(log.all[0].message).toMatch(/vibebook.*aggregation/);
    rmSync(verifyClone, { recursive: true, force: true });
  }, 30_000);
});
