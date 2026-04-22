import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { migrateLegacyDataDir, migratedDataDirPaths } from "../src/migrate.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vibebook-mig-"));
});

describe("migrateLegacyDataDir", () => {
  it("no-op on a clean repo (no .memvc/, no .vibebook/)", async () => {
    const r = await migrateLegacyDataDir(repo);
    expect(r.migrated).toBe(false);
    expect(existsSync(join(repo, ".vibebook"))).toBe(false);
  });

  it("no-op when .vibebook/ already exists (migration already done)", async () => {
    mkdirSync(join(repo, ".memvc"));
    writeFileSync(join(repo, ".memvc", "index.json"), "{}");
    mkdirSync(join(repo, ".vibebook"));
    const r = await migrateLegacyDataDir(repo);
    expect(r.migrated).toBe(false);
    // Both still exist; we don't merge / clobber.
    expect(existsSync(join(repo, ".memvc"))).toBe(true);
    expect(existsSync(join(repo, ".vibebook"))).toBe(true);
  });

  it("plain rename in non-git mode (local-only)", async () => {
    mkdirSync(join(repo, ".memvc"));
    writeFileSync(join(repo, ".memvc", "index.json"), '{"version":1,"entries":{}}');
    writeFileSync(join(repo, ".memvc", "repo-salt.json"), '{"salt":"abc"}');

    const r = await migrateLegacyDataDir(repo);
    expect(r.migrated).toBe(true);
    expect(r.viaGit).toBe(false);
    expect(existsSync(join(repo, ".memvc"))).toBe(false);
    expect(existsSync(join(repo, ".vibebook", "index.json"))).toBe(true);
    expect(existsSync(join(repo, ".vibebook", "repo-salt.json"))).toBe(true);
    expect(readFileSync(join(repo, ".vibebook", "repo-salt.json"), "utf8")).toBe('{"salt":"abc"}');
  });

  it("git mv in a git repo, preserves history, stages the rename", async () => {
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "Tester");
    mkdirSync(join(repo, ".memvc"));
    writeFileSync(join(repo, ".memvc", "index.json"), '{"version":1,"entries":{}}');
    await git.add(".memvc/index.json");
    await git.commit("seed");

    const r = await migrateLegacyDataDir(repo);
    expect(r.migrated).toBe(true);
    expect(r.viaGit).toBe(true);
    expect(existsSync(join(repo, ".memvc"))).toBe(false);
    expect(existsSync(join(repo, ".vibebook", "index.json"))).toBe(true);

    // The rename is staged for the next commit.
    const status = await git.status();
    const renamedPaths = status.renamed.map((r) => `${r.from} -> ${r.to}`);
    expect(renamedPaths.some((p) => p.includes(".memvc/index.json") && p.includes(".vibebook/index.json"))).toBe(true);
  });
});

describe("migratedDataDirPaths", () => {
  it("returns empty when .vibebook/ is absent", () => {
    expect(migratedDataDirPaths(repo)).toEqual([]);
  });

  it("lists every file under .vibebook/", () => {
    mkdirSync(join(repo, ".vibebook"));
    writeFileSync(join(repo, ".vibebook", "index.json"), "{}");
    writeFileSync(join(repo, ".vibebook", "repo-salt.json"), "{}");
    const paths = migratedDataDirPaths(repo);
    expect(paths.sort()).toEqual([".vibebook/index.json", ".vibebook/repo-salt.json"]);
  });
});
