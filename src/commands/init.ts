import { writeConfig, configExists, freshSaltBase64, DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS, type Config } from "../config.js";
import { ensureRepo } from "../git-ops.js";
import { deviceBranchFromHostname } from "../device.js";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl: string;
  localPath?: string;
  encrypt?: boolean;
  device?: string;
}

export async function initCmd(opts: InitOptions): Promise<void> {
  if (configExists()) {
    console.log(chalk.yellow("memvc already initialized — editing ~/.memvc/config.json manually if needed."));
  }
  const localPath = opts.localPath ?? join(homedir(), "memvc-repo");
  await ensureRepo(localPath, opts.repoUrl);
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
  };
  writeConfig(cfg);
  console.log(chalk.green(`memvc initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  device branch: ${cfg.deviceBranch}`);
  console.log(`  encrypt: ${cfg.encrypt}`);
  if (cfg.encrypt) console.log(chalk.cyan(`  set MEMVC_PASSPHRASE env var before running sync`));
}
