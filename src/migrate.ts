import { simpleGit } from "simple-git";

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
