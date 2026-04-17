import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { ensureDeviceBranch } from "../src/git-ops.js";

async function initBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-remote-"));
  await simpleGit().cwd(dir).init(true);
  return dir;
}

async function initClient(remote: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-client-"));
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addRemote("origin", remote);
  return dir;
}

describe("ensureDeviceBranch", () => {
  it("creates an orphan branch when none exists locally or on remote", async () => {
    const remote = await initBareRemote();
    const client = await initClient(remote);
    const git = simpleGit(client);

    await ensureDeviceBranch(git, "mbp2");

    const head = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    expect(head).toBe("mbp2");
    writeFileSync(join(client, "hello.txt"), "hi\n");
    await git.add(["hello.txt"]);
    await git.commit("first");
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("first");
  });

  it("is idempotent: running twice stays on the branch", async () => {
    const remote = await initBareRemote();
    const client = await initClient(remote);
    const git = simpleGit(client);

    await ensureDeviceBranch(git, "mbp2");
    writeFileSync(join(client, "a.txt"), "a\n");
    await git.add(["a.txt"]);
    await git.commit("a");

    await ensureDeviceBranch(git, "mbp2");
    const b = await git.branchLocal();
    expect(b.current).toBe("mbp2");
    const log = await git.log();
    expect(log.total).toBe(1);
  });

  it("checks out existing remote device branch instead of creating orphan", async () => {
    const remote = await initBareRemote();

    const clientA = await initClient(remote);
    const gitA = simpleGit(clientA);
    await ensureDeviceBranch(gitA, "mbp2");
    writeFileSync(join(clientA, "a.txt"), "a\n");
    await gitA.add(["a.txt"]);
    await gitA.commit("a");
    await gitA.push("origin", "mbp2");

    const clientB = await initClient(remote);
    const gitB = simpleGit(clientB);
    await gitB.fetch();
    await ensureDeviceBranch(gitB, "mbp2");
    const log = await gitB.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("a");
  });
});
