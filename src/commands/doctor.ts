import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { isStableDeviceName } from "../device.js";

/**
 * `vibebook doctor` — opinionated health check. Prints a one-line status
 * for each thing that can drift between the user's machines, then a
 * summary with the precise commands to fix anything red.
 *
 * What we check:
 *   1. CLI version on PATH (`vibebook --version`)
 *   2. Latest published version on npm (`npm view vibebook version`)
 *   3. Claude plugin marketplace clone present at
 *      ~/.claude/plugins/marketplaces/vibebook-plugin/ (outside-in install).
 *      Informational — npm vibebook handles cross-device sync on its own;
 *      the plugin only adds chronicle digest + recall.
 *   4. `~/.vibebook/config.json` exists, repoPath exists + is a git repo
 *   5. Spool scan for orphan *.raw.json files with no sibling *.jsonl
 *      (sessions captured before v0.5.0 — `vibebook resume` can't replay
 *      those)
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

  // 3. Claude plugin (outside-in detection — the plugin lives in its own repo,
  //    cloned by Claude Code into ~/.claude/plugins/marketplaces/vibebook-plugin/
  //    when the user runs `/plugin marketplace add june9593/vibebook-plugin`.
  //    npm vibebook itself does not install the plugin.)
  const pluginMarketplacePath = join(
    homedir(), ".claude", "plugins", "marketplaces", "vibebook-plugin",
  );
  if (existsSync(pluginMarketplacePath)) {
    checks.push({
      name: "Claude plugin", status: "ok",
      detail: "vibebook-plugin marketplace registered",
    });
  } else {
    checks.push({
      name: "Claude plugin", status: "warn",
      detail: "vibebook-plugin (chronicle digest + recall) not installed",
      fix: "/plugin marketplace add june9593/vibebook-plugin && /plugin install vibebook   # optional — npm vibebook handles cross-device sync; the plugin handles digest + recall",
    });
  }

  // 4. Config + repoPath
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

    // 4b. Device branch drift check. hostname() on macOS varies across
    //     networks (mDNS / corp DHCP / hotspot) — if init wrote the volatile
    //     value, each network creates a new branch and the spool fragments.
    if (config.deviceBranch !== undefined) {
      if (!isStableDeviceName(config.deviceBranch)) {
        checks.push({
          name: "Device branch", status: "warn",
          detail: `'${config.deviceBranch}' looks like a volatile macOS hostname — sync may push to a new branch when you change networks`,
          fix: `vibebook config --device <stable-name>   # e.g. 'mini2', 'work-laptop'`,
        });
      } else {
        checks.push({
          name: "Device branch", status: "ok",
          detail: config.deviceBranch,
        });
      }
    }

    // 5. Orphan *.raw.json scan (sessions captured before v0.5.0 don't
    //    have the original .jsonl preserved, so `vibebook resume` can't
    //    replay them. Only meaningful when the repo exists.)
    if (repoExists) {
      const orphans = findOrphanedRawJsons(config.repoPath);
      if (orphans.length > 0) {
        checks.push({
          name: "Resume-ready spool", status: "warn",
          detail: `${orphans.length} session(s) predate v0.5.0 (no sibling .jsonl) — \`vibebook resume\` won't work for them`,
          fix: `rm -rf "${join(config.repoPath, "raw_sessions")}" && vibebook sync   # re-extracts with .jsonl preserved; book/ is unaffected`,
        });
      } else {
        checks.push({
          name: "Resume-ready spool", status: "ok",
          detail: "all spooled sessions have sibling .jsonl",
        });
      }

      // 5b. Oversized jsonl scan. 0.5.2+ writer caps at 95 MB, but pre-0.5.2
      //     spools (and any direct copies) may still hold >100 MB jsonls
      //     that block git push to GitHub.
      const oversized = findOversizedJsonls(config.repoPath, 50 * 1024 * 1024);
      if (oversized.length > 0) {
        const hardRejects = oversized.filter((x) => x.size > 100 * 1024 * 1024).length;
        const lines = oversized.slice(0, 5).map((x) => `  ${(x.size / 1024 / 1024).toFixed(1)} MB  ${x.path}`).join("\n");
        const more = oversized.length > 5 ? `\n  …and ${oversized.length - 5} more` : "";
        checks.push({
          name: "Oversized jsonl",
          status: hardRejects > 0 ? "fail" : "warn",
          detail:
            `${oversized.length} jsonl(s) over 50 MB${hardRejects > 0 ? ` (${hardRejects} over GitHub's 100 MB hard cap — push will fail)` : ""}:\n${lines}${more}`,
          fix: hardRejects > 0
            ? `find "${join(config.repoPath, "raw_sessions")}" -name "*.jsonl" -size +95M -delete   # remove only the >95 MB ones`
            : undefined,
        });
      }

      // 5c. Workflow residue on device branch. Pre-0.5.3 `vibebook workflow
      //     init` wrote files to the user's device branch; from 0.5.3 they
      //     live on main only. Warn if the user still has stale copies on
      //     the device branch (we can't easily distinguish "I'm a 0.5.2
      //     user who already pushed these once" from "I'm a 0.5.3 user with
      //     a leftover commit", so we just always warn when both branches
      //     have them on disk).
      const deviceYaml = join(config.repoPath, ".github/workflows/vibebook-aggregate.yml");
      const deviceScript = join(config.repoPath, "scripts/merge-books.mjs");
      if (existsSync(deviceYaml) || existsSync(deviceScript)) {
        checks.push({
          name: "Workflow residue", status: "warn",
          detail: "Found .github/workflows/vibebook-aggregate.yml + scripts/merge-books.mjs on device-branch working tree — these belong on main only (since 0.5.3)",
          fix: `cd "${config.repoPath}" && git rm -r .github/workflows scripts 2>/dev/null; git commit -m "remove workflow residue (lives on main since 0.5.3)" && git push`,
        });
      }
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

interface MinimalConfig {
  repoPath: string;
  repoUrl?: string;
  encrypt?: boolean;
  deviceBranch?: string;
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

/**
 * Walk `<repoPath>/raw_sessions/` and return paths of `*.raw.json` files
 * that don't have a matching `*.jsonl` sibling. Pre-v0.5.0 sync runs
 * only emitted the .raw.json envelope; without the .jsonl we can't
 * `vibebook resume` those threads.
 */
