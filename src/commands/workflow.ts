import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig, writeRepoSaltFile } from "../config.js";
import { migrateLegacyDataDir, migratedDataDirPaths } from "../migrate.js";
import { REPO_SALT_REL, repoSaltAbs } from "../repo-data-dir.js";

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

  // One-shot: rename legacy `.memvc/` → `.vibebook/` if present.
  const dataDirMig = await migrateLegacyDataDir(cfg.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.green(`renamed legacy .memvc/ → .vibebook/ ${dataDirMig.viaGit ? "(via git mv)" : ""}`));
  }

  // Self-heal: legacy repos initialized before salt-write was wired into init
  // are missing .vibebook/repo-salt.json, which the workflow's fail-fast guard
  // requires when encryption is on. Backfill it here from the in-memory salt.
  let saltJustWritten = false;
  if (cfg.encrypt) {
    if (!existsSync(repoSaltAbs(cfg.repoPath))) {
      writeRepoSaltFile(cfg.repoPath, cfg.salt);
      saltJustWritten = true;
      console.log(chalk.green(`backfilled missing ${REPO_SALT_REL} (legacy repo)`));
    }
  }

  console.log(chalk.gray("\nNext steps:"));
  console.log(chalk.gray(`  1. cd ${cfg.repoPath}`));
  const extras: string[] = [];
  if (saltJustWritten) extras.push(REPO_SALT_REL);
  if (dataDirMig.migrated && dataDirMig.viaGit) extras.push(...migratedDataDirPaths(cfg.repoPath));
  const stagePaths = [".github/workflows/vibebook-digest.yml", ...extras].join(" ");
  const commitMsg = (saltJustWritten || dataDirMig.migrated)
    ? "add vibebook digest workflow + repo data-dir housekeeping"
    : "add vibebook digest workflow";
  console.log(chalk.gray(`  2. git add ${stagePaths} && git commit -m '${commitMsg}' && git push`));
  if (cfg.encrypt) {
    console.log(chalk.cyan("  3. Set repo secret VIBEBOOK_PASSPHRASE in GitHub Settings -> Secrets and variables -> Actions -> 'New repository secret'"));
  } else {
    console.log(chalk.gray("  3. (encryption is off; no secret needed - but anyone with repo access can read raw_sessions)"));
  }
  console.log(chalk.gray("  4. Trigger: push a device branch, OR run from the Actions tab -> 'vibebook digest' -> 'Run workflow'"));
}
