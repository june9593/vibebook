import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig, writeRepoSaltFile } from "../config.js";
import { migrateLegacyDataDir, migratedDataDirPaths } from "../migrate.js";
import { REPO_SALT_REL, repoSaltAbs } from "../repo-data-dir.js";
import { ensureRepo, ensureDeviceBranch, commitAndPush, fastForwardBranch } from "../git-ops.js";

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

export async function workflowInitCmd(opts: { force?: boolean; noPush?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const target = join(cfg.repoPath, ".github", "workflows", "vibebook-digest.yml");
  if (existsSync(target) && !opts.force) {
    console.log(chalk.yellow(`workflow already exists: ${target}`));
    console.log(chalk.gray("  re-run with --force to overwrite"));
    return;
  }
  const tpl = readFileSync(templatePath(), "utf8");
  // Substitute placeholders. The template ships with __VIBEBOOK_RUNNER_MODEL__
  // as a sentinel so we don't accidentally bake in a stale default and ignore
  // the user's wizard choice. Empty cfg.runnerModel → fall back to the
  // catalog default the runner picks at call time (openai/gpt-4o-mini).
  const renderedTpl = tpl.replace(
    /__VIBEBOOK_RUNNER_MODEL__/g,
    cfg.runnerModel?.trim() || "openai/gpt-4o-mini",
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderedTpl);
  console.log(chalk.green(`workflow written: ${target}`));
  console.log(chalk.gray(`  runnerModel: ${cfg.runnerModel?.trim() || "(default) openai/gpt-4o-mini"}`));

  // One-shot: rename legacy `.memvc/` → `.vibebook/` if present.
  const dataDirMig = await migrateLegacyDataDir(cfg.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.green(`renamed legacy .memvc/ → .vibebook/ ${dataDirMig.viaGit ? "(via git mv)" : ""}`));
  }

  // Backfill .vibebook/repo-salt.json. We always write it when encrypt is on
  // (init may have written it but never staged; or this could be a legacy repo
  // that never had it). git add later is idempotent.
  if (cfg.encrypt) {
    if (!existsSync(repoSaltAbs(cfg.repoPath))) {
      writeRepoSaltFile(cfg.repoPath, cfg.salt);
      console.log(chalk.green(`wrote ${REPO_SALT_REL}`));
    }
  }

  // Auto-commit + push so the user doesn't have to copy-paste git commands.
  // Skip when --no-push (or when there's no remote URL configured = local-only).
  const wantPush = !opts.noPush && cfg.repoUrl && cfg.deviceBranch;
  if (!wantPush) {
    console.log(chalk.gray("\nLocal-only mode: workflow yaml written but not committed/pushed."));
    console.log(chalk.gray(`  repoUrl: ${cfg.repoUrl || "(none)"}`));
    if (cfg.encrypt) {
      console.log(chalk.cyan("  Don't forget to set VIBEBOOK_PASSPHRASE secret on GitHub once you push."));
    }
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
  const paths: string[] = [".github/workflows/vibebook-digest.yml"];
  if (cfg.encrypt) paths.push(REPO_SALT_REL);
  if (dataDirMig.migrated && dataDirMig.viaGit) paths.push(...migratedDataDirPaths(cfg.repoPath));
  const r = await commitAndPush(
    git,
    "vibebook: add digest workflow + repo housekeeping",
    paths,
    cfg.deviceBranch,
    (stage) => console.log(chalk.gray(`  ${stage}`)),
  );
  if (r.committed && r.pushed) {
    console.log(chalk.green(`✓ workflow + salt pushed to '${cfg.deviceBranch}'`));
  } else if (r.committed && !r.pushed) {
    console.log(chalk.yellow(`Committed locally but push failed. Run \`git push\` manually from ${cfg.repoPath}.`));
  } else {
    console.log(chalk.gray("Nothing to commit (workflow + salt already up to date)."));
  }

  if (cfg.encrypt) {
    console.log(chalk.cyan("\nNext: set repo secret VIBEBOOK_PASSPHRASE on GitHub"));
    console.log(chalk.gray("  Settings → Secrets and variables → Actions → 'New repository secret'"));
  }
  console.log(chalk.gray("\nThe workflow will fire on every push to this device branch."));
  console.log(chalk.gray("Run `vibebook sync` to push your first batch."));
}
