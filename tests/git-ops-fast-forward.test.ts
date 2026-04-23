import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { fastForwardBranch } from "../src/git-ops.js";

async function makeBareRemote(): Promise<string> {
  const bare = mkdtempSync(join(tmpdir(), "vibebook-bare-"));
  await simpleGit(bare).init({ "--bare": null });
  return bare;
}

/**
 * Seed a bare remote with one commit on `branch`. Returns a local clone that
 * has the branch checked out and tracks origin/<branch>. Idempotent: if the
 * branch already exists on the remote, just clones+checks out.
 */
async function makeOrCloneSeeded(remote: string, branch: string): Promise<string> {
  const local = mkdtempSync(join(tmpdir(), "vibebook-clone-"));
  await simpleGit().clone(remote, local);
  const g = simpleGit(local);
  await g.addConfig("user.email", "t@example.com");
  await g.addConfig("user.name", "Tester");

  // Does origin/<branch> exist?
  const remoteBranches = await g.branch(["-r"]);
  if (remoteBranches.all.includes(`origin/${branch}`)) {
    await g.checkout(["-b", branch, "--track", `origin/${branch}`]);
    return local;
  }

  // First clone — create the branch and seed it.
  await g.checkoutLocalBranch(branch);
  writeFileSync(join(local, "seed.txt"), "init\n");
  await g.add("seed.txt");
  await g.commit("seed");
  await g.push("origin", branch, ["-u"]);
  return local;
}

describe("fastForwardBranch", () => {
  let remote: string;

  beforeEach(async () => {
    remote = await makeBareRemote();
  });

  it("returns no-tracking on a fresh branch with no upstream", async () => {
    const local = mkdtempSync(join(tmpdir(), "vibebook-fresh-"));
    const g = simpleGit(local);
    await g.init();
    await g.addRemote("origin", remote);
    await g.addConfig("user.email", "t@example.com");
    await g.addConfig("user.name", "Tester");
    await g.checkoutLocalBranch("Mac.lan");
    const r = await fastForwardBranch(g, "Mac.lan");
    expect(r.pulled).toBe(false);
    expect(r.reason).toBe("no-tracking");
  });

  it("fast-forwards local branch when origin has new commits", async () => {
    const localA = await makeOrCloneSeeded(remote, "Mac.lan");
    const localB = await makeOrCloneSeeded(remote, "Mac.lan");

    // localA pushes a new commit (simulating CI)
    writeFileSync(join(localA, "ci-added.txt"), "from CI\n");
    await simpleGit(localA).add("ci-added.txt");
    await simpleGit(localA).commit("ci commit");
    await simpleGit(localA).push("origin", "Mac.lan");

    // localB is now behind. fast-forward should pull cleanly.
    const r = await fastForwardBranch(simpleGit(localB), "Mac.lan");
    expect(r.pulled).toBe(true);
    const log = await simpleGit(localB).log();
    expect(log.all.some((c) => c.message === "ci commit")).toBe(true);
  });

  it("rebases local commit on top of remote commit (diverged)", async () => {
    const localA = await makeOrCloneSeeded(remote, "Mac.lan");
    const localB = mkdtempSync(join(tmpdir(), "vibebook-cloneB-"));
    await simpleGit().clone(remote, localB);
    const gB = simpleGit(localB);
    await gB.addConfig("user.email", "t@example.com");
    await gB.addConfig("user.name", "Tester");
    await gB.checkout("Mac.lan");

    // localA pushes a new commit
    writeFileSync(join(localA, "from-a.txt"), "a\n");
    await simpleGit(localA).add("from-a.txt");
    await simpleGit(localA).commit("a commit");
    await simpleGit(localA).push("origin", "Mac.lan");

    // localB makes a different local commit (different file → no conflict)
    writeFileSync(join(localB, "from-b.txt"), "b\n");
    await gB.add("from-b.txt");
    await gB.commit("b commit");

    // fast-forward should rebase b on top of a
    const r = await fastForwardBranch(gB, "Mac.lan");
    expect(r.pulled).toBe(true);
    const log = await gB.log();
    expect(log.all[0].message).toBe("b commit");
    expect(log.all[1].message).toBe("a commit");
  });

  it("throws on rebase conflict and leaves working tree clean", async () => {
    const localA = await makeOrCloneSeeded(remote, "Mac.lan");
    const localB = mkdtempSync(join(tmpdir(), "vibebook-cloneC-"));
    await simpleGit().clone(remote, localB);
    const gB = simpleGit(localB);
    await gB.addConfig("user.email", "t@example.com");
    await gB.addConfig("user.name", "Tester");
    await gB.checkout("Mac.lan");

    // localA modifies seed.txt and pushes
    writeFileSync(join(localA, "seed.txt"), "from A\n");
    await simpleGit(localA).add("seed.txt");
    await simpleGit(localA).commit("a edit");
    await simpleGit(localA).push("origin", "Mac.lan");

    // localB modifies the same file differently → conflict on rebase
    writeFileSync(join(localB, "seed.txt"), "from B\n");
    await gB.add("seed.txt");
    await gB.commit("b edit");

    await expect(fastForwardBranch(gB, "Mac.lan")).rejects.toThrow(/Could not fast-forward/);

    // After abort, working tree should not be in a rebase state.
    const status = await gB.status();
    expect(status.conflicted).toEqual([]);
  });
});
