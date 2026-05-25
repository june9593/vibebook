import { join, resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { prompt, promptYesNo, promptHidden, closePrompts } from "../prompts.js";
import { materializeRepoAtPath, expandHome } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import {
  freshSaltBase64, writeConfig, writeRepoSaltFile, configExists,
  DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS,
  type Config,
} from "../config.js";
import { deviceBranchFromHostname, isStableDeviceName } from "../device.js";

export interface WizardAnswers {
  repoUrl: string;
  localPath: string;
  encrypt: boolean;
  passphraseEntered?: string;
  /** True if syncToRemote was chosen. Drives auto-install of the CI
   *  aggregation workflow. Local-only repos never enable CI. */
  enableAggregateCI: boolean;
  /** Stable git-branch name for this machine. User picks at Q6 because
   *  hostname() drifts on macOS across networks; we default to a cleaned
   *  hostname (stripped of .local / .lan suffixes) but recommend a
   *  physical-label name. */
  deviceBranch: string;
}

/**
 * Returns the path the wizard will use when the user skips the path question.
 * Fixed at `~/.vibebook/session-repo` so the /vibebook skill can detect
 * "global mode" by cwd-equality without per-user configuration.
 */
export function defaultLocalPath(): string {
  return join(homedir(), ".vibebook", "session-repo");
}

/**
 * Run the interactive wizard. Returns answers; caller owns writing config +
 * materializing the repo. Throws on user-invalid input that the loops can't
 * recover from (caller catches and exits non-zero).
 */
export async function runWizard(): Promise<WizardAnswers> {
  console.log(chalk.bold("\nvibebook init wizard\n"));

  // Q0: sync to remote?
  const syncToRemote = await promptYesNo(
    chalk.cyan("Q0") + " Sync to a remote git repo (GitHub etc.)? Choose 'no' for local-only.",
    true,
  );

  let repoUrl = "";
  let localPath = defaultLocalPath();
  let encrypt = false;
  let passphraseEntered: string | undefined;

  if (syncToRemote) {
    // Q1: repo URL
    repoUrl = await prompt(
      chalk.cyan("Q1") + " Private git repo URL (e.g. git@github.com:you/work-memory.git)",
    );
    if (!repoUrl) throw new Error("repo URL is required");

    // Q2: local path
    const rawPath = await prompt(
      chalk.cyan("Q2") + ` Where should the repo live locally? (recommend the default — the /vibebook skill detects "global mode" by this exact path)`,
      localPath,
    );
    localPath = resolve(expandHome(rawPath));

    // Q3 (encrypt) and Q4 (passphrase) DROPPED in 0.8.2.
    //
    // Rationale: the file-body encryption was half-baked anyway — filenames
    // (= first ~100 chars of the user's prompt) and `.vibebook/index.json`
    // (full `displayName` per session) always leaked in plaintext to the
    // remote, so an attacker reading the repo could already reconstruct the
    // conversation topics. The threat model "GitHub itself or someone with
    // repo read access sees content" wasn't actually addressed.
    //
    // The REAL risk — accidentally pasting an API key into a session and
    // pushing it — is covered by GitHub's secret-scanning push protection
    // (free, on private repos as of 2024-09): AWS keys, GitHub PATs, OpenAI
    // `sk-*`, Anthropic `sk-ant-*`, and ~40 other partner patterns get
    // rejected at push time with GH013. The body-encryption layer didn't
    // help with that either.
    //
    // Power users who want encryption can still pass `--encrypt` on the
    // non-interactive `vibebook init` path, or flip
    // `~/.vibebook/config.json`'s `encrypt: true` and re-run sync. To turn
    // off encryption on an existing encrypted repo, use
    // `vibebook config --encrypt false`.
    encrypt = false;
  } else {
    console.log(chalk.gray("  local-only mode: no remote URL, no encryption, no push."));
  }

  // Q5 / Q6 / Q7 dropped in 0.6.1:
  //   - Q6 (enable CI aggregation): now defaults true when sync-to-remote
  //     (the CI workflow is small + universally useful; escape hatch is
  //     editing config.json's enableAggregateCI: false post-init).
  //   - Q7 (include reasoning): always true in 0.6+ — reasoning blocks are
  //     part of the context.md by design; truncation handles size.
  //   (v0.1 had a "claude model" question here. Removed in v0.2 because the
  //   LLM lives entirely in the user's Claude Code session now.)
  //   (v0.5: Q5 "digest enabled" and the original Q8 "recommend memex"
  //   dropped.)
  const enableAggregateCI = syncToRemote;

  // Q6 (was Q8 pre-0.6.1): device branch name. hostname() drifts on macOS
  // (mDNS in home wifi, DHCP-given names on corp VPN, hotspot etc.) — each
  // network creates a new device branch, fragmenting the spool. We strip
  // common volatile suffixes (.local / .lan) from the default and warn if
  // the cleaned name still looks volatile.
  const hostnameDefault = stripVolatileSuffixes(deviceBranchFromHostname());
  const stableLooking = isStableDeviceName(hostnameDefault);
  const stableHint = stableLooking
    ? "current hostname looks stable, can keep"
    : "WARNING: current hostname looks like macOS drift (e.g. DHCP) — recommend overriding with a physical label like 'mini2' or 'work-laptop'";
  const deviceBranch = (await prompt(
    chalk.cyan("Q6") + ` Stable device name for this machine's git branch? (${stableHint})`,
    hostnameDefault,
  )).trim() || hostnameDefault;

  return { repoUrl, localPath, encrypt, passphraseEntered, enableAggregateCI, deviceBranch };
}

/** Strip common macOS-volatile suffixes from a hostname-derived branch name.
 *  `Mac-mini-2.local` → `Mac-mini-2`; `MIS-EV2-BB1.surfacescenarios.org` →
 *  `MIS-EV2-BB1` (the FQDN suffix is irrelevant for vibebook's purposes; the
 *  identifying part of a personal machine name is the bare hostname). */
export function stripVolatileSuffixes(name: string): string {
  return name
    .replace(/\.local$/i, "")
    .replace(/\.lan$/i, "")
    // Strip first .<dotted-suffix> on FQDN-shaped names; preserves multi-dot
    // user-provided names like "yue.mini.2" by only touching the case where
    // the suffix contains letters (DNS-style).
    .replace(/\.[a-z][a-z0-9.-]*$/i, "");
}

/**
 * Materialize repo + write config + (optionally) save passphrase. Pure I/O,
 * separated so wizard logic stays unit-testable.
 */
export async function applyWizardAnswers(a: WizardAnswers): Promise<void> {
  if (a.repoUrl) {
    let mat;
    try {
      mat = await materializeRepoAtPath(a.localPath, a.repoUrl);
    } catch (err) {
      // Plugin-first scenario: the user installed vibebook-plugin before
      // the npm CLI, so ~/.vibebook/session-repo/ is non-empty (book/,
      // raw_sessions/) but not a git repo. Offer to adopt it in place
      // rather than asking the user to `rm -rf` their plugin data.
      const msg = (err as Error).message;
      if (msg.includes("is not empty and is not a git repo")) {
        const adopt = await promptYesNo(
          chalk.yellow(
            `\n  ${a.localPath} has data in it but isn't a git repo (looks like\n` +
            `  vibebook-plugin wrote it before the npm CLI was installed).\n` +
            `  Adopt this directory: 'git init' + add origin '${a.repoUrl}' + create\n` +
            `  branch '${a.deviceBranch}' with your existing files as its first commit?\n` +
            `  (Nothing on disk is deleted or moved.)`,
          ),
          true,
        );
        if (!adopt) throw err;
        const { adoptPluginDir } = await import("../git-ops.js");
        mat = await adoptPluginDir(a.localPath, a.repoUrl, a.deviceBranch);
        console.log(chalk.gray(`  adopted ${a.localPath} into new repo on branch '${a.deviceBranch}'`));
      } else {
        throw err;
      }
    }
    if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== a.repoUrl) {
      console.log(chalk.yellow(
        `  warning: ${a.localPath} already has remote '${mat.existingRemote}', not '${a.repoUrl}'. Using existing.`,
      ));
    } else if (mat.kind === "cloned") {
      console.log(chalk.gray(`  cloned ${a.repoUrl} -> ${a.localPath}`));
    } else if (mat.kind === "existing") {
      console.log(chalk.gray(`  using existing repo at ${a.localPath}`));
    }
    // "adopted" already logged inline above.
  } else {
    // Local-only mode: ensure the path exists as a plain git repo (no remote).
    const { mkdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { simpleGit } = await import("simple-git");
    mkdirSync(a.localPath, { recursive: true });
    if (!existsSync(join(a.localPath, ".git"))) {
      await simpleGit(a.localPath).init();
      console.log(chalk.gray(`  initialized local-only git repo at ${a.localPath}`));
    } else {
      console.log(chalk.gray(`  using existing repo at ${a.localPath}`));
    }
  }
  if (a.encrypt && a.passphraseEntered) {
    writePassphraseFile(a.passphraseEntered);
    console.log(chalk.gray(`  passphrase saved to ~/.vibebook/passphrase (mode 0600)`));
  }
  const cfg: Config = {
    repoPath: a.localPath,
    repoUrl: a.repoUrl,
    encrypt: a.encrypt,
    salt: freshSaltBase64(),
    deviceBranch: a.deviceBranch,
    runner: "claude-cli",
    enableAggregateCI: a.enableAggregateCI,
    // 0.6+: reasoning blocks are always rendered into context.md (they're
    // part of the content-block stream by design; truncation handles size).
    // The schema retains the field but the wizard no longer asks; default true.
    includeReasoning: true,
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    // digestEnabled retained at schema default (true) for downstream
    // consumers; the wizard no longer prompts for it (v0.5).
    digestEnabled: true,
    // bookLocale defaults to "en" via schema; we set it inline to satisfy
    // the strict TypeScript Config type, which doesn't see through z.default().
    bookLocale: "en",
  };
  writeConfig(cfg);
  if (cfg.encrypt) {
    writeRepoSaltFile(cfg.repoPath, cfg.salt);
    console.log(chalk.gray(`  repo salt written to ${a.localPath}/.vibebook/repo-salt.json`));
    try {
      const { ensureCryptFilter } = await import("./crypt.js");
      const r = ensureCryptFilter(cfg.repoPath);
      if (r.wired) console.log(chalk.gray(`  wired git crypt filter (working tree always plaintext; encrypted on push)`));
    } catch (err) {
      console.log(chalk.yellow(`  warning: could not wire git crypt filter: ${(err as Error).message}`));
    }
  }

  console.log(chalk.green("\n✓ vibebook configured."));
  console.log(chalk.gray(`  Config: ~/.vibebook/config.json`));
  if (!a.repoUrl) {
    console.log(chalk.cyan(`  local-only mode: sessions stay on this machine. To enable sync later, edit ~/.vibebook/config.json and set "repoUrl".`));
    return;
  }

  console.log("");
  console.log(chalk.cyan("Try on this machine:"));
  console.log("  vibebook sync                    # extract local sessions + push to your device branch");
  console.log("");
  console.log(chalk.cyan("On ANOTHER machine after vibebook init + vibebook sync:"));
  console.log("  vibebook list-sessions --since 7d        # see what's synced from elsewhere");
  console.log("  cd <project-dir> && vibebook resume <id> # spawn claude with that prior session's context");
  console.log("");
  console.log(chalk.cyan("For digest + recall (chronicles, topics, bookmark recall):"));
  console.log(chalk.gray("  Install the Claude Code plugin:"));
  console.log("    /plugin marketplace add june9593/vibebook-plugin");
  console.log("    /plugin install vibebook");
  if (a.enableAggregateCI) {
    console.log("");
    console.log(chalk.cyan("Installing CI aggregation workflow on origin/main..."));
    try {
      const { workflowInitCmd } = await import("./workflow.js");
      await workflowInitCmd({});
    } catch (err) {
      console.log(chalk.yellow(`! workflow auto-install failed: ${(err as Error).message}`));
      console.log(chalk.gray(`  You can retry later with: vibebook workflow init`));
    }
  }
}

/** Top-level entry — composes wizard + apply, with cleanup. */
export async function runInitWizard(): Promise<void> {
  if (configExists()) {
    const overwrite = await promptYesNo(
      chalk.yellow("vibebook already initialized at ~/.vibebook/config.json. Overwrite?"),
      false,
    );
    if (!overwrite) {
      console.log(chalk.gray("aborted"));
      closePrompts();
      return;
    }
  }
  try {
    const answers = await runWizard();
    await applyWizardAnswers(answers);
  } finally {
    closePrompts();
  }
}
