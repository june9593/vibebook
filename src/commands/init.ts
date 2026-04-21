import { writeConfig, writeRepoSaltFile, freshSaltBase64, DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS, type Config } from "../config.js";
import { materializeRepoAtPath } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import { deviceBranchFromHostname } from "../device.js";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl?: string;
  localPath?: string;
  encrypt?: boolean;
  digestEnabled?: boolean;
  device?: string;
  passphrase?: string;
}

/** Wizard mode kicks in when caller passed no flags AND no repoUrl. */
function isFlagMode(opts: InitOptions): boolean {
  return Boolean(
    opts.repoUrl || opts.localPath || opts.encrypt || opts.device ||
    opts.passphrase || opts.digestEnabled === false,
  );
}

export async function initCmd(opts: InitOptions): Promise<void> {
  if (!isFlagMode(opts)) {
    // No flags → interactive wizard.
    const { runInitWizard } = await import("./init-wizard.js");
    await runInitWizard();
    return;
  }

  // Flag mode: non-interactive.
  if (!opts.repoUrl) {
    throw new Error("repoUrl is required in flag mode (or run `memvc init` with no args for the wizard)");
  }
  const localPath = opts.localPath ?? join(process.cwd(), ".memvc", "repo");
  const mat = await materializeRepoAtPath(localPath, opts.repoUrl);
  if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== opts.repoUrl) {
    console.log(chalk.yellow(
      `warning: ${localPath} already has remote '${mat.existingRemote}', not '${opts.repoUrl}'. Using existing.`,
    ));
  }
  if (opts.encrypt && opts.passphrase) {
    writePassphraseFile(opts.passphrase);
  }
  const cfg: Config = {
    repoPath: localPath,
    repoUrl: opts.repoUrl,
    encrypt: !!opts.encrypt,
    salt: freshSaltBase64(),
    deviceBranch: opts.device ?? deviceBranchFromHostname(),
    runner: "claude-cli",
    runnerModel: "",
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: opts.digestEnabled !== false,
  };
  writeConfig(cfg);
  if (cfg.encrypt) {
    writeRepoSaltFile(cfg.repoPath, cfg.salt);
  }
  console.log(chalk.green(`memvc initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  device branch: ${cfg.deviceBranch}`);
  console.log(`  encrypt: ${cfg.encrypt}`);
  console.log(`  digest enabled: ${cfg.digestEnabled}`);
  if (cfg.encrypt && !opts.passphrase) {
    console.log(chalk.cyan(`  set MEMVC_PASSPHRASE env var (or pass --passphrase) before running sync`));
  }
}
