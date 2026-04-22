import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { LEGACY_REPO_DATA_DIR, REPO_DATA_DIR } from "./repo-data-dir.js";

/**
 * One-shot migration for repos created before per-device-branches existed.
 *
 * If the local repo has a `main` branch but no `<device>` branch, rename
 * main → <device> (preserving history) so the device branch becomes the
 * new write target. `main` is left unborn on purpose — it will be re-created
 * later (manually or by a future merge-to-main command) as the aggregate view.
 *
 * No-op when:
 *   - the device branch already exists (migration was already done, or a
 *     fresh clone is already on the right branch)
 *   - there is no `main` branch to rename
 */
export async function migrateLegacyMainToDevice(
  repoPath: string,
  deviceBranch: string,
): Promise<{ migrated: boolean }> {
  const git = simpleGit(repoPath);
  const local = await git.branchLocal();
  if (local.all.includes(deviceBranch)) return { migrated: false };
  if (!local.all.includes("main")) return { migrated: false };

  if (local.current !== "main") await git.checkout("main");
  await git.branch(["-m", "main", deviceBranch]);
  return { migrated: true };
}

/**
 * One-shot migration: rename in-repo data dir `.memvc/` → `.vibebook/`.
 *
 * Project was renamed memvc → vibebook (npm name conflict). Originally the
 * in-repo data dir was kept as `.memvc/` for backwards compatibility, but
 * that left the project's old name leaking into every memory repo. This
 * migration finishes the rename: any sync/digest run that sees a `.memvc/`
 * directory and no `.vibebook/` directory does the move via `git mv` (so
 * history follows) and stages it for the next commit.
 *
 * No-op when:
 *   - the repo has no `.memvc/` (fresh repo, or migration already done)
 *   - the repo already has `.vibebook/` (migration already done; old dir is
 *     left alone in case the user partially-merged something)
 *   - the repo isn't a git repo (we still do a non-git rename so non-pushing
 *     local-only mode works)
 */
export async function migrateLegacyDataDir(
  repoPath: string,
): Promise<{ migrated: boolean; viaGit: boolean }> {
  const legacy = join(repoPath, LEGACY_REPO_DATA_DIR);
  const target = join(repoPath, REPO_DATA_DIR);
  if (!existsSync(legacy)) return { migrated: false, viaGit: false };
  if (existsSync(target)) return { migrated: false, viaGit: false };

  const isGitRepo = existsSync(join(repoPath, ".git"));
  if (isGitRepo) {
    const git = simpleGit(repoPath);
    // git mv preserves history. Use the directory form; git stages every file
    // under it. The result is staged but not committed — runSync's commit
    // bundles it with the rest of the sync's paths.
    await git.raw(["mv", LEGACY_REPO_DATA_DIR, REPO_DATA_DIR]);
    return { migrated: true, viaGit: true };
  }

  // Non-git fallback: plain rename. Used by local-only mode + tests that
  // never init a git repo.
  const { renameSync } = await import("node:fs");
  renameSync(legacy, target);
  return { migrated: true, viaGit: false };
}

/** Returns the list of repo-rooted paths a successful data-dir migration produces, suitable for `git add`. */
export function migratedDataDirPaths(repoPath: string): string[] {
  const dir = join(repoPath, REPO_DATA_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => `${REPO_DATA_DIR}/${f}`);
}
