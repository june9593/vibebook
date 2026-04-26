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
import { deviceBranchFromHostname } from "../device.js";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../runner-check.js";

export interface WizardAnswers {
  repoUrl: string;
  localPath: string;
  encrypt: boolean;
  passphraseEntered?: string;
  digestEnabled: boolean;
  /** User opted into the CI cross-device aggregation workflow. Only
   *  meaningful when syncToRemote is true. */
  enableAggregateCI: boolean;
  /** Render assistant reasoning into raw_sessions/*.md (Q7). Default true. */
  includeReasoning: boolean;
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

    // Q3: encrypt
    encrypt = await promptYesNo(
      chalk.cyan("Q3") + " Encrypt raw session files before commit?",
      true,
    );

    // Q4: passphrase (only if encrypt)
    if (encrypt) {
      for (;;) {
        const pp = await promptHidden(chalk.cyan("Q4") + " Passphrase (will be saved to ~/.vibebook/passphrase, mode 0600)");
        if (!pp) {
          const skip = await promptYesNo("  Skip storing? You'll need to set VIBEBOOK_PASSPHRASE before sync", false);
          if (skip) break;
          continue;
        }
        const pp2 = await promptHidden("  Confirm passphrase");
        if (pp === pp2) {
          passphraseEntered = pp;
          break;
        }
        console.log(chalk.yellow("  passphrases didn't match, try again"));
      }
    }
  } else {
    console.log(chalk.gray("  local-only mode: no remote URL, no encryption, no push."));
  }

  // Q5: digest enabled
  const digestEnabled = await promptYesNo(
    chalk.cyan("Q5") + " Summarize sessions into a book?",
    true,
  );

  // Q6: opt-in to cross-device CI aggregation. Only offered when syncToRemote
  // — local-only repos have no CI to run.
  // (v0.1 had a "claude model" question here. Removed in v0.2 because the LLM
  // lives entirely in the user's Claude Code session now — model selection
  // happens there via /model, not at vibebook init time.)
  let enableAggregateCI = false;
  if (syncToRemote) {
    enableAggregateCI = await promptYesNo(
      chalk.cyan("Q6") + " Enable CI cross-device book aggregation? (GitHub Actions merges device branches into main)",
      false,
    );
  }

  // Q7: include assistant reasoning in synced md files? Only meaningful when
  // digest is enabled (otherwise the md is just an archival dump). Reasoning
  // adds 30-100% to md size; recommend on when the summarizing model has 400K+
  // context, off when it's a smaller model.
  let includeReasoning = true;
  if (digestEnabled) {
    includeReasoning = await promptYesNo(
      chalk.cyan("Q7") + " Include assistant 'reasoning/thinking' in synced md? (recommended ON for ≥400K-context models like Opus 1M; OFF for smaller models — adds 30-100% to md size)",
      true,
    );
  }

  return { repoUrl, localPath, encrypt, passphraseEntered, digestEnabled, enableAggregateCI, includeReasoning };
}

/**
 * Verify the chosen runner's binary is available. v0.2 vibebook never spawns
 * an LLM from CLI (digest is in-session via /vibebook), so this is a lighter
 * check than v0.1 — we only confirm `claude` is on PATH so the user can
 * actually run `/vibebook` in Claude Code afterward.
 */
export async function verifyRunner(runner: string): Promise<boolean> {
  const bin = runnerBinary(runner);
  if (!bin) return true; // nothing local to check
  console.log(chalk.gray(`\nChecking '${bin}' is on PATH...`));
  const r = await checkBinary(bin, ["--version"]);
  if (!r.ok) {
    console.log(chalk.red(`  x ${bin} not available: ${r.hint ?? "unknown error"}`));
    const url = runnerInstallUrl(runner);
    if (url) console.log(chalk.gray(`    install: ${url}`));
    return false;
  }
  console.log(chalk.green(`  ok ${bin}: ${r.output.split("\n")[0]}`));
  return true;
}

/**
 * Materialize repo + write config + (optionally) save passphrase. Pure I/O,
 * separated so wizard logic stays unit-testable.
 */
export async function applyWizardAnswers(a: WizardAnswers): Promise<void> {
  if (a.repoUrl) {
    const mat = await materializeRepoAtPath(a.localPath, a.repoUrl);
    if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== a.repoUrl) {
      console.log(chalk.yellow(
        `  warning: ${a.localPath} already has remote '${mat.existingRemote}', not '${a.repoUrl}'. Using existing.`,
      ));
    } else if (mat.kind === "cloned") {
      console.log(chalk.gray(`  cloned ${a.repoUrl} -> ${a.localPath}`));
    } else {
      console.log(chalk.gray(`  using existing repo at ${a.localPath}`));
    }
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
    deviceBranch: deviceBranchFromHostname(),
    runner: "claude-cli",
    enableAggregateCI: a.enableAggregateCI,
    includeReasoning: a.includeReasoning,
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: a.digestEnabled,
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
  console.log(chalk.green("\nok vibebook initialized"));
  console.log(chalk.gray(`  config: ~/.vibebook/config.json`));
  if (!a.repoUrl) {
    console.log(chalk.cyan(`  local-only mode: sessions stay on this machine. To enable sync later, edit ~/.vibebook/config.json and set "repoUrl".`));
    return;
  }

  // Remote mode: spell out the next steps.
  console.log(chalk.cyan("\nNext steps:"));
  console.log(chalk.cyan("  1. vibebook sync"));
  console.log(chalk.gray(`       → in any project, extract Claude Code + Copilot sessions and push them to ${a.localPath}. No LLM call.`));
  console.log(chalk.cyan("  2a. (per-project) cd <your-project> && claude → /vibebook"));
  console.log(chalk.gray("       → digest just this project's sessions into book/<project>/{chronicle,topics,cards}/."));
  console.log(chalk.cyan(`  2b. (full sweep) cd ${a.localPath} && claude → /vibebook`));
  console.log(chalk.gray("       → fan-out one subagent per project; skips projects already digested in 2a; regen catalog."));
  if (a.enableAggregateCI) {
    console.log(chalk.cyan("  3. vibebook workflow init"));
    console.log(chalk.gray("       → install the CI workflow that merges every device branch's book/ into main."));
  }
}

/** Top-level entry — composes wizard + verify + apply, with cleanup. */
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
    let runnerOk = true;
    if (answers.digestEnabled) runnerOk = await verifyRunner("claude-cli");
    await applyWizardAnswers(answers);
    if (answers.digestEnabled && !runnerOk) {
      console.log(chalk.yellow(
        `  note: digest will fail until 'claude' is installed; install it then run \`vibebook sync\`.`,
      ));
    }
  } finally {
    closePrompts();
  }
}
