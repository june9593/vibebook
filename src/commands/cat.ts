import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readConfig } from "../config.js";

/**
 * Dump a session file (or any repo file) to stdout. Used by the in-session
 * /vibebook skill to read session md.
 *
 * Path resolution:
 *   - absolute path → used as-is
 *   - relative path → resolved against `cfg.repoPath`
 */
export async function catCmd(path: string): Promise<void> {
  if (!path) throw new Error("usage: vibebook cat <path>");
  const cfg = readConfig();
  const abs = isAbsolute(path) ? path : join(cfg.repoPath, path);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  process.stdout.write(readFileSync(abs));
}
