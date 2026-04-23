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
      encrypt: true, salt: "x",
      deviceBranch: "test.lan",
      runner: "github-action", runnerModel: "openai/gpt-4o-mini",
      threadingConcurrency: 4, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes the workflow file under repoPath/.github/workflows/", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    const out = join(repoPath, ".github", "workflows", "vibebook-digest.yml");
    expect(existsSync(out)).toBe(true);
    const body = readFileSync(out, "utf8");
    // Sanity: the template should at least mention these fixed strings.
    expect(body).toContain("vibebook digest");
    expect(body).toContain("VIBEBOOK_CI");
    expect(body).toContain("workflow_dispatch");
  });

  it("substitutes runnerModel from config (no leftover placeholder)", async () => {
    rmSync(join(tmpHome, ".vibebook", "config.json"));
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath, repoUrl: "git@example.com:u/r.git",
      encrypt: false, salt: "x",
      deviceBranch: "test.lan",
      runner: "github-action", runnerModel: "openai/gpt-4.1-mini",
      threadingConcurrency: 1, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    const body = readFileSync(join(repoPath, ".github", "workflows", "vibebook-digest.yml"), "utf8");
    expect(body).toContain('"runnerModel": "openai/gpt-4.1-mini"');
    expect(body).not.toContain("__VIBEBOOK_RUNNER_MODEL__");
  });

  it("falls back to gpt-4o-mini when config has empty runnerModel", async () => {
    rmSync(join(tmpHome, ".vibebook", "config.json"));
    writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify({
      repoPath, repoUrl: "git@example.com:u/r.git",
      encrypt: false, salt: "x",
      deviceBranch: "test.lan",
      runner: "github-action", runnerModel: "",
      threadingConcurrency: 1, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    const body = readFileSync(join(repoPath, ".github", "workflows", "vibebook-digest.yml"), "utf8");
    expect(body).toContain('"runnerModel": "openai/gpt-4o-mini"');
  });

  it("refuses to overwrite without --force", async () => {
    const out = join(repoPath, ".github", "workflows", "vibebook-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing content\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ noPush: true });
    expect(readFileSync(out, "utf8")).toBe("existing content\n");
  });

  it("overwrites with --force", async () => {
    const out = join(repoPath, ".github", "workflows", "vibebook-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ force: true, noPush: true });
    const body = readFileSync(out, "utf8");
    expect(body).not.toBe("existing\n");
    expect(body).toContain("vibebook digest");
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
      encrypt: true, salt: "fakesalt",
      deviceBranch: "test.lan",
      runner: "github-action", runnerModel: "openai/gpt-4o-mini",
      threadingConcurrency: 1, threadingMaxAttempts: 3,
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

  it("commits and pushes workflow yaml + repo-salt.json to origin", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd();

    // bare remote should now have a commit on test.lan with both files.
    const { simpleGit } = await import("simple-git");
    const verifyClone = mkdtempSync(join(tmpdir(), "vibebook-wf-verify-"));
    await simpleGit().clone(bareRemote, verifyClone);
    const g = simpleGit(verifyClone);
    await g.checkout("test.lan");
    expect(existsSync(join(verifyClone, ".github", "workflows", "vibebook-digest.yml"))).toBe(true);
    expect(existsSync(join(verifyClone, ".vibebook", "repo-salt.json"))).toBe(true);
    const log = await g.log();
    expect(log.all[0].message).toMatch(/vibebook.*workflow/);
    rmSync(verifyClone, { recursive: true, force: true });
  }, 30_000);
});
