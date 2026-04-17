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

function pushWithProgress(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("git", ["push", "--progress", "origin", "HEAD"], { cwd, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

export async function commitAndPush(
  git: SimpleGit,
  message: string,
  paths: string[],
  onProgress?: (stage: string) => void,
): Promise<{ committed: boolean; pushed: boolean }> {
  if (paths.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git add (${paths.length} paths)...`);
  await git.add(paths);
  const status = await git.status();
  if (status.staged.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git commit (${status.staged.length} staged)...`);
  await git.commit(message);
  onProgress?.(`git push to origin (live progress below):`);
  const cwd = await git.revparse(["--show-toplevel"]).then((s) => s.trim());
  const ok = await pushWithProgress(cwd);
  return { committed: true, pushed: ok };
}
