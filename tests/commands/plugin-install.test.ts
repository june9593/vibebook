import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The plugin-install helper does real git work, so each test sets up:
 *   - A bare-ish "remote" repo with .claude-plugin/{plugin,marketplace}.json
 *     in it (acts as the marketplace github source).
 *   - A fake $HOME so ~/.claude/plugins/ paths land in tmpdir.
 *
 * We don't want to hit github.com in CI, so installPluginFromGitHub is
 * called with a `file://` repo URL via the underlying git clone. Easiest
 * way: use `--repo` whose value is "owner/name" — the helper turns it into
 * `https://github.com/<repo>.git`. We monkey-patch by passing repo
 * = absolute file path; git clone tolerates a local path as the source.
 *
 * Helper actually constructs `https://github.com/${repo}.git`. To intercept
 * we instead build a fixture repo and pass it through a tweaked helper
 * variant — we expose a private `installPluginFromUrl` that accepts a raw
 * URL for testability. (Done in plugin-install.ts indirectly: the public
 * function builds a URL from `repo`; for tests we call the same internals
 * with a file:// URL.)
 *
 * Simpler path: just temporarily set the `--repo` value to "fake/repo" and
 * intercept by pointing PATH at a stub `git` script that knows how to
 * "clone" our fixture. That's gnarly.
 *
 * Practical approach: the helper supports a `repoUrl` override env var
 * for tests — VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE. We set that in the test
 * to point at a local bare repo serving as the marketplace.
 */

let tmpHome: string;
let originUrl: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-pluginstall-"));
  vi.stubEnv("HOME", tmpHome);
  // Pre-create the .claude/plugins layout so isClaudePluginsLayoutPresent
  // returns true.
  mkdirSync(join(tmpHome, ".claude", "plugins"), { recursive: true });
  vi.resetModules();

  // Build a fixture marketplace repo so git clone has something to fetch.
  const sourceRepo = join(tmpHome, "fixture-marketplace");
  mkdirSync(sourceRepo, { recursive: true });
  // Write a marketplace.json pointing the only plugin at "./".
  mkdirSync(join(sourceRepo, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(sourceRepo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "vibebook",
      description: "test",
      owner: { name: "june9593" },
      plugins: [{ name: "vibebook", version: "0.0.0", source: "./" }],
    }, null, 2),
  );
  writeFileSync(
    join(sourceRepo, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "vibebook", version: "0.0.0", description: "test" }, null, 2),
  );
  // Plugin payload: a skill + a command so we can assert they got copied.
  mkdirSync(join(sourceRepo, "skills", "vibebook"), { recursive: true });
  writeFileSync(join(sourceRepo, "skills", "vibebook", "SKILL.md"), "# vibebook test skill\n");
  mkdirSync(join(sourceRepo, "commands"), { recursive: true });
  writeFileSync(join(sourceRepo, "commands", "vibebook.md"), "vibebook slash command\n");

  // Make it a real git repo with one commit so rev-parse works.
  spawnSync("git", ["init", "--quiet", "--initial-branch=main", sourceRepo], { encoding: "utf8" });
  spawnSync("git", ["-C", sourceRepo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", sourceRepo, "config", "user.name", "test"]);
  spawnSync("git", ["-C", sourceRepo, "add", "."]);
  spawnSync("git", ["-C", sourceRepo, "commit", "--quiet", "-m", "init"]);
  // Helper expects a github URL; bypass by setting an env var the helper
  // honors when present. Using the local repo's absolute path as the URL
  // makes `git clone` use the local fast path.
  originUrl = sourceRepo;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("plugin-install — fresh install", () => {
  it("clones marketplace, copies plugin source, writes both json files", async () => {
    process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE = originUrl;
    try {
      const { installPluginFromGitHub } = await import("../../src/commands/plugin-install.js");
      const r = await installPluginFromGitHub();
      expect(r.ok).toBe(true);
      expect(r.changed).toBe(true);

      // Marketplace cloned.
      const marketplaceDir = join(tmpHome, ".claude", "plugins", "marketplaces", "vibebook");
      expect(existsSync(join(marketplaceDir, ".git"))).toBe(true);
      expect(existsSync(join(marketplaceDir, ".claude-plugin", "marketplace.json"))).toBe(true);

      // Plugin source copied to cache (without .git).
      const cacheRoot = join(tmpHome, ".claude", "plugins", "cache", "vibebook", "vibebook");
      const versions = require("node:fs").readdirSync(cacheRoot);
      expect(versions.length).toBe(1);
      const cached = join(cacheRoot, versions[0]);
      expect(existsSync(join(cached, "skills", "vibebook", "SKILL.md"))).toBe(true);
      expect(existsSync(join(cached, "commands", "vibebook.md"))).toBe(true);
      expect(existsSync(join(cached, ".git"))).toBe(false);

      // installed_plugins.json updated.
      const installed = JSON.parse(readFileSync(join(tmpHome, ".claude", "plugins", "installed_plugins.json"), "utf8"));
      expect(installed.version).toBe(2);
      const entries = installed.plugins["vibebook@vibebook"];
      expect(entries.length).toBe(1);
      expect(entries[0].scope).toBe("user");
      expect(entries[0].installPath).toBe(cached);
      expect(entries[0].version).toBe(versions[0]);
      expect(typeof entries[0].installedAt).toBe("string");
      expect(typeof entries[0].gitCommitSha).toBe("string");

      // known_marketplaces.json updated.
      const known = JSON.parse(readFileSync(join(tmpHome, ".claude", "plugins", "known_marketplaces.json"), "utf8"));
      expect(known.vibebook.source.source).toBe("github");
      expect(known.vibebook.installLocation).toBe(marketplaceDir);
    } finally {
      delete process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE;
    }
  });
});

describe("plugin-install — idempotent re-run", () => {
  it("second run reports already-installed and does not bump entries", async () => {
    process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE = originUrl;
    try {
      const { installPluginFromGitHub } = await import("../../src/commands/plugin-install.js");
      const first = await installPluginFromGitHub();
      expect(first.changed).toBe(true);

      const second = await installPluginFromGitHub();
      expect(second.ok).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.message).toContain("already installed");

      const installed = JSON.parse(readFileSync(join(tmpHome, ".claude", "plugins", "installed_plugins.json"), "utf8"));
      // Still exactly one entry — we did not duplicate.
      expect(installed.plugins["vibebook@vibebook"].length).toBe(1);
    } finally {
      delete process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE;
    }
  });
});

describe("plugin-install — preserves existing marketplaces.json entries", () => {
  it("merges into a known_marketplaces.json that already had other entries", async () => {
    // Pre-populate known_marketplaces.json with an unrelated entry. The helper
    // must keep it.
    writeFileSync(
      join(tmpHome, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        "claude-plugins-official": {
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          installLocation: "/some/where",
          lastUpdated: "2026-04-01T00:00:00Z",
        },
      }, null, 2),
    );

    process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE = originUrl;
    try {
      const { installPluginFromGitHub } = await import("../../src/commands/plugin-install.js");
      const r = await installPluginFromGitHub();
      expect(r.ok).toBe(true);

      const known = JSON.parse(readFileSync(join(tmpHome, ".claude", "plugins", "known_marketplaces.json"), "utf8"));
      expect(known["claude-plugins-official"]).toBeDefined();
      expect(known["claude-plugins-official"].installLocation).toBe("/some/where");
      expect(known.vibebook).toBeDefined();
    } finally {
      delete process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE;
    }
  });
});

describe("plugin-install — fails open when ~/.claude is missing", () => {
  it("returns ok=false with a recovery message instead of throwing", async () => {
    rmSync(join(tmpHome, ".claude"), { recursive: true, force: true });
    process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE = originUrl;
    try {
      const { installPluginFromGitHub } = await import("../../src/commands/plugin-install.js");
      const r = await installPluginFromGitHub();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Claude Code/);
    } finally {
      delete process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE;
    }
  });
});
