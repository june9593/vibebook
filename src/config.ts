import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readPassphraseFile } from "./passphrase-store.js";

const CONFIG_DIR = join(homedir(), ".memvc");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Default cap on concurrent runner calls during the threading phase. */
export const DEFAULT_THREADING_CONCURRENCY = 4;

/** Default attempts per threading batch before soft-failing it. */
export const DEFAULT_THREADING_MAX_ATTEMPTS = 3;

const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  encrypt: z.boolean().default(false),
  salt: z.string(),          // base64 per-repo salt for scrypt
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api", "github-models", "github-action"]).default("claude-cli"),
  runnerModel: z.string().default(""),
  threadingConcurrency: z.number().int().positive().default(DEFAULT_THREADING_CONCURRENCY),
  threadingMaxAttempts: z.number().int().positive().default(DEFAULT_THREADING_MAX_ATTEMPTS),
  digestEnabled: z.boolean().default(true),
});
export type Config = z.infer<typeof Schema>;

export function configExists(): boolean { return existsSync(CONFIG_PATH); }

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) throw new Error("memvc not initialized. Run `memvc init <repoUrl>`.");
  return Schema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

export function writeConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function freshSaltBase64(): string {
  return randomBytes(16).toString("base64");
}

export function getPassphrase(): string {
  const env = process.env.MEMVC_PASSPHRASE;
  if (env) return env;
  const file = readPassphraseFile();
  if (file) return file;
  throw new Error(
    "encryption is on — set MEMVC_PASSPHRASE env var, or save a passphrase via `memvc init`",
  );
}
