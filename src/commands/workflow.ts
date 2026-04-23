import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { migrateLegacyDataDir, migratedDataDirPaths } from "../migrate.js";
import { ensureRepo, ensureDeviceBranch, commitAndPush, fastForwardBranch } from "../git-ops.js";

/**
 * Resolve the path to a bundled asset. The build emits to `dist/src/commands/`
 * (because tsconfig has rootDir="." and includes both bin/ and src/), while
 * dev runs from `src/commands/`. Probe both layouts plus npm-global ones.
 */
function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", rel),       // src/commands/
    resolve(here, "..", "..", "..", rel), // dist/src/commands/
    resolve(here, "..", "..", "..", "..", rel),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `vibebook bundled asset not found: ${rel}. Tried:\n  ${candidates.join("\n  ")}\nIf you installed vibebook from npm, please file an issue.`,
  );
}

export async function workflowInitCmd(opts: { force?: boolean; noPush?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const yamlTarget = join(cfg.repoPath, ".github", "workflows", "vibebook-aggregate.yml");
  const scriptTarget = join(cfg.repoPath, "scripts", "merge-books.mjs");

  if ((existsSync(yamlTarget) || existsSync(scriptTarget)) && !opts.force) {
    if (existsSync(yamlTarget)) console.log(chalk.yellow(`already exists: ${yamlTarget}`));
    if (existsSync(scriptTarget)) console.log(chalk.yellow(`already exists: ${scriptTarget}`));
    console.log(chalk.gray("  re-run with --force to overwrite"));
    return;
  }

  // Copy both files from the bundled assets/ into the user's repo.
  mkdirSync(dirname(yamlTarget), { recursive: true });
  writeFileSync(yamlTarget, readFileSync(assetPath("assets/workflows/vibebook-aggregate.yml"), "utf8"));
  console.log(chalk.green(`workflow written: ${yamlTarget}`));

  mkdirSync(dirname(scriptTarget), { recursive: true });
  writeFileSync(scriptTarget, readFileSync(assetPath("assets/scripts/merge-books.mjs"), "utf8"));
  console.log(chalk.green(`merge script written: ${scriptTarget}`));

  // Opportunistic: rename legacy `.memvc/` → `.vibebook/` if the user skipped
  // it on earlier syncs.
  const dataDirMig = await migrateLegacyDataDir(cfg.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.green(`renamed legacy .memvc/ → .vibebook/ ${dataDirMig.viaGit ? "(via git mv)" : ""}`));
  }

  // Auto-commit + push. Skip when --no-push or local-only (no remote URL).
  const wantPush = !opts.noPush && cfg.repoUrl && cfg.deviceBranch;
  if (!wantPush) {
    console.log(chalk.gray("\nLocal-only mode: files written but not committed/pushed."));
    console.log(chalk.gray(`  repoUrl: ${cfg.repoUrl || "(none)"}`));
    return;
  }

  console.log(chalk.gray(`\nCommitting + pushing to '${cfg.deviceBranch}'...`));
  const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
  try { await git.fetch(); } catch { /* offline / empty */ }
  await ensureDeviceBranch(git, cfg.deviceBranch);
  try {
    await fastForwardBranch(git, cfg.deviceBranch, (s) => console.log(chalk.gray(`  ${s}`)));
  } catch (err) {
    console.log(chalk.red(`! could not sync local branch with origin: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.cyan(`  Skipping push. Resolve in ${cfg.repoPath} and re-run \`vibebook workflow init\`.`));
    return;
  }
  const paths: string[] = [
    ".github/workflows/vibebook-aggregate.yml",
    "scripts/merge-books.mjs",
  ];
  if (dataDirMig.migrated && dataDirMig.viaGit) paths.push(...migratedDataDirPaths(cfg.repoPath));
  const r = await commitAndPush(
    git,
    "vibebook: add CI aggregation workflow + merge-books script",
    paths,
    cfg.deviceBranch,
    (stage) => console.log(chalk.gray(`  ${stage}`)),
  );
  if (r.committed && r.pushed) {
    console.log(chalk.green(`✓ pushed to '${cfg.deviceBranch}'`));
  } else if (r.committed && !r.pushed) {
    console.log(chalk.yellow(`Committed locally but push failed. Run \`git push\` manually from ${cfg.repoPath}.`));
  } else {
    console.log(chalk.gray("Nothing to commit (workflow + script already up to date)."));
  }

  console.log(chalk.gray("\nThe workflow fires on every push to a non-main branch."));
  console.log(chalk.gray("Each device's `vibebook sync` will trigger it; the CI merges all device book/s into main."));
}
