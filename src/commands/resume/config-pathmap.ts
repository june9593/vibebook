import { readConfig, writeConfig, type Config } from "../../config.js";

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
