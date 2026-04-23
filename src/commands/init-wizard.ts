import { join, resolve } from "node:path";
import chalk from "chalk";
import { prompt, promptYesNo, promptChoice, promptHidden, closePrompts } from "../prompts.js";
import { materializeRepoAtPath, expandHome } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import {
  freshSaltBase64, writeConfig, writeRepoSaltFile, configExists,
  DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS,
  type Config,
} from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../runner-check.js";
import { createRunner } from "../digest/runner.js";
import { fetchGithubModelsCatalog, GITHUB_MODELS_FALLBACK } from "../github-models-catalog.js";

export interface WizardAnswers {
  repoUrl: string;
  localPath: string;
  encrypt: boolean;
  passphraseEntered?: string;
  digestEnabled: boolean;
  runner: "claude-cli" | "github-action";
  runnerModel: string;
}

/**
 * Returns the path the wizard will use when the user skips the path question.
 * Cwd-local hidden dir per user preference.
 */
export function defaultLocalPath(): string {
  return join(process.cwd(), ".vibebook", "repo");
}

/**
 * Run the interactive 7-step wizard. Returns answers; caller owns writing
 * config + materializing the repo. Throws on user-invalid input that the
 * loops can't recover from (caller catches and exits non-zero).
 */
export interface RunWizardOptions {
  /** Show the full GitHub Models catalog including paid-only models
   *  (gpt-5*, o1*, o3*, o4-mini). Default: false (Copilot Free models only). */
  allModels?: boolean;
}

export async function runWizard(opts: RunWizardOptions = {}): Promise<WizardAnswers> {
  console.log(chalk.bold("\nvibebook init wizard\n"));

  // Q0: sync to GitHub?
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
      chalk.cyan("Q2") + ` Where should the repo live locally?`,
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

  // Q6 + Q7 only if digest enabled
  let runner: WizardAnswers["runner"] = "claude-cli";
  let runnerModel = "";
  if (digestEnabled) {
    const runnerOptions: { value: WizardAnswers["runner"]; label: string; description?: string }[] = [
      { value: "claude-cli", label: "Local Claude CLI", description: "needs `claude` on PATH" },
    ];
    if (syncToRemote) {
      runnerOptions.push({
        value: "github-action",
        label: "GitHub Action",
        description: "runs digest in CI via GitHub Models (free); see `vibebook workflow init`",
      });
    }
    runner = runnerOptions.length === 1
      ? runnerOptions[0]!.value
      : await promptChoice(chalk.cyan("Q6") + " Runner", runnerOptions, 0);

    if (runner === "github-action") {
      console.log(chalk.yellow(
        "\n  ⚠ EXPERIMENTAL: GitHub Action runner uses GitHub Models (free tier)."
      ));
      console.log(chalk.yellow(
        "    Free tier hard-caps every request at 8000 input / 4000 output tokens"
      ));
      console.log(chalk.yellow(
        "    regardless of model. Long threads will be auto-truncated; some articles"
      ));
      console.log(chalk.yellow(
        "    may be partial or fail outright. For high-quality digests on big repos,"
      ));
      console.log(chalk.yellow(
        "    use the local Claude CLI runner instead.\n"
      ));
    }

    // Q7: model. For github-action, fetch the catalog and let the user pick.
    // For claude-cli, blank = whatever `claude` ships with (recommended).
    if (runner === "github-action") {
      console.log(chalk.gray(
        opts.allModels
          ? "  fetching GitHub Models catalog (including paid-only models)..."
          : "  fetching GitHub Models catalog (Copilot Free tier; pass --all-models to see paid-only models like gpt-5/o3)...",
      ));
      const models = await fetchGithubModelsCatalog({ includePaidOnly: opts.allModels });
      // All Copilot Free models share an 8K input cap, so rate-tier doesn't
      // change the digest experience. Sort low-tier first only because they
      // have higher requests/min, which matters at our concurrency=1.
      const sorted = [...models].sort((a, b) => {
        const tierRank = (t?: string) => t === "low" ? 0 : t === "high" ? 1 : 2;
        return tierRank(a.rateLimitTier) - tierRank(b.rateLimitTier);
      });
      const choices = sorted.map((m) => ({
        value: m.id,
        label: `${m.id}  (${m.publisher}${m.rateLimitTier ? `, ${m.rateLimitTier}-tier` : ""})`,
        description: m.name,
      }));
      const defaultIdx = Math.max(0, sorted.findIndex((m) => m.id === "openai/gpt-4o-mini"));
      runnerModel = await promptChoice(
        chalk.cyan("Q7") + " Model (all Copilot-Free models cap at 8K input / 4K output per request)",
        choices,
        defaultIdx,
      );
    } else {
      runnerModel = await prompt(
        chalk.cyan("Q7") + " Model name (blank = runner default)",
        "",
      );
    }
  }

  return { repoUrl, localPath, encrypt, passphraseEntered, digestEnabled, runner, runnerModel };
}