function findOrphanedRawJsons(repoPath: string): string[] {
  const root = join(repoPath, "raw_sessions");
  if (!existsSync(root)) return [];
  const orphans: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".raw.json")) continue;
      const base = e.name.slice(0, -".raw.json".length);
      const sibling = join(dir, `${base}.jsonl`);
      if (!existsSync(sibling)) orphans.push(p);
    }
  };
  walk(root);
  return orphans;
}

/**
 * Walk `<repoPath>/raw_sessions/` and return paths of `*.jsonl` files
 * larger than `thresholdBytes`. GitHub warns at 50 MB and hard-rejects
 * pushes containing files >100 MB; oversized jsonls block sync and
 * shouldn't be there if writer.ts is current (>=0.5.2 caps at 95 MB).
 * Used by `vibebook doctor` to surface stale ones from earlier syncs.
 *
 * Returns paths sorted descending by size, so callers can show the worst
 * offenders first.
 */
function findOversizedJsonls(repoPath: string, thresholdBytes: number): Array<{ path: string; size: number }> {
  const root = join(repoPath, "raw_sessions");
  if (!existsSync(root)) return [];
  const hits: Array<{ path: string; size: number }> = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      try {
        const size = statSync(p).size;
        if (size > thresholdBytes) hits.push({ path: p, size });
      } catch { /* race: file vanished mid-walk */ }
    }
  };
  walk(root);
  hits.sort((a, b) => b.size - a.size);
  return hits;
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
