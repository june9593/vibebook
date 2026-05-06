import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";

/**
 * `vibebook doctor` — opinionated health check. Prints a one-line status
 * for each thing that can drift between the user's machines, then a
 * summary with the precise commands to fix anything red.
 *
 * What we check:
 *   1. CLI version on PATH (`vibebook --version`)
 *   2. Latest published version on npm (`npm view vibebook version`)
 *   3. Claude plugin manifest version (the marketplace.json that was
 *      cloned into ~/.claude/plugins/marketplaces/vibebook/)
 *   4. Plugin install entry version (~/.claude/plugins/installed_plugins.json)
 *   5. `~/.vibebook/config.json` exists, repoPath exists + is a git repo
 *   6. git crypt filter wired (when config.encrypt = true)
 *   7. memex on PATH (informational; not an error if missing)
 *
 * The check is read-only and offline-tolerant — `npm view` is the only
 * step that needs network and we surface the failure inline rather
 * than aborting.
 */

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  /** Optional shell command that fixes this. */
  fix?: string;
}

export async function doctorCmd(): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. CLI on PATH
  const cliVersion = readPathCliVersion();
  if (cliVersion) {
    checks.push({ name: "CLI on PATH", status: "ok", detail: `vibebook ${cliVersion}` });
  } else {
    checks.push({
      name: "CLI on PATH", status: "fail",
      detail: "vibebook --version did not respond",
      fix: "npm install -g vibebook@latest",
    });
  }

  // 2. npm latest
  const npmLatest = readNpmLatestVersion();
  if (npmLatest) {
    if (cliVersion && cliVersion !== npmLatest) {
      checks.push({
        name: "CLI vs npm latest", status: "warn",
        detail: `local ${cliVersion} · npm ${npmLatest}`,
        fix: "vibebook upgrade",
      });
    } else if (cliVersion) {
      checks.push({ name: "CLI vs npm latest", status: "ok", detail: `${cliVersion} = ${npmLatest}` });
    }
  } else {
    checks.push({
      name: "CLI vs npm latest", status: "info",
      detail: "couldn't reach npm registry (offline?)",
    });
  }

  // 3 + 4. Claude plugin
  const pluginManifestVersion = readPluginManifestVersion();
  const pluginInstallEntry = readInstalledPluginEntry();
  if (pluginManifestVersion === null && pluginInstallEntry === null) {
    checks.push({
      name: "Claude plugin", status: "fail",
      detail: "no marketplace + no installed_plugins entry",
      fix: "vibebook plugin-install",
    });
  } else {
    if (pluginManifestVersion) {
      const matchesCli = !cliVersion || cliVersion === pluginManifestVersion;
      checks.push({
        name: "Claude plugin manifest", status: matchesCli ? "ok" : "warn",
        detail: matchesCli
          ? `vibebook plugin v${pluginManifestVersion}`
          : `manifest v${pluginManifestVersion} · CLI v${cliVersion} (mismatch)`,
        fix: matchesCli ? undefined : "vibebook upgrade",
      });
    } else {
      checks.push({
        name: "Claude plugin manifest", status: "warn",
        detail: "marketplace clone present but no plugin.json — partial install?",
        fix: "vibebook plugin-install",
      });
    }

    if (pluginInstallEntry) {
      const installedAt = pluginInstallEntry.installedAt?.slice(0, 10) ?? "?";
      checks.push({
        name: "Plugin installed entry", status: "ok",
        detail: `cache sha=${pluginInstallEntry.version} · installed ${installedAt}`,
      });
    } else {
      checks.push({
        name: "Plugin installed entry", status: "warn",
        detail: "marketplace cloned but installed_plugins.json missing this plugin",
        fix: "vibebook plugin-install",
      });
    }
  }

  // 5. Config + repoPath
  const config = readConfigSafe();
  if (!config) {
    checks.push({
      name: "vibebook config", status: "fail",
      detail: "~/.vibebook/config.json missing",
      fix: "vibebook init",
    });
  } else {
    const repoExists = existsSync(config.repoPath);
    const repoHasGit = repoExists && existsSync(join(config.repoPath, ".git"));
    if (!repoExists) {
      checks.push({
        name: "Session repo", status: "fail",
        detail: `repoPath ${config.repoPath} does not exist`,
        fix: "vibebook init   # re-clone",
      });
    } else if (!repoHasGit) {
      checks.push({
        name: "Session repo", status: "warn",
        detail: `${config.repoPath} exists but is not a git repo`,
      });
    } else {
      checks.push({
        name: "Session repo", status: "ok",
        detail: `${config.repoPath} (${config.repoUrl || "local-only"})`,
      });
    }

    // 6. Git filter (only when encrypt = true)
    if (config.encrypt && repoHasGit) {
      const filterWired = isCryptFilterWired(config.repoPath);
      checks.push({
        name: "Git crypt filter", status: filterWired ? "ok" : "warn",
        detail: filterWired
          ? "vibebook clean/smudge filter wired"
          : "encrypt=true in config but git filter not wired in this clone",
        fix: filterWired ? undefined : `cd "${config.repoPath}" && vibebook crypt init`,
      });
    }
  }

  // 7. memex (informational)
  const memexVersion = readMemexVersion();
  if (memexVersion) {
    checks.push({
      name: "Memex (optional)", status: "ok",
      detail: `${memexVersion} — /vibebook recall folds memex cards in automatically`,
    });
  } else {
    checks.push({
      name: "Memex (optional)", status: "info",
      detail: "not installed — atomic-card layer is unavailable",
      fix: "npm install -g @touchskyer/memex   # only if you want atomic cards",
    });
  }

  // ---------- render ----------
  const symbol: Record<CheckResult["status"], string> = {
    ok: chalk.green("✓"),
    warn: chalk.yellow("!"),
    fail: chalk.red("✗"),
    info: chalk.gray("·"),
  };
  for (const c of checks) {
    console.log(`${symbol[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
  }

  const fixes = checks.filter((c) => c.fix);
  if (fixes.length > 0) {
    console.log(chalk.cyan("\nSuggested fixes:"));
    const seen = new Set<string>();
    for (const c of fixes) {
      if (seen.has(c.fix!)) continue;
      seen.add(c.fix!);
      console.log(`  ${c.fix}`);
    }
  } else {
    console.log(chalk.green("\nAll checks passed."));
  }

  // Exit non-zero only if a `fail`. `warn` is on you to interpret.
  const hasFail = checks.some((c) => c.status === "fail");
  process.exit(hasFail ? 1 : 0);
}

// ---------- check primitives ----------

function readPathCliVersion(): string | null {
  // Use --version (mapped to -v in 0.3.1+); fall back to -V which still
  // works on older releases.
  for (const flag of ["--version", "-V"]) {
    const r = spawnSync("vibebook", [flag], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
    });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

function readNpmLatestVersion(): string | null {
  const r = spawnSync("npm", ["view", "vibebook", "version"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

function readPluginManifestVersion(): string | null {
  const path = join(homedir(), ".claude", "plugins", "marketplaces", "vibebook", ".claude-plugin", "marketplace.json");
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    const plugin = json.plugins?.find((p: { name: string }) => p.name === "vibebook");
    return plugin?.version ?? null;
  } catch {
    return null;
  }
}

interface InstalledEntry {
  version: string;
  installPath: string;
  installedAt: string;
  gitCommitSha?: string;
}

function readInstalledPluginEntry(): InstalledEntry | null {
  const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    const entries = json.plugins?.["vibebook@vibebook"] ?? [];
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

interface MinimalConfig {
  repoPath: string;
  repoUrl?: string;
  encrypt?: boolean;
}

function readConfigSafe(): MinimalConfig | null {
  const path = join(homedir(), ".vibebook", "config.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isCryptFilterWired(repoPath: string): boolean {
  // git config --get returns 0 if the key is set; we check the smudge half
  // since clean+smudge are wired together.
  const r = spawnSync("git", ["-C", repoPath, "config", "--get", "filter.vibebook.smudge"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function readMemexVersion(): string | null {
  const r = spawnSync("memex", ["--version"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}
