import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, ensureDeviceBranchOnConfig, readConfigWithMigration } from "../../src/commands/sync.js";
import { loadIndex } from "../../src/index-store.js";
import * as configModule from "../../src/config.js";
import type { Config } from "../../src/config.js";

function baseCfg(overrides: Partial<Config> = {}): Config {
  return {
    repoPath: "/tmp/x",
    repoUrl: "git@example.com:x.git",
    encrypt: false,
    salt: "AAAA",
    deviceBranch: "",
    runner: "claude-cli",
    
    enableAggregateCI: false,
    includeReasoning: true,
    threadingConcurrency: 4,
    threadingMaxAttempts: 3,
    digestEnabled: true,
    ...overrides,
  };
}

describe("ensureDeviceBranchOnConfig", () => {
  it("migrates when deviceBranch is empty string", () => {
    const r = ensureDeviceBranchOnConfig(baseCfg({ deviceBranch: "" }));
    expect(r.migrated).toBe(true);
    expect(r.cfg.deviceBranch.length).toBeGreaterThan(0);
  });
  it("no-op when deviceBranch is set", () => {
    const r = ensureDeviceBranchOnConfig(baseCfg({ deviceBranch: "my-device" }));
    expect(r.migrated).toBe(false);
    expect(r.cfg.deviceBranch).toBe("my-device");
  });
});

describe("readConfigWithMigration", () => {
  it("writes back the migrated config when deviceBranch was empty", () => {
    const cfg = baseCfg({ deviceBranch: "" });
    const writes: Config[] = [];
    const readSpy = vi.spyOn(configModule, "readConfig").mockReturnValue(cfg);
    const writeSpy = vi.spyOn(configModule, "writeConfig").mockImplementation((c) => { writes.push(c); });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = readConfigWithMigration();
      expect(result.deviceBranch.length).toBeGreaterThan(0);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.deviceBranch).toBe(result.deviceBranch);
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

describe("runSync — extract + raw push only (v0.2: no LLM)", () => {
  let repo: string;
  let claudeRoot: string;
  let vscodeRoot: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-repo-"));
    claudeRoot = mkdtempSync(join(tmpdir(), "vibebook-test-claude-fixture-"));
    const proj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
    vscodeRoot = mkdtempSync(join(tmpdir(), "memvc-vscode-"));
  });

  it("extracts new sessions, writes files, updates index", async () => {
    const result = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
    });
    expect(result.newCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    const idx = loadIndex(repo);
    expect(Object.keys(idx.entries).length).toBe(1);
    const entry = Object.values(idx.entries)[0]!;
    expect(existsSync(join(repo, entry.relativePath))).toBe(true);
    // Markdown sibling exists
    const mdPath = entry.relativePath.replace(".raw.json", ".md");
    expect(existsSync(join(repo, mdPath))).toBe(true);
  });

  it("skips unchanged sessions on second run", async () => {
    await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    const result2 = await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    expect(result2.newCount).toBe(0);
    expect(result2.skippedCount).toBe(1);
  });

  it("never creates book/ — that's /vibebook's job, not sync's", async () => {
    await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    expect(existsSync(join(repo, "book"))).toBe(false);
    expect(existsSync(join(repo, ".vibebook/index.book.json"))).toBe(false);
  });
});
