import { simpleGit, SimpleGit } from "simple-git";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface MaterializeResult {
  /** "cloned" = brand-new clone; "existing" = used existing checkout;
   *  "init" = empty dir made into a git repo with origin set. */
  kind: "cloned" | "existing" | "init";
  /** When "existing", this is the URL of `origin` already in that repo —
   *  may differ from repoUrl, in which case caller should warn the user. */
  existingRemote?: string;
}

/**
 * Make sure `localPath` contains the repo at `repoUrl`.
 *
 * - If `localPath` doesn't exist OR exists-and-empty → `git clone repoUrl
 *   localPath`. Returns kind:"cloned".
 * - If `localPath` exists and contains `.git` → reuse. Returns kind:"existing"
 *   with `existingRemote` so the wizard can warn on URL mismatch. Does NOT
 *   change the existing remote.
 * - If `localPath` exists, non-empty, no `.git` → throw with a friendly
 *   message; refuse to scribble inside an unrelated dir.
 */
export async function materializeRepoAtPath(
  localPath: string,
  repoUrl: string,
): Promise<MaterializeResult> {
  if (!existsSync(localPath)) {
    mkdirSync(localPath, { recursive: true });
    await simpleGit().clone(repoUrl, localPath);
    return { kind: "cloned" };
  }
  const entries = readdirSync(localPath);
  if (entries.length === 0) {
    await simpleGit().clone(repoUrl, localPath);
    return { kind: "cloned" };
  }
  if (entries.includes(".git")) {
    const git = simpleGit(localPath);
    let remote = "";
    try {
      remote = (await git.getConfig("remote.origin.url")).value ?? "";
    } catch { /* no remote configured */ }
    return { kind: "existing", existingRemote: remote };
  }
  throw new Error(
    `${localPath} is not empty and is not a git repo. Pick another path or empty this one first.`,
  );
}

export async function ensureRepo(localPath: string, repoUrl: string): Promise<SimpleGit> {
  await materializeRepoAtPath(localPath, repoUrl);
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

export interface PushResult {
  ok: boolean;
  /** True iff stderr matched GitHub's push-protection / secret-scanning markers
   *  (GH013 / "push protection"). Only meaningful when ok=false. */
  secretBlocked: boolean;
  /** Tail of stderr (last ~4KB), useful for surfacing the reason. */
  stderrTail: string;
}

const SECRET_BLOCK_RE = /GH013|push protection|secret-scanning/i;

function pushWithProgress(cwd: string, branch: string): Promise<PushResult> {
  return new Promise((resolve) => {
    const errBuf: string[] = [];
    let bufLen = 0;
    const p = spawn(
      "git",
      ["push", "--progress", "--set-upstream", "origin", branch],
      { cwd, stdio: ["ignore", "inherit", "pipe"] },
    );
    p.stderr.on("data", (chunk: Buffer) => {
      // Tee to both terminal (so live progress still shows) AND buffer (so we
      // can scan for GitHub push-protection markers after exit).
      process.stderr.write(chunk);
      const s = chunk.toString();
      errBuf.push(s);
      bufLen += s.length;
      if (bufLen > 8192) {
        const drop = errBuf.shift();
        if (drop) bufLen -= drop.length;
      }
    });
    p.on("error", () => resolve({ ok: false, secretBlocked: false, stderrTail: errBuf.join("") }));
    p.on("close", (code) => {
      const tail = errBuf.join("");
      resolve({
        ok: code === 0,
        secretBlocked: code !== 0 && SECRET_BLOCK_RE.test(tail),
        stderrTail: tail.slice(-4096),
      });
    });
  });
}

export async function commitAndPush(
  git: SimpleGit,
  message: string,
  paths: string[],
  branch: string,
  onProgress?: (stage: string) => void,
): Promise<{ committed: boolean; pushed: boolean; pushResult?: PushResult }> {
  if (paths.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git add (${paths.length} paths)...`);
  await git.add(paths);
  const status = await git.status();
  if (status.staged.length === 0) return { committed: false, pushed: false };
  onProgress?.(`git commit (${status.staged.length} staged)...`);
  await git.commit(message);
  onProgress?.(`git push origin ${branch} (live progress below):`);
  const cwd = await git.revparse(["--show-toplevel"]).then((s) => s.trim());
  const r = await pushWithProgress(cwd, branch);
  return { committed: true, pushed: r.ok, pushResult: r };
}
