import { writeConfig, DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS, type Config } from "../config.js";
import { materializeRepoAtPath } from "../git-ops.js";
import { deviceBranchFromHostname } from "../device.js";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl?: string;
  localPath?: string;
  digestEnabled?: boolean;
  device?: string;
}

/** Wizard mode kicks in when caller passed no flags AND no repoUrl. */
function isFlagMode(opts: InitOptions): boolean {
  return Boolean(
    opts.repoUrl || opts.localPath || opts.device || opts.digestEnabled === false,
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
    throw new Error("repoUrl is required in flag mode (or run `vibebook init` with no args for the wizard)");
  }
  const localPath = opts.localPath ?? join(process.cwd(), ".vibebook", "repo");
  const mat = await materializeRepoAtPath(localPath, opts.repoUrl);
  if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== opts.repoUrl) {
    console.log(chalk.yellow(
      `warning: ${localPath} already has remote '${mat.existingRemote}', not '${opts.repoUrl}'. Using existing.`,
    ));
  }
  const cfg: Config = {
    repoPath: localPath,
    repoUrl: opts.repoUrl,
    deviceBranch: opts.device ?? deviceBranchFromHostname(),
    runner: "claude-cli",
    enableAggregateCI: false,
    includeReasoning: true,
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: opts.digestEnabled !== false,
    bookLocale: "en",
  };
  writeConfig(cfg);
  console.log(chalk.green(`vibebook initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  device branch: ${cfg.deviceBranch}`);
  console.log(`  digest enabled: ${cfg.digestEnabled}`);
  console.log(chalk.cyan(`\n  next: vibebook sync  →  open Claude Code  →  /vibebook`));
}
