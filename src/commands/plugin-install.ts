import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import chalk from "chalk";

/**
 * Install or update vibebook as a Claude Code plugin without going through
 * the `/plugin marketplace add` + `/plugin install` REPL flow.
 *
 * Why we do this directly: a fresh-install user has just run `vibebook init`
 * from a shell. Asking them to switch to the Claude Code REPL just to copy-
 * paste two `/plugin` lines is an avoidable trip-hazard — most users skip it
 * and then wonder why /vibebook doesn't appear.
 *
 * Strategy mirrors what Claude Code itself does on `/plugin install`:
 *   1. git clone <repo> → ~/.claude/plugins/marketplaces/<name>/
 *      (or `git pull` if it already exists).
 *   2. Read .claude-plugin/marketplace.json from the cloned repo to get
 *      every plugin entry (typically just one for us).
 *   3. For each plugin: short SHA = `git rev-parse --short HEAD`; copy
 *      the plugin source dir → ~/.claude/plugins/cache/<marketplace>/<plugin>/<sha>/.
 *   4. Update ~/.claude/plugins/known_marketplaces.json + installed_plugins.json
 *      atomically (read-merge-write).
 *
 * Fail-open: any step that errors leaves the previous state intact and
 * surfaces a manual-command fallback so the user can recover with
 * `/plugin marketplace add` + `/plugin install`. We never throw out of
 * the wizard for a plugin-install failure.
 *
 * Idempotency: re-running is safe. If marketplace + plugin are already
 * installed at the same git SHA, this is a no-op (logs "already installed").
 */

export interface PluginInstallOptions {
  /** GitHub repo, "owner/name" form. Defaults to vibebook's. */
  repo?: string;
  /** Marketplace name (matches .claude-plugin/marketplace.json `name`).
   *  Defaults to "vibebook". */
  marketplaceName?: string;
}

export interface PluginInstallResult {
  /** True if at least one plugin was installed or updated. */
  changed: boolean;
  /** True if everything is fine (already-installed counts as success). */
  ok: boolean;
  /** Human-readable summary; safe to print directly. */
  message: string;
}

const PLUGINS_ROOT = join(homedir(), ".claude", "plugins");
const MARKETPLACES_DIR = join(PLUGINS_ROOT, "marketplaces");
const CACHE_DIR = join(PLUGINS_ROOT, "cache");
const KNOWN_MARKETPLACES = join(PLUGINS_ROOT, "known_marketplaces.json");
const INSTALLED_PLUGINS = join(PLUGINS_ROOT, "installed_plugins.json");

const DEFAULT_REPO = "june9593/vibebook";
const DEFAULT_MARKETPLACE = "vibebook";

