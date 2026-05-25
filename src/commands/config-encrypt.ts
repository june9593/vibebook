import chalk from "chalk";
import { readConfig, writeConfig } from "../config.js";

/**
 * `vibebook config --encrypt true|false` — flip the on-disk config flag
 * AND (for false) tear down the per-clone git crypt filter so future
 * sync writes plaintext.
 *
 * NEW in 0.8.2 — encryption stops being default in `vibebook init`.
 * Existing encrypted repos can opt out with this command; new sessions
 * sync as plaintext, but already-pushed ciphertext blobs on the remote
 * stay encrypted until they're re-rendered (next time their source
 * jsonl changes triggers re-sync).
 *
 * Intentionally does NOT delete `~/.vibebook/passphrase` — leaving it in
 * place lets the user flip back to `--encrypt true` later without having
 * to remember/re-enter the passphrase. The file is mode 0600 anyway.
 */
export async function setEncryptMode(value: string): Promise<void> {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`--encrypt must be 'true' or 'false', got '${value}'.`);
  }
  const desired = normalized === "true";
  const cfg = readConfig();
  if (cfg.encrypt === desired) {
    console.log(chalk.gray(`encrypt already ${desired}; nothing to change.`));
    return;
  }

  writeConfig({ ...cfg, encrypt: desired });
  console.log(chalk.green(`✓ ~/.vibebook/config.json: encrypt = ${desired}`));

  if (desired) {
    // Switching ON. Wire the filter so the next sync encrypts on write.
    const { ensureCryptFilter } = await import("./crypt.js");
    const r = ensureCryptFilter(cfg.repoPath);
    if (r.wired) {
      console.log(chalk.gray(`  wired git crypt filter in ${cfg.repoPath}`));
      console.log(chalk.yellow(
        `\n  Note: existing plaintext blobs on the remote stay plaintext until\n` +
        `  their source jsonl changes triggers a re-sync. To force-encrypt now:\n` +
        `    rm -rf ${cfg.repoPath}/raw_sessions && vibebook sync`,
      ));
    } else {
      console.log(chalk.yellow(`  filter not wired: ${r.reason}`));
    }
    return;
  }

  // Switching OFF. Tear down the filter so future syncs write plaintext.
  const { removeCryptFilter } = await import("./crypt.js");
  const r = removeCryptFilter(cfg.repoPath);
  if (r.removedFilter || r.removedAttrs) {
    console.log(chalk.gray(
      `  removed git crypt filter from ${cfg.repoPath}/.git/config` +
      (r.removedAttrs ? ` + .gitattributes` : ``),
    ));
  } else {
    console.log(chalk.gray(`  no git crypt filter was wired (idempotent).`));
  }
  console.log(chalk.yellow(
    `\n  Note: existing encrypted blobs on the remote stay encrypted until\n` +
    `  their source jsonl changes triggers a re-sync. To force-decrypt now:\n` +
    `    rm -rf ${cfg.repoPath}/raw_sessions && vibebook sync`,
  ));
}