/**
 * Verify the chosen runner's binary is available, then optionally make a real
 * test call. Prints results; returns true iff binary check passed.
 */
export async function verifyRunner(runner: string, model = ""): Promise<boolean> {
  const bin = runnerBinary(runner);
  if (!bin) return true; // nothing local to check
  console.log(chalk.gray(`\nVerifying runner '${runner}'...`));
  const r = await checkBinary(bin, ["--version"]);
  if (!r.ok) {
    console.log(chalk.red(`  x ${bin} not available: ${r.hint ?? "unknown error"}`));
    const url = runnerInstallUrl(runner);
    if (url) console.log(chalk.gray(`    install: ${url}`));
    return false;
  }
  console.log(chalk.green(`  ok ${bin}: ${r.output.split("\n")[0]}`));
  const ping = await promptYesNo("  Test a real API call now? (sends 1-token ping)", false);
  if (!ping) return true;
  if (runner !== "claude-cli" && runner !== "anthropic-api" && runner !== "github-models") {
    console.log(chalk.yellow(`  ping not supported for runner '${runner}' yet`));
    return true;
  }
  console.log(chalk.gray("  pinging..."));
  try {
    const llm = createRunner({ runner, runnerModel: model });
    const res = await llm.run("Reply with the single word OK and nothing else.", {}, { timeoutMs: 30_000, outputFormat: "text" });
    if (res.ok) {
      const preview = res.text.trim().slice(0, 80).replace(/\s+/g, " ");
      console.log(chalk.green(`  ok ping (${res.durationMs}ms): "${preview}"`));
      return true;
    }
    console.log(chalk.yellow(`  ping failed (${res.durationMs}ms): ${res.error.slice(0, 200)}`));
    return false;
  } catch (e) {
    console.log(chalk.yellow(`  ping threw: ${(e as Error).message}`));
    return false;
  }
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
    runner: a.runner,
    runnerModel: a.runnerModel,
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: a.digestEnabled,
  };
  writeConfig(cfg);
  if (cfg.encrypt) {
    writeRepoSaltFile(cfg.repoPath, cfg.salt);
    console.log(chalk.gray(`  repo salt written to ${a.localPath}/.vibebook/repo-salt.json (commit + push so CI can read it)`));
  }
  console.log(chalk.green("\nok vibebook initialized"));
  console.log(chalk.gray(`  config: ~/.vibebook/config.json`));
  if (!a.repoUrl) {
    console.log(chalk.cyan(`  local-only mode: sessions stay on this machine. To enable sync later, edit ~/.vibebook/config.json and set "repoUrl".`));
  }
  if (a.runner === "github-action") {
    console.log(chalk.cyan("\nNext steps (this order matters):"));
    console.log(chalk.cyan("  1. vibebook sync"));
    console.log(chalk.gray("       → pushes raw_sessions + index.json. CI doesn't fire yet (workflow yaml not on remote)."));
    console.log(chalk.cyan("  2. vibebook workflow init"));
    console.log(chalk.gray("       → installs .github/workflows/vibebook-digest.yml + repo-salt.json + auto pushes."));
    console.log(chalk.gray("         The push fires CI ONCE, with full session data already in the repo (saves a wasted CI run)."));
    if (a.encrypt) {
      console.log(chalk.cyan("  3. Set repo secret VIBEBOOK_PASSPHRASE on GitHub"));
      console.log(chalk.gray("       Settings → Secrets and variables → Actions → 'New repository secret'"));
    }
  } else if (a.runner === "claude-cli" && a.repoUrl) {
    console.log(chalk.cyan("\nNext: run `vibebook sync` to push your first batch (digest runs locally via Claude CLI)."));
  }
}

/** Top-level entry — composes wizard + verify + apply, with cleanup. */
export async function runInitWizard(opts: RunWizardOptions = {}): Promise<void> {
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
    const answers = await runWizard(opts);
    let runnerOk = true;
    if (answers.digestEnabled) runnerOk = await verifyRunner(answers.runner, answers.runnerModel);
    await applyWizardAnswers(answers);
    if (answers.digestEnabled && !runnerOk) {
      console.log(chalk.yellow(
        `  note: digest will fail until '${answers.runner}' is installed; install it then run \`vibebook sync\`.`,
      ));
    }
  } finally {
    closePrompts();
  }
}
