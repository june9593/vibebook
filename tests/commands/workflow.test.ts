import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("workflowInitCmd", () => {
  let tmpHome: string;
  let repoPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-wf-"));
    vi.stubEnv("HOME", tmpHome);
    repoPath = join(tmpHome, "memvc-repo");
    mkdirSync(repoPath, { recursive: true });
    // Minimal config for readConfig().
    mkdirSync(join(tmpHome, ".memvc"), { recursive: true });
    writeFileSync(join(tmpHome, ".memvc", "config.json"), JSON.stringify({
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
    await workflowInitCmd();
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    expect(existsSync(out)).toBe(true);
    const body = readFileSync(out, "utf8");
    // Sanity: the template should at least mention these fixed strings.
    expect(body).toContain("memvc digest");
    expect(body).toContain("MEMVC_CI");
    expect(body).toContain("workflow_dispatch");
  });

  it("refuses to overwrite without --force", async () => {
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing content\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd();
    expect(readFileSync(out, "utf8")).toBe("existing content\n");
  });

  it("overwrites with --force", async () => {
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ force: true });
    const body = readFileSync(out, "utf8");
    expect(body).not.toBe("existing\n");
    expect(body).toContain("memvc digest");
  });
});
