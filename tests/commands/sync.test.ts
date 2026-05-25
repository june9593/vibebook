import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    const proj = join(claudeRoot, "-Users-me-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude", "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
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

  it("skips empty-shell sessions (0 messages) without writing files or indexing", async () => {
    // Plant a Copilot empty-shell chatSessions file alongside the existing
    // fixtures. VS Code creates these for every chat tab opened — even
    // ones the user immediately closes.
    const emptyWs = join(vscodeRoot, "hashEmpty");
    mkdirSync(join(emptyWs, "chatSessions"), { recursive: true });
    cpSync(
      join(fixturesDir, "copilot", "workspace.json"),
      join(emptyWs, "workspace.json"),
    );
    // kind=0 init + kind=1 patch, no requests = empty shell. Mirrors the
    // shape we found across 142 such files on Yue's machine.
    const shell = [
      JSON.stringify({ kind: 0, v: { version: 3, sessionId: "empty-shell-cccc", requests: [] } }),
      JSON.stringify({ kind: 1, k: ["responderUsername"], v: "GitHub Copilot" }),
    ].join("\n") + "\n";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(emptyWs, "chatSessions", "empty-shell-cccc.jsonl"), shell);

    const result = await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    // 1 real claude session written, 1 empty shell skipped
    expect(result.newCount).toBe(1);
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);

    // No 1970-01-01 directory created for the empty shell
    expect(existsSync(join(repo, "raw_sessions/copilot"))).toBe(false);
  });
});

describe("runSync — workflow file inheritance from main (P1, 0.8.1)", () => {
  let bareRemote: string;
  let workRepo: string;
  let tmpHome: string;
  let claudeRoot: string;
  let vscodeRoot: string;

  beforeEach(async () => {
    const { writeFileSync } = await import("node:fs");
    const { simpleGit } = await import("simple-git");

    tmpHome = mkdtempSync(join(tmpdir(), "vb-wfsync-home-"));
    vi.stubEnv("HOME", tmpHome);

    bareRemote = mkdtempSync(join(tmpdir(), "vb-wfsync-bare-"));
    await simpleGit().cwd(bareRemote).raw(["init", "--bare", "-b", "main"]);

    // Plant `.github/workflows/vibebook-aggregate.yml` on the bare's main.
    const seed = mkdtempSync(join(tmpdir(), "vb-wfsync-seed-"));
    const sg = simpleGit(seed);
    await sg.raw(["init", "-b", "main"]);
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    mkdirSync(join(seed, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(seed, ".github/workflows/vibebook-aggregate.yml"),
      "name: vibebook aggregate book\non: { push: { branches-ignore: [main] } }\njobs: { aggregate: { runs-on: ubuntu-latest, steps: [{ run: 'echo hi' }] } }\n",
    );
    await sg.add(".");
    await sg.commit("seed main with aggregate workflow");
    await sg.addRemote("origin", bareRemote);
    await sg.push("origin", "main");

    // Now set up the user's workRepo cloning from bare and switching to a
    // fresh device branch (no .github/ in the working tree yet).
    workRepo = mkdtempSync(join(tmpdir(), "vb-wfsync-clone-"));
    await simpleGit().clone(bareRemote, workRepo);
    const wg = simpleGit(workRepo);
    await wg.addConfig("user.email", "u@u");
    await wg.addConfig("user.name", "u");
    // Branch off main and DELETE .github/ to simulate the "fresh device
    // after wipe+reinit" state where the device branch starts empty.
    await wg.checkoutLocalBranch("mini-fresh");
    await wg.raw(["rm", "-rf", ".github"]);
    await wg.commit("wipe", ["--allow-empty"]);

    claudeRoot = mkdtempSync(join(tmpdir(), "vb-wfsync-claude-"));
    const proj = join(claudeRoot, "-Users-me-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude", "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
    vscodeRoot = mkdtempSync(join(tmpdir(), "vb-wfsync-vscode-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("first push of a fresh device branch picks up .github/workflows/vibebook-aggregate.yml from main, commits and pushes it", async () => {
    await runSync({
      repoPath: workRepo, claudeRoot, vscodeRoot,
      encrypt: false,
      push: true,
      repoUrl: bareRemote,
      deviceBranch: "mini-fresh",
    });

    const { simpleGit } = await import("simple-git");
    // The file should now exist on the LOCAL device branch's working tree.
    expect(existsSync(join(workRepo, ".github/workflows/vibebook-aggregate.yml"))).toBe(true);

    // …and the bare remote's mini-fresh branch should also have it (= CI will now trigger on future pushes).
    const tip = await simpleGit(bareRemote).raw(["ls-tree", "-r", "mini-fresh"]);
    expect(tip).toContain(".github/workflows/vibebook-aggregate.yml");
  }, 30_000);

  it("no-op when device branch already has an identical workflow file", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { simpleGit } = await import("simple-git");
    // Plant the same workflow content locally first
    mkdirSync(join(workRepo, ".github/workflows"), { recursive: true });
    const wfContent = "name: vibebook aggregate book\non: { push: { branches-ignore: [main] } }\njobs: { aggregate: { runs-on: ubuntu-latest, steps: [{ run: 'echo hi' }] } }\n";
    writeFileSync(join(workRepo, ".github/workflows/vibebook-aggregate.yml"), wfContent);
    await simpleGit(workRepo).add(".github/workflows/vibebook-aggregate.yml");
    await simpleGit(workRepo).commit("pre-seed workflow on device branch");

    await runSync({
      repoPath: workRepo, claudeRoot, vscodeRoot,
      encrypt: false,
      push: true,
      repoUrl: bareRemote,
      deviceBranch: "mini-fresh",
    });

    // File still present (untouched)
    expect(readFileSync(join(workRepo, ".github/workflows/vibebook-aggregate.yml"), "utf8")).toBe(wfContent);
  }, 30_000);

  it("silently skips when main has no workflow file (fresh-remote, pre-`workflow init` case)", async () => {
    // Reset bare to one with no .github/
    const { writeFileSync } = await import("node:fs");
    const { simpleGit } = await import("simple-git");
    const freshBare = mkdtempSync(join(tmpdir(), "vb-wfsync-bare2-"));
    await simpleGit().cwd(freshBare).raw(["init", "--bare", "-b", "main"]);
    const seed = mkdtempSync(join(tmpdir(), "vb-wfsync-seed2-"));
    const sg = simpleGit(seed);
    await sg.raw(["init", "-b", "main"]);
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    writeFileSync(join(seed, "README.md"), "no workflow yet\n");
    await sg.add(".");
    await sg.commit("seed no-workflow main");
    await sg.addRemote("origin", freshBare);
    await sg.push("origin", "main");

    const freshClone = mkdtempSync(join(tmpdir(), "vb-wfsync-clone2-"));
    await simpleGit().clone(freshBare, freshClone);
    const wg = simpleGit(freshClone);
    await wg.addConfig("user.email", "u@u");
    await wg.addConfig("user.name", "u");
    await wg.checkoutLocalBranch("mini-fresh2");

    await runSync({
      repoPath: freshClone, claudeRoot, vscodeRoot,
      encrypt: false,
      push: true,
      repoUrl: freshBare,
      deviceBranch: "mini-fresh2",
    });

    // Workflow file should NOT have been created — main has none to copy.
    expect(existsSync(join(freshClone, ".github/workflows/vibebook-aggregate.yml"))).toBe(false);
  }, 30_000);
});