export async function installPluginFromGitHub(
  opts: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const repo = opts.repo ?? DEFAULT_REPO;
  const marketplaceName = opts.marketplaceName ?? DEFAULT_MARKETPLACE;
  // Tests set VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE to a local fixture path so
  // the helper never reaches out to github.com in CI. Production users
  // never see this env var.
  const repoUrl = process.env.VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE
    ?? `https://github.com/${repo}.git`;

  if (!isClaudePluginsLayoutPresent()) {
    return {
      changed: false, ok: false,
      message: `Claude Code plugin layout not found at ${PLUGINS_ROOT}. Install Claude Code first, or run \`/plugin marketplace add ${repo}\` from the Claude Code REPL.`,
    };
  }

  // Step 1 — marketplace clone or pull.
  const marketplaceDir = join(MARKETPLACES_DIR, marketplaceName);
  mkdirSync(MARKETPLACES_DIR, { recursive: true });
  let cloneNote = "";
  if (!existsSync(join(marketplaceDir, ".git"))) {
    const r = spawnSync("git", ["clone", "--depth=1", repoUrl, marketplaceDir], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      return {
        changed: false, ok: false,
        message: `git clone failed: ${(r.stderr || "").trim() || r.error?.message || "unknown error"}`,
      };
    }
    cloneNote = "cloned";
  } else {
    const r = spawnSync("git", ["-C", marketplaceDir, "pull", "--ff-only"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      return {
        changed: false, ok: false,
        message: `git pull failed: ${(r.stderr || "").trim() || r.error?.message || "unknown error"}`,
      };
    }
    cloneNote = "updated";
  }

  // Step 2 — read marketplace.json.
  const marketplaceJsonPath = join(marketplaceDir, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplaceJsonPath)) {
    return {
      changed: false, ok: false,
      message: `${marketplaceName} repo has no .claude-plugin/marketplace.json — can't install`,
    };
  }
  let marketplaceManifest: { plugins?: Array<{ name: string; source?: string }> };
  try {
    marketplaceManifest = JSON.parse(readFileSync(marketplaceJsonPath, "utf8"));
  } catch (e) {
    return {
      changed: false, ok: false,
      message: `marketplace.json is not valid JSON: ${(e as Error).message}`,
    };
  }
  const plugins = marketplaceManifest.plugins ?? [];
  if (plugins.length === 0) {
    return {
      changed: false, ok: false,
      message: `marketplace.json declared no plugins`,
    };
  }

  // Step 3 — short SHA for cache key.
  const shaResult = spawnSync("git", ["-C", marketplaceDir, "rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (shaResult.status !== 0) {
    return {
      changed: false, ok: false,
      message: `git rev-parse failed: ${(shaResult.stderr || "").trim()}`,
    };
  }
  const shortSha = shaResult.stdout.trim();
  const longShaResult = spawnSync("git", ["-C", marketplaceDir, "rev-parse", "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const longSha = longShaResult.stdout.trim();

  // Step 4 — install each plugin.
  const installed = readJsonSafe(INSTALLED_PLUGINS, { version: 2, plugins: {} as Record<string, PluginEntry[]> });
  let changed = false;
  const installedNames: string[] = [];
  const skippedNames: string[] = [];

  for (const plugin of plugins) {
    const pluginKey = `${plugin.name}@${marketplaceName}`;
    const cachePath = join(CACHE_DIR, marketplaceName, plugin.name, shortSha);
    const existingEntries = installed.plugins[pluginKey] ?? [];
    const alreadyAtThisSha = existingEntries.some((e) => e.version === shortSha && existsSync(e.installPath));
    if (alreadyAtThisSha) {
      skippedNames.push(plugin.name);
      continue;
    }

    // Copy plugin source dir into cache. `source: "./"` means whole repo.
    const sourceRel = plugin.source ?? "./";
    const sourceAbs = resolve(marketplaceDir, sourceRel);
    if (!existsSync(sourceAbs)) {
      // Skip this plugin but don't fail the whole install — other plugins
      // in the marketplace might still be valid.
      console.error(chalk.yellow(`  ! plugin '${plugin.name}' source path missing: ${sourceAbs}`));
      continue;
    }
    if (existsSync(cachePath)) {
      // Defensive: cache dir exists but installed_plugins.json doesn't
      // know about it (manual edit, crash mid-install, etc.). Wipe and re-copy.
      rmSync(cachePath, { recursive: true, force: true });
    }
    mkdirSync(cachePath, { recursive: true });
    copyPluginSource(sourceAbs, cachePath);

    const now = new Date().toISOString();
    const newEntry: PluginEntry = {
      scope: "user",
      installPath: cachePath,
      version: shortSha,
      installedAt: existingEntries[0]?.installedAt ?? now,
      lastUpdated: now,
      gitCommitSha: longSha,
    };
    installed.plugins[pluginKey] = [
      newEntry,
      ...existingEntries.filter((e) => e.version !== shortSha),
    ];
    installedNames.push(plugin.name);
    changed = true;
  }

  // Step 5 — known_marketplaces.json.
  const known = readJsonSafe<Record<string, KnownMarketplaceEntry>>(KNOWN_MARKETPLACES, {});
  known[marketplaceName] = {
    source: { source: "github", repo },
    installLocation: marketplaceDir,
    lastUpdated: new Date().toISOString(),
  };
  writeJsonAtomic(KNOWN_MARKETPLACES, known);
  writeJsonAtomic(INSTALLED_PLUGINS, installed);

  const summary = installedNames.length > 0
    ? `installed: ${installedNames.join(", ")} (marketplace ${cloneNote})`
    : `already installed at ${shortSha} (marketplace ${cloneNote})`;
  return {
    changed,
    ok: true,
    message: summary + (skippedNames.length > 0 ? ` · skipped (already current): ${skippedNames.join(", ")}` : ""),
  };
}

// ----- helpers -----

interface PluginEntry {
  scope: "user" | "project";
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
}

interface KnownMarketplaceEntry {
  source: { source: "github"; repo: string };
  installLocation: string;
  lastUpdated: string;
}

function isClaudePluginsLayoutPresent(): boolean {
  // Heuristic: we expect either the json files OR the marketplaces/cache
  // directories to already exist. This guards against running on a host
  // that doesn't have Claude Code installed at all.
  return existsSync(PLUGINS_ROOT) || existsSync(join(homedir(), ".claude"));
}

function readJsonSafe<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  // Mirror Claude Code's own write pattern (it uses .tmp suffix). We don't
  // need crash-safety guarantees here — just want to avoid a partial write
  // racing with Claude Code reading.
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  // rename is atomic on POSIX.
  spawnSync("mv", [tmp, path]);
}

function copyPluginSource(src: string, dst: string): void {
  // Don't ship .git from the marketplace clone — the cache copy is a
  // snapshot, not a working tree.
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => !s.includes(`${"/"}.git${"/"}`) && !s.endsWith("/.git"),
  });
}
