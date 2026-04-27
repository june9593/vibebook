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

/**
 * Install the GitHub Pages workflow that builds + publishes the site
 * (`vibebook build-site` output) on every push to main. Mirror of
 * workflowInitCmd's auto-commit/push behavior.
 */
export async function workflowPagesInitCmd(opts: { force?: boolean; noPush?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const yamlTarget = join(cfg.repoPath, ".github", "workflows", "vibebook-pages.yml");

  if (existsSync(yamlTarget) && !opts.force) {
    console.log(chalk.yellow(`already exists: ${yamlTarget}`));
    console.log(chalk.gray("  re-run with --force to overwrite"));
    return;
  }

  mkdirSync(dirname(yamlTarget), { recursive: true });
  writeFileSync(yamlTarget, readFileSync(assetPath("assets/workflows/vibebook-pages.yml"), "utf8"));
  console.log(chalk.green(`pages workflow written: ${yamlTarget}`));
  console.log(chalk.cyan(`\nNext: GitHub Settings → Pages → Source: GitHub Actions`));

  const wantPush = !opts.noPush && cfg.repoUrl && cfg.deviceBranch;
  if (!wantPush) {
    console.log(chalk.gray("\nLocal-only mode: workflow file written but not committed/pushed."));
    return;
  }

  // For pages we want the workflow on main, not the device branch — the
  // workflow only fires when present on main. We push to main directly,
  // refusing if that would clobber unpushed work.
  console.log(chalk.gray(`\nCommitting + pushing to 'main'...`));
  const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
  try { await git.fetch(); } catch { /* offline / empty */ }
  // Switch to a temp worktree-style commit on main: simplest to ask the
  // user to handle this manually if they aren't already on main.
  const status = await git.status();
  const onMain = status.current === "main";
  if (!onMain) {
    console.log(chalk.yellow(
      `\n  Currently on '${status.current}'. The pages workflow must be on main to fire.\n` +
      `  Easiest path:\n` +
      `    cd ${cfg.repoPath}\n` +
      `    git checkout main && git pull\n` +
      `    git add .github/workflows/vibebook-pages.yml && git commit -m 'add pages workflow'\n` +
      `    git push origin main`,
    ));
    return;
  }
  await fastForwardBranch(git, "main", (s) => console.log(chalk.gray(`  ${s}`)));
  const r = await commitAndPush(
    git,
    "vibebook: add GitHub Pages workflow",
    [".github/workflows/vibebook-pages.yml"],
    "main",
    (stage) => console.log(chalk.gray(`  ${stage}`)),
  );
  if (r.committed && r.pushed) {
    console.log(chalk.green(`✓ pushed to main; first build will start shortly`));
  } else if (r.committed && !r.pushed) {
    console.log(chalk.yellow(`Committed locally but push failed. Run \`git push\` manually from ${cfg.repoPath}.`));
  } else {
    console.log(chalk.gray("Nothing to commit (workflow already up to date)."));
  }
}
