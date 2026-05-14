import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readPassphraseFile } from "./passphrase-store.js";
import { dataDirAbs, repoSaltAbs } from "./repo-data-dir.js";

const CONFIG_DIR = join(homedir(), ".vibebook");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Default cap on concurrent runner calls during the threading phase.
 *  claude-cli can comfortably handle 4 (each spawn is its own subprocess
 *  against the user's own Claude quota). anthropic-api also fine at 4. */
export const DEFAULT_THREADING_CONCURRENCY = 4;

/** Default attempts per threading batch before soft-failing it. */
export const DEFAULT_THREADING_MAX_ATTEMPTS = 3;

const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),          // base64 per-repo salt for scrypt
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api"]).default("claude-cli"),
  /** When true, the user opted into the CI book-aggregation workflow
   *  (scripts/merge-books.mjs runs on push to any non-main branch and
   *  merges device books into main). Purely informational — the workflow
   *  yaml + script live in the user's repo, not driven by this flag. */
  enableAggregateCI: z.boolean().default(false),
  /** When true, include the assistant's reasoning/thinking content in synced
   *  raw_sessions/*.md files. Improves digest quality (the summarizing LLM
   *  can see WHY the assistant chose a path) but can grow each md file by
   *  30-100%. Recommended when summarizing with a 400K+ context model;
   *  recommended off when summarizing with a smaller model. Default: true. */
  includeReasoning: z.boolean().default(true),
  threadingConcurrency: z.number().int().positive().default(DEFAULT_THREADING_CONCURRENCY),
  threadingMaxAttempts: z.number().int().positive().default(DEFAULT_THREADING_MAX_ATTEMPTS),
  digestEnabled: z.boolean().default(true),
  /** Cross-device path translation: source-prefix → this-machine-prefix.
   *  Used by `vibebook resume` to rewrite jsonl paths from another machine
   *  into local paths. Set via `vibebook config --map-path A=B`. */
  pathMap: z.record(z.string()).optional(),
});
export type Config = z.infer<typeof Schema>;

export function configExists(): boolean { return existsSync(CONFIG_PATH); }

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) throw new Error("vibebook not initialized. Run `vibebook init <repoUrl>`.");
  return Schema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

export function writeConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function freshSaltBase64(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Write `<repoPath>/.vibebook/repo-salt.json` so the GitHub Action workflow can
 * read the salt without having access to `~/.vibebook/config.json`. The salt
 * is not sensitive — security relies on the passphrase. Safe to commit.
 *
 * Legacy repos created before the data-dir rename had this file at
 * `.memvc/repo-salt.json`; `migrateLegacyDataDir` (in src/migrate.ts) renames
 * the directory on first sync/digest run.
 */
export function writeRepoSaltFile(repoPath: string, salt: string): void {
  mkdirSync(dataDirAbs(repoPath), { recursive: true });
  writeFileSync(repoSaltAbs(repoPath), JSON.stringify({ salt }, null, 2) + "\n");
}

export function getPassphrase(): string {
  const env = process.env.VIBEBOOK_PASSPHRASE;
  if (env) return env;
  const file = readPassphraseFile();
  if (file) return file;
  throw new Error(
    "encryption is on — set VIBEBOOK_PASSPHRASE env var, or save a passphrase via `vibebook init`",
  );
}
