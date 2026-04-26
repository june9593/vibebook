import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";

/**
 * End-to-end test of the git clean/smudge filter wired up by
 * `vibebook crypt init`. We build a real repo, write a session, run the
 * vibebook CLI to wire the filter, then verify:
 *   - working tree stays plaintext
 *   - committed blob is ciphertext
 *   - cloning into a fresh repo + running `crypt init` restores plaintext
 */

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = join(__filename, "..");
const VIBEBOOK_BIN = join(__dirnameLocal, "..", "..", "dist", "bin", "vibebook.js");
let tmpHome: string;
let workRepo: string;
let bareRemote: string;
const T = 60_000;

function vbk(repoPath: string, args: string[]): string {
  try {
    return execSync(`node ${VIBEBOOK_BIN} ${args.join(" ")}`, {
      cwd: repoPath,
      env: { ...process.env, HOME: tmpHome, VIBEBOOK_FILTER_BIN: `node ${VIBEBOOK_BIN}` },
      encoding: "utf8",
    });
  } catch (err: any) {
    throw new Error(`vbk failed: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
  }
}

function git(repoPath: string, args: string[]): string {
  // CRITICAL: filter subprocess inherits this env, so HOME must point at our
  // sandboxed config dir or it'll read the real ~/.vibebook/config.json.
  return execSync(`git -C ${JSON.stringify(repoPath)} ${args.join(" ")}`, {
    env: { ...process.env, HOME: tmpHome, VIBEBOOK_FILTER_BIN: `node ${VIBEBOOK_BIN}` },
    encoding: "utf8",
  });
}

function writeConfig(opts: { repoPath: string; salt: string; }) {
  const cfg = {
    repoPath: opts.repoPath,
    repoUrl: "",
    encrypt: true,
    salt: opts.salt,
    deviceBranch: "test-device",
    runner: "claude-cli",
    
    enableAggregateCI: false,
    includeReasoning: true,
    threadingConcurrency: 4,
    threadingMaxAttempts: 3,
    digestEnabled: true,
  };
  mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
  writeFileSync(join(tmpHome, ".vibebook", "config.json"), JSON.stringify(cfg));
  writeFileSync(join(tmpHome, ".vibebook", "passphrase"), "hunter2");
}

beforeEach(() => {
  vi.resetModules();
  tmpHome = mkdtempSync(join(tmpdir(), "vibebook-crypt-home-"));
  workRepo = mkdtempSync(join(tmpdir(), "vibebook-crypt-repo-"));
  bareRemote = mkdtempSync(join(tmpdir(), "vibebook-crypt-bare-"));
}, T);

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
  if (workRepo) rmSync(workRepo, { recursive: true, force: true, maxRetries: 3 });
  if (bareRemote) rmSync(bareRemote, { recursive: true, force: true, maxRetries: 3 });
});

describe("git crypt filter — end to end", () => {
  it("encrypts on add, working tree stays plaintext, fresh clone re-decrypts", async () => {
    // 1. Bare remote + work repo
    await simpleGit(bareRemote).init({ "--bare": null });
    await simpleGit().clone(bareRemote, workRepo);
    git(workRepo, ["config", "user.email", "t@t"]);
    git(workRepo, ["config", "user.name", "T"]);

    const salt = "AAAAAAAAAAAAAAAAAAAAAA==";
    writeConfig({ repoPath: workRepo, salt });

    // 2. Wire filter via CLI
    const out = vbk(workRepo, ["crypt", "init"]);
    expect(out).toContain("git filter");
    expect(existsSync(join(workRepo, ".gitattributes"))).toBe(true);
    expect(readFileSync(join(workRepo, ".gitattributes"), "utf8"))
      .toContain("raw_sessions/** filter=vibebook");

    // 3. Write a plaintext session, commit (use git() so filter env is right)
    const relPath = "raw_sessions/claude/proj/2026-04-24/foo__abc.md";
    mkdirSync(join(workRepo, "raw_sessions/claude/proj/2026-04-24"), { recursive: true });
    const plaintext = "# foo\n## User\nhello world\n";
    writeFileSync(join(workRepo, relPath), plaintext);
    git(workRepo, ["add", ".gitattributes", JSON.stringify(relPath)]);
    git(workRepo, ["commit", "-q", "-m", JSON.stringify("init session")]);

    // Working tree is still plaintext
    expect(readFileSync(join(workRepo, relPath), "utf8")).toBe(plaintext);

    // The committed blob is ciphertext
    const blob = execSync(`git cat-file -p HEAD:${relPath}`, { cwd: workRepo });
    expect(blob.subarray(0, 6).toString("utf8")).toBe("MEMVC1");
    expect(blob.includes(Buffer.from("hello world"))).toBe(false);

    // 4. Push and clone fresh
    try { git(workRepo, ["push", "-q", "origin", "master"]); }
    catch { git(workRepo, ["push", "-q", "origin", "main"]); }
    const freshClone = mkdtempSync(join(tmpdir(), "vibebook-crypt-fresh-"));
    try {
      await simpleGit().clone(bareRemote, freshClone);
      // Without filter wired up, working tree is ciphertext
      const ctOnDisk = readFileSync(join(freshClone, relPath));
      expect(ctOnDisk.subarray(0, 6).toString("utf8")).toBe("MEMVC1");

      // Point config at the fresh clone, rewire
      writeConfig({ repoPath: freshClone, salt });
      vbk(freshClone, ["crypt", "init"]);

      // After smudge, the working tree should be plaintext
      expect(readFileSync(join(freshClone, relPath), "utf8")).toBe(plaintext);
    } finally {
      rmSync(freshClone, { recursive: true, force: true, maxRetries: 3 });
    }
  }, T);
});
