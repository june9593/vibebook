import { simpleGit, SimpleGit } from "simple-git";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export async function ensureRepo(localPath: string, repoUrl: string): Promise<SimpleGit> {
  if (!existsSync(localPath)) {
    mkdirSync(localPath, { recursive: true });
    const git = simpleGit();
    await git.clone(repoUrl, localPath);
  }
  const git = simpleGit(localPath);
  if (!existsSync(join(localPath, ".git"))) {
    await git.init();
    await git.addRemote("origin", repoUrl).catch(() => { /* exists */ });
  }
  return git;
}

/**
 * Make sure the working tree is on `branch`.
 * Priority:
 *   1. Local branch exists → checkout.
 *   2. Remote `origin/<branch>` exists → checkout tracking branch.
 *   3. Neither → create as orphan (empty history, no parent).
 */
export async function ensureDeviceBranch(git: SimpleGit, branch: string): Promise<void> {
  const local = await git.branchLocal();
  if (local.all.includes(branch)) {
    if (local.current !== branch) await git.checkout(branch);
    return;
  }
  let remoteHas = false;
  try {
    const remote = await git.branch(["-r"]);
    remoteHas = remote.all.includes(`origin/${branch}`);
  } catch { /* no remotes fetched yet */ }
  if (remoteHas) {
    await git.checkout(["-b", branch, "--track", `origin/${branch}`]);
    return;
  }
  await git.checkout(["--orphan", branch]);
  await git.raw(["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
}

function pushWithProgress(cwd: string, branch: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(
      "git",
      ["push", "--progress", "--set-upstream", "origin", branch],
      { cwd, stdio: ["ignore", "inherit", "inherit"] },
    );
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

export async function commitAndPush(
  git: SimpleGit,
  message: string,
  paths: string[],
  branch: string,
  onProgress?: (stage: string) => void,
): Promise<{ committed: boolean; pushed: boolean }> {
  if (paths.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git add (${paths.length} paths)...`);
  await git.add(paths);
  const status = await git.status();
  if (status.staged.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git commit (${status.staged.length} staged)...`);
  await git.commit(message);
  onProgress?.(`git push origin ${branch} (live progress below):`);
  const cwd = await git.revparse(["--show-toplevel"]).then((s) => s.trim());
  const ok = await pushWithProgress(cwd, branch);
  return { committed: true, pushed: ok };
}
