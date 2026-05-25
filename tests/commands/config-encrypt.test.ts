import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("setEncryptMode", () => {
  let tmpHome: string;
  let repo: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "vb-enc-home-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
    repo = mkdtempSync(join(tmpdir(), "vb-enc-repo-"));
    // Make repo a git repo so removeCryptFilter can git config --unset
    execSync("git init", { cwd: repo, stdio: "ignore" });
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function plantConfig(encrypt: boolean) {
    writeFileSync(
      join(tmpHome, ".vibebook/config.json"),
      JSON.stringify({
        repoPath: repo, repoUrl: "git@example.com:me/x.git",
        encrypt, salt: "x", deviceBranch: "t", runner: "claude-cli",
      }),
    );
  }

  it("--encrypt false on a previously-encrypted repo: flips config, removes git filter, strips .gitattributes line", async () => {
    plantConfig(true);
    // Simulate previously-wired filter state
    execSync(`git -C ${repo} config filter.vibebook.clean 'vibebook crypt clean'`);
    execSync(`git -C ${repo} config filter.vibebook.smudge 'vibebook crypt smudge'`);
    execSync(`git -C ${repo} config filter.vibebook.required true`);
    execSync(`git -C ${repo} config diff.vibebook.textconv 'vibebook crypt smudge'`);
    writeFileSync(join(repo, ".gitattributes"),
      "# vibebook: encrypt raw_sessions on push, decrypt on checkout\n" +
      "raw_sessions/** filter=vibebook diff=vibebook\n");

    const { setEncryptMode } = await import("../../src/commands/config-encrypt.js");
    await setEncryptMode("false");

    // Config flipped
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.encrypt).toBe(false);

    // Git filter config keys gone (--get exits non-zero when key absent)
    const probe = (k: string) => {
      try { execSync(`git -C ${repo} config --get ${k}`, { stdio: "pipe" }); return true; }
      catch { return false; }
    };
    expect(probe("filter.vibebook.clean")).toBe(false);
    expect(probe("filter.vibebook.smudge")).toBe(false);
    expect(probe("filter.vibebook.required")).toBe(false);
    expect(probe("diff.vibebook.textconv")).toBe(false);

    // .gitattributes line stripped; file deleted because nothing else was in it
    expect(existsSync(join(repo, ".gitattributes"))).toBe(false);
  });

  it("--encrypt false leaves unrelated .gitattributes lines intact", async () => {
    plantConfig(true);
    writeFileSync(join(repo, ".gitattributes"),
      "# user's own attrs\n" +
      "*.png binary\n" +
      "# vibebook: encrypt raw_sessions on push, decrypt on checkout\n" +
      "raw_sessions/** filter=vibebook diff=vibebook\n");

    const { setEncryptMode } = await import("../../src/commands/config-encrypt.js");
    await setEncryptMode("false");

    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    expect(attrs).toContain("*.png binary");
    expect(attrs).not.toContain("raw_sessions/**");
    expect(attrs).not.toContain("vibebook: encrypt");
  });

  it("--encrypt false is idempotent when filter was already absent", async () => {
    plantConfig(false);
    const { setEncryptMode } = await import("../../src/commands/config-encrypt.js");
    // No-op (already false). Should not throw, just say nothing to change.
    await setEncryptMode("false");
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.encrypt).toBe(false);
  });

  it("--encrypt true wires the filter back on", async () => {
    plantConfig(false);
    // Plant passphrase so ensureCryptFilter doesn't bail looking for one
    writeFileSync(join(tmpHome, ".vibebook/passphrase"), "test-pp", { mode: 0o600 });

    const { setEncryptMode } = await import("../../src/commands/config-encrypt.js");
    await setEncryptMode("true");

    const cfg = JSON.parse(readFileSync(join(tmpHome, ".vibebook/config.json"), "utf8"));
    expect(cfg.encrypt).toBe(true);
    // Filter keys present now
    const probe = (k: string) => {
      try { execSync(`git -C ${repo} config --get ${k}`, { stdio: "pipe" }); return true; }
      catch { return false; }
    };
    expect(probe("filter.vibebook.clean")).toBe(true);
    expect(probe("filter.vibebook.smudge")).toBe(true);
  });

  it("rejects values other than 'true' / 'false'", async () => {
    plantConfig(true);
    const { setEncryptMode } = await import("../../src/commands/config-encrypt.js");
    await expect(setEncryptMode("yes")).rejects.toThrow(/must be 'true' or 'false'/);
  });
});
