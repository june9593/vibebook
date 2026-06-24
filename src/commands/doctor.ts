import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
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
 *   5. 0.5.x spool residue (.raw.json + .jsonl) — vibebook 0.6 only writes .md
 *   5b. resume-forks.json residue from 0.5.1 fork-tracking
 *   6. memex on PATH (informational; not an error if missing)
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

  // 1b. Multi-install footgun (0.8.4): a user can have `vibebook` installed
  // to both Homebrew's npm prefix AND nvm's prefix at the same time. `vibebook
  // upgrade` lands in whichever npm runs first, but shell `vibebook` resolves
  // by PATH order — so users routinely upgrade one install while continuing
  // to run the other. Tell them which one wins and which to nuke.
  const allInstalls = listAllPathInstalls();
  if (allInstalls.length > 1) {
    const lines = allInstalls
      .map((i, idx) => `    ${idx === 0 ? "→" : " "} ${i.path} (${i.version ?? "?"})`)
      .join("\n");
    const losers = allInstalls.slice(1);
    const fixCmd = losers
      .map((i) => {
        // Infer the npm prefix from the install path and recommend that
        // npm to uninstall, so the user doesn't accidentally uninstall
        // the one they wanted to keep.
        const prefix = i.path.replace(/\/bin\/vibebook$/, "");
        return `${prefix}/bin/npm uninstall -g vibebook`;
      })
      .join(" && ") + " && hash -r";
    checks.push({
      name: "PATH conflicts", status: "warn",
      detail: `${allInstalls.length} vibebook installs on PATH (shell uses the → marked one):\n${lines}`,
      fix: fixCmd,
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

    // 5. 0.5.x spool residue check. vibebook 0.6 only writes .md per session.
    //    Existing .raw.json and .jsonl from 0.5.x are dead weight; suggest cleanup.
    if (repoExists) {
      const residue = countResidue(config.repoPath);
      if (residue.rawJsonCount + residue.jsonlCount > 0) {
        const lines = [
          `${residue.rawJsonCount} .raw.json files, ${residue.jsonlCount} .jsonl files in spool`,
          `(vibebook 0.6 only writes .md — these are 0.5.x residue)`,
        ];
        checks.push({
          name: "0.5.x spool residue",
          status: "warn",
          detail: lines.join(" — "),
          fix:
            `find "${join(config.repoPath, "raw_sessions")}" -name "*.jsonl" -delete && ` +
            `find "${join(config.repoPath, "raw_sessions")}" -name "*.raw.json" -delete && ` +
            `rm "${join(config.repoPath, ".vibebook/index.json")}" && ` +
            `vibebook sync   # regenerates index + new-format .md per session`,
        });
      }

      // 5b. resume-forks.json residue (from 0.5.1 fork-tracking, removed in 0.6)
      const forkRegPath = join(homedir(), ".vibebook/resume-forks.json");
      if (existsSync(forkRegPath)) {
        checks.push({
          name: "0.5.1 fork registry residue",
          status: "warn",
          detail: `~/.vibebook/resume-forks.json exists (no longer used)`,
          fix: `rm ${forkRegPath}`,
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

/**
 * Walk every PATH directory and return each `vibebook` binary found plus its
 * --version output. Multi-install footgun: a user can have npm installed
 * to both Homebrew's npm prefix (/opt/homebrew/lib/node_modules/) AND nvm's
 * (~/.nvm/versions/node/<v>/lib/node_modules/) at the same time. `vibebook
 * upgrade` installs to whichever npm is on PATH first, but the shell
 * resolves `vibebook` by PATH order — so users routinely upgrade one
 * install while continuing to run the other. Bit Yue twice on 2026-05-25.
 */
function listAllPathInstalls(): { path: string; version: string | null }[] {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set<string>();
  const out: { path: string; version: string | null }[] = [];
  for (const dir of pathDirs) {
    const abs = join(dir, "vibebook");
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    // Resolve symlink target so two PATH entries pointing at the same
    // physical binary collapse into one row.
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch { /* fall through */ }
    if (seen.has(real)) continue;
    seen.add(real);
    const r = spawnSync(abs, ["--version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
    });
    out.push({ path: abs, version: r.status === 0 ? r.stdout.trim() : null });
  }
  return out;
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

function countResidue(repoPath: string): { rawJsonCount: number; jsonlCount: number } {
  const root = join(repoPath, "raw_sessions");
  if (!existsSync(root)) return { rawJsonCount: 0, jsonlCount: 0 };
  let rawJsonCount = 0;
  let jsonlCount = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      if (e.name.endsWith(".raw.json")) rawJsonCount++;
      else if (e.name.endsWith(".jsonl")) jsonlCount++;
    }
  };
  walk(root);
  return { rawJsonCount, jsonlCount };
}

function readMemexVersion(): string | null {
  const r = spawnSync("memex", ["--version"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}
