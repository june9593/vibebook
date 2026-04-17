import { writeConfig, configExists, freshSaltBase64, type Config } from "../config.js";
import { ensureRepo } from "../git-ops.js";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl: string;
  localPath?: string;
  encrypt?: boolean;
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
  };
  writeConfig(cfg);
  console.log(chalk.green(`memvc initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  encrypt: ${cfg.encrypt}`);
  if (cfg.encrypt) console.log(chalk.cyan(`  set MEMVC_PASSPHRASE env var before running sync`));
}
