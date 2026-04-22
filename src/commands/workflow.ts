import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig } from "../config.js";

/**
 * Resolve the bundled workflow template path. The build emits to
 * `dist/src/commands/` (because tsconfig has rootDir="." and includes both
 * bin/ and src/), while dev runs from `src/commands/`. We probe both layouts
 * (and one more level up for npm-globally-installed layouts) and return the
 * first that exists.
 */
function templatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "assets", "workflows", "vibebook-digest.yml"),         // src/commands/
    resolve(here, "..", "..", "..", "assets", "workflows", "vibebook-digest.yml"),   // dist/src/commands/
    resolve(here, "..", "..", "..", "..", "assets", "workflows", "vibebook-digest.yml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `vibebook workflow template not found. Tried:\n  ${candidates.join("\n  ")}\nIf you installed vibebook from npm, please file an issue — the assets/ dir wasn't bundled.`,
  );
}

export async function workflowInitCmd(opts: { force?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const target = join(cfg.repoPath, ".github", "workflows", "vibebook-digest.yml");
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
  console.log(chalk.gray("  2. git add .github/workflows/vibebook-digest.yml && git commit -m 'add vibebook digest workflow' && git push"));
  if (cfg.encrypt) {
    console.log(chalk.cyan("  3. Set repo secret VIBEBOOK_PASSPHRASE in GitHub Settings -> Secrets and variables -> Actions -> 'New repository secret'"));
  } else {
    console.log(chalk.gray("  3. (encryption is off; no secret needed - but anyone with repo access can read raw_sessions)"));
  }
  console.log(chalk.gray("  4. Trigger: push a device branch, OR run from the Actions tab -> 'vibebook digest' -> 'Run workflow'"));
}
