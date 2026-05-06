import { spawnSync } from "node:child_process";
import chalk from "chalk";

/**
 * `vibebook upgrade` — single-command path to "this machine's vibebook
 * is current, both CLI and Claude Code plugin".
 *
 * Two steps:
 *   1. `npm install -g vibebook@latest` — refresh the CLI on PATH.
 *      Skipped automatically if you're running a development install
 *      (i.e. `npm link`'d from a checkout) — that's how the package
 *      author keeps a working dev loop, and we should never undo it.
 *   2. `vibebook plugin-install` — git-pull the marketplace clone +
 *      re-cache the plugin source + rewrite installed_plugins.json so
 *      Claude Code shows the new version next session.
 *
 * Fail-open at every step. If npm needs sudo / nvm permissions / the
 * network is gone, we surface the exact command and continue (or stop
 * cleanly). The user always ends with a clear "do X next" message.
 */

export interface UpgradeOptions {
  /** Skip the npm step. Useful for users who manage vibebook via a
   *  package manager other than npm-global, or via npm-link. */
  noCli?: boolean;
  /** Skip the plugin step. Rare — usually the user wants both. */
  noPlugin?: boolean;
}

export async function upgradeCmd(opts: UpgradeOptions = {}): Promise<void> {
  console.log(chalk.cyan("vibebook upgrade — keep CLI + Claude Code plugin in sync\n"));

  let cliRefreshed = false;

  // Step 1 — refresh the npm-global CLI.
  if (!opts.noCli) {
    if (isLinkedDevInstall()) {
      console.log(chalk.gray("  ✓ skipping npm install (vibebook is npm-link'd from a dev checkout)"));
    } else {
      console.log(chalk.cyan("→ npm install -g vibebook@latest"));
      const r = spawnSync("npm", ["install", "-g", "vibebook@latest"], { stdio: "inherit" });
      if (r.status === 0) {
        console.log(chalk.green("  ✓ CLI refreshed"));
        cliRefreshed = true;
      } else {
        console.log(chalk.yellow(
          "  ! npm install failed. Common causes:\n" +
          "    - You're on a system Node — try `sudo npm install -g vibebook@latest`\n" +
          "    - Or a stale nvm cache — try `nvm use --lts && npm install -g vibebook@latest`\n" +
          "  Continuing with the plugin step using whatever CLI is on PATH right now.",
        ));
      }
    }
  }

  // Step 2 — refresh the Claude Code plugin.
  if (!opts.noPlugin) {
    console.log(chalk.cyan("\n→ vibebook plugin-install"));
    try {
      const { installPluginFromGitHub } = await import("./plugin-install.js");
      const r = await installPluginFromGitHub();
      if (r.ok) {
        console.log(chalk.green(`  ✓ ${r.message}`));
        if (r.changed) {
          console.log(chalk.gray("  Restart Claude Code (close and reopen) to pick up the new plugin."));
        }
      } else {
        console.log(chalk.yellow(`  ! ${r.message}`));
        console.log(chalk.gray(
          "  Fall back: in the Claude Code REPL, run\n" +
          "    /plugin marketplace update vibebook\n" +
          "    /plugin update vibebook@vibebook",
        ));
      }
    } catch (e) {
      console.log(chalk.red(`  ✗ plugin install errored: ${(e as Error).message}`));
    }
  }

  // Final summary — what's the user's expected next step?
  console.log("");
  if (cliRefreshed) {
    console.log(chalk.cyan("Done. Reopen any running Claude Code session so it loads the new plugin."));
  } else {
    console.log(chalk.cyan("Done. If the plugin updated, reopen Claude Code; otherwise no action needed."));
  }
}

/** Detect a development install — `npm link` puts the global vibebook
 *  binary as a symlink to the user's local checkout. We don't want to
 *  blow that away with a tarball install. Strategy: ask npm where the
 *  global package lives, then check if it's a symlink. */
function isLinkedDevInstall(): boolean {
  try {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (root.status !== 0) return false;
    const globalRoot = root.stdout.trim();
    if (!globalRoot) return false;
    const { lstatSync } = require("node:fs") as typeof import("node:fs");
    const stat = lstatSync(`${globalRoot}/vibebook`);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
