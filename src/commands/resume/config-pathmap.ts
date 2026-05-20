import { readConfig, writeConfig, type Config } from "../../config.js";
import { sanitizeBranchName } from "../../device.js";

/** Parse "FROM=TO" and add it to ~/.vibebook/config.json's pathMap. Throws
 *  on malformed input. Used by the `vibebook config --map-path` CLI flag.
 *
 *  The pathMap field is optional in the Config schema; if it doesn't exist
 *  yet, this initializes it.
 */
export function setMapPath(spec: string): void {
  const idx = spec.indexOf("=");
  if (idx < 0) {
    throw new Error(`Invalid --map-path '${spec}': expected FROM=TO form`);
  }
  const from = spec.slice(0, idx);
  const to = spec.slice(idx + 1);
  if (!from) throw new Error(`--map-path '${spec}': FROM is empty`);
  if (!to) throw new Error(`--map-path '${spec}': TO is empty`);

  const cfg: Config = readConfig();
  const map = { ...(cfg.pathMap ?? {}), [from]: to };
  writeConfig({ ...cfg, pathMap: map });
}

/** Set ~/.vibebook/config.json's deviceBranch. Used by `vibebook config
 *  --device <name>` so existing users can replace a drift-prone hostname
 *  (e.g. "Mac-mini-2.local") with a stable physical-label name (e.g. "mini2").
 *  Returns the previous and new branch names so the CLI can hint the user
 *  to delete the old remote branch.
 */
export function setDeviceBranch(name: string): { previous: string; current: string } {
  const sanitized = sanitizeBranchName(name);
  if (!sanitized) throw new Error(`--device '${name}': sanitizes to empty branch name`);
  const cfg: Config = readConfig();
  const previous = cfg.deviceBranch;
  writeConfig({ ...cfg, deviceBranch: sanitized });
  return { previous, current: sanitized };
}
