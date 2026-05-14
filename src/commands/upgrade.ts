import { spawnSync } from "node:child_process";
import chalk from "chalk";

/**
 * `vibebook upgrade` — refresh the npm CLI on PATH.
 *
 * As of 0.5, the digest + recall plugin is a separate product. This
 * command only refreshes the CLI; users update the plugin themselves
 * via `/plugin update vibebook` inside any Claude Code session.
 *
 * Skipped automatically if you're running a development install (i.e.
 * `npm link`'d from a checkout) — that's how the package author keeps
 * a working dev loop, and we should never undo it.
 *
 * Fail-open: if npm needs sudo / nvm permissions / the network is
 * gone, we surface the exact command and stop cleanly.
 */

export interface UpgradeOptions {
  /** Skip the npm step. Useful for users who manage vibebook via a
   *  package manager other than npm-global, or via npm-link. */
  noCli?: boolean;
}

export async function upgradeCmd(opts: UpgradeOptions = {}): Promise<void> {
  console.log(chalk.cyan("vibebook upgrade — refresh the npm CLI\n"));

  // Refresh the npm-global CLI.
  if (!opts.noCli) {
    if (isLinkedDevInstall()) {
      console.log(chalk.gray("  ✓ skipping npm install (vibebook is npm-link'd from a dev checkout)"));
    } else {
      console.log(chalk.cyan("→ npm install -g vibebook@latest"));
      const r = spawnSync("npm", ["install", "-g", "vibebook@latest"], { stdio: "inherit" });
      if (r.status === 0) {
        console.log(chalk.green("  ✓ CLI refreshed"));
      } else {
        console.log(chalk.yellow(
          "  ! npm install failed. Common causes:\n" +
          "    - You're on a system Node — try `sudo npm install -g vibebook@latest`\n" +
          "    - Or a stale nvm cache — try `nvm use --lts && npm install -g vibebook@latest`",
        ));
      }
    }
  }

  // Final summary — point users at the separate plugin update flow.
  console.log("");
  console.log(chalk.cyan("For the digest + recall plugin, run:"));
  console.log("  /plugin update vibebook    (in any Claude Code session)");
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
