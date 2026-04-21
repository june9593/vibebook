import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig } from "../config.js";

/**
 * Resolve the bundled workflow template path. Works in both dev (tsx)
 * and built (dist/) layouts because we walk up from this module's URL.
 */
function templatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/commands/  -> ../../assets/workflows/memvc-digest.yml
  // dist/commands/ -> ../../assets/workflows/memvc-digest.yml
  return resolve(here, "..", "..", "assets", "workflows", "memvc-digest.yml");
}

export async function workflowInitCmd(opts: { force?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const target = join(cfg.repoPath, ".github", "workflows", "memvc-digest.yml");
  if (existsSync(target) && !opts.force) {
    console.log(chalk.yellow(`workflow already exists: ${target}`));
    console.log(chalk.gray("  re-run with --force to overwrite"));
    return;
  }
  const tpl = readFileSync(templatePath(), "utf8");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, tpl);
  console.log(chalk.green(`workflow written: ${target}`));
  console.log(chalk.gray("\nNext steps:"));
  console.log(chalk.gray(`  1. cd ${cfg.repoPath}`));
  console.log(chalk.gray("  2. git add .github/workflows/memvc-digest.yml && git commit -m 'add memvc digest workflow' && git push"));
  if (cfg.encrypt) {
    console.log(chalk.cyan("  3. Set repo secret MEMVC_PASSPHRASE in GitHub Settings -> Secrets and variables -> Actions -> 'New repository secret'"));
  } else {
    console.log(chalk.gray("  3. (encryption is off; no secret needed - but anyone with repo access can read raw_sessions)"));
  }
  console.log(chalk.gray("  4. Trigger: push a device branch, OR run from the Actions tab -> 'memvc digest' -> 'Run workflow'"));
}
