import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("setMapPath", () => {
  let fakeHome: string;

  beforeEach(() => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), "vb-cfg-"));
    vi.stubEnv("HOME", fakeHome);
    mkdirSync(join(fakeHome, ".vibebook"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".vibebook/config.json"),
      JSON.stringify({
        repoPath: join(fakeHome, ".vibebook/session-repo"),
        repoUrl: "", encrypt: false, salt: "",
        deviceBranch: "test", runner: "claude-cli",
        enableAggregateCI: false, includeReasoning: true,
        threadingConcurrency: 4, threadingMaxAttempts: 3,
        digestEnabled: true,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("adds a single mapping when pathMap is empty", async () => {
    const { setMapPath } = await import("../../../src/commands/resume/config-pathmap.js");
    setMapPath("/Users/yueA=/Users/yueB");
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.pathMap).toEqual({ "/Users/yueA": "/Users/yueB" });
  });

  it("appends to existing pathMap", async () => {
    const { setMapPath } = await import("../../../src/commands/resume/config-pathmap.js");
    setMapPath("/Users/yueA=/Users/yueB");
    setMapPath("/Users/yueC=/Users/yueB");
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.pathMap).toEqual({
      "/Users/yueA": "/Users/yueB",
      "/Users/yueC": "/Users/yueB",
    });
  });

  it("overwrites when source prefix already exists", async () => {
    const { setMapPath } = await import("../../../src/commands/resume/config-pathmap.js");
    setMapPath("/Users/yueA=/Users/yueB");
    setMapPath("/Users/yueA=/Users/yueC");
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.pathMap).toEqual({ "/Users/yueA": "/Users/yueC" });
  });

  it("throws on malformed input (no =)", async () => {
    const { setMapPath } = await import("../../../src/commands/resume/config-pathmap.js");
    expect(() => setMapPath("/Users/yueA")).toThrow(/expected.*=.*/i);
  });

  it("throws when from or to is empty", async () => {
    const { setMapPath } = await import("../../../src/commands/resume/config-pathmap.js");
    expect(() => setMapPath("=/Users/yueB")).toThrow(/empty/i);
    expect(() => setMapPath("/Users/yueA=")).toThrow(/empty/i);
  });
});
