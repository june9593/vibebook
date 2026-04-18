import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate `assets/prompts/<name>.md` regardless of whether this code is running
 * from `src/` (via vitest / ts-node) or from `dist/` (via the built CLI).
 *
 * tsc with `rootDir: "."` mirrors `src/` to `dist/src/` and `bin/` to
 * `dist/bin/`, so the depth from a digest module to repo root differs between
 * dev and prod. We walk up from the caller's directory looking for the asset.
 */
export function loadPromptAsset(callerFileUrl: string, name: string): string {
  const callerDir = dirname(fileURLToPath(callerFileUrl));
  let dir = callerDir;
  while (true) {
    const candidate = join(dir, "assets", "prompts", `${name}.md`);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error(
        `loadPromptAsset: assets/prompts/${name}.md not found walking up from ${callerDir}`,
      );
    }
    dir = parent;
  }
}
