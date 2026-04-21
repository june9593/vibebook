import { join } from "node:path";
import chalk from "chalk";
import { prompt, promptYesNo, promptChoice, promptHidden, closePrompts } from "../prompts.js";
import { materializeRepoAtPath } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import {
  freshSaltBase64, writeConfig, configExists,
  DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS,
  type Config,
} from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../runner-check.js";
import { createRunner } from "../digest/runner.js";

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
  return join(process.cwd(), ".memvc", "repo");
}

/**
 * Run the interactive 7-step wizard. Returns answers; caller owns writing
 * config + materializing the repo. Throws on user-invalid input that the
 * loops can't recover from (caller catches and exits non-zero).
 */
export async function runWizard(): Promise<WizardAnswers> {
  console.log(chalk.bold("\nmemvc init wizard\n"));

  // Q1: repo URL
  const repoUrl = await prompt(
    chalk.cyan("Q1") + " Private git repo URL (e.g. git@github.com:you/work-memory.git)",
  );
  if (!repoUrl) throw new Error("repo URL is required");

  // Q2: local path
  const dflt = defaultLocalPath();
  const localPath = await prompt(
    chalk.cyan("Q2") + ` Where should the repo live locally?`,
    dflt,
  );

  // Q3: encrypt
  const encrypt = await promptYesNo(
    chalk.cyan("Q3") + " Encrypt raw session files before commit?",
    true,
  );

  // Q4: passphrase (only if encrypt)
  let passphraseEntered: string | undefined;
  if (encrypt) {
    for (;;) {
      const pp = await promptHidden(chalk.cyan("Q4") + " Passphrase (will be saved to ~/.memvc/passphrase, mode 0600)");
      if (!pp) {
        const skip = await promptYesNo("  Skip storing? You'll need to set MEMVC_PASSPHRASE before sync", false);
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

  // Q5: digest enabled
  const digestEnabled = await promptYesNo(
    chalk.cyan("Q5") + " Summarize sessions into a book?",
    true,
  );

  // Q6 + Q7 only if digest enabled
  let runner: WizardAnswers["runner"] = "claude-cli";
  let runnerModel = "";
  if (digestEnabled) {
    for (;;) {
      runner = await promptChoice(
        chalk.cyan("Q6") + " Runner",
        [
          { value: "claude-cli", label: "Local Claude CLI", description: "needs `claude` on PATH" },
          { value: "github-action", label: "GitHub Action (coming soon)", description: "no local install; runs in CI" },
        ],
        0,
      );
      if (runner === "github-action") {
        console.log(chalk.yellow("  GitHub Action runner is not implemented yet — please pick another."));
        continue;
      }
      break;
    }
    runnerModel = await prompt(
      chalk.cyan("Q7") + " Model name (blank = runner default)",
      "",
    );
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
  if (a.encrypt && a.passphraseEntered) {
    writePassphraseFile(a.passphraseEntered);
    console.log(chalk.gray(`  passphrase saved to ~/.memvc/passphrase (mode 0600)`));
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
  console.log(chalk.green("\nok memvc initialized"));
  console.log(chalk.gray(`  config: ~/.memvc/config.json`));
}

/** Top-level entry — composes wizard + verify + apply, with cleanup. */
export async function runInitWizard(): Promise<void> {
  if (configExists()) {
    const overwrite = await promptYesNo(
      chalk.yellow("memvc already initialized at ~/.memvc/config.json. Overwrite?"),
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
    if (answers.digestEnabled) runnerOk = await verifyRunner(answers.runner, answers.runnerModel);
    await applyWizardAnswers(answers);
    if (answers.digestEnabled && !runnerOk) {
      console.log(chalk.yellow(
        `  note: digest will fail until '${answers.runner}' is installed; install it then run \`memvc sync\`.`,
      ));
    }
  } finally {
    closePrompts();
  }
}
