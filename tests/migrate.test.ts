import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { migrateLegacyMainToDevice } from "../src/migrate.js";

async function initRepoOnMain(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "memvc-migrate-"));
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  writeFileSync(join(dir, "file.txt"), "hello\n");
  await git.add(["file.txt"]);
  await git.commit("initial");
  return dir;
}

describe("migrateLegacyMainToDevice", () => {
  it("renames main → <device> and leaves main unborn (unchanged working tree)", async () => {
    const dir = await initRepoOnMain();
    const git = simpleGit(dir);

    const result = await migrateLegacyMainToDevice(dir, "mbp2");

    expect(result.migrated).toBe(true);
    const branches = await git.branchLocal();
    expect(branches.all).toContain("mbp2");
    expect(branches.current).toBe("mbp2");
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain("initial");
  });

  it("is a no-op when device branch already exists", async () => {
    const dir = await initRepoOnMain();
    const git = simpleGit(dir);
    await git.checkoutLocalBranch("mbp2");

    const result = await migrateLegacyMainToDevice(dir, "mbp2");
    expect(result.migrated).toBe(false);
  });

  it("is a no-op when there is no main branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memvc-empty-"));
    const git = simpleGit(dir);
    await git.init(["--initial-branch=mbp2"]);
    writeFileSync(join(dir, "f.txt"), "x\n");
    await git.add(["f.txt"]);
    await git.commit("x");

    const result = await migrateLegacyMainToDevice(dir, "mbp2");
    expect(result.migrated).toBe(false);
  });
});
