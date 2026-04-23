import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepScratchDirs } from "../../src/digest/with-isolated-cwd.js";

let fakeTmp: string;
let fakeClaude: string;

beforeEach(() => {
  fakeTmp = mkdtempSync(join(tmpdir(), "vibebook-test-sweep-tmp-"));
  fakeClaude = mkdtempSync(join(tmpdir(), "vibebook-test-sweep-claude-"));
});

describe("sweepScratchDirs", () => {
  it("removes vibebook-claude-* and memvc-claude-* dirs from tmpdir", () => {
    mkdirSync(join(fakeTmp, "vibebook-claude-AbCdEf"));
    writeFileSync(join(fakeTmp, "vibebook-claude-AbCdEf", "stale.jsonl"), "x");
    mkdirSync(join(fakeTmp, "memvc-claude-OldStuff"));
    writeFileSync(join(fakeTmp, "memvc-claude-OldStuff", "junk.jsonl"), "y");
    // Unrelated dir — should NOT be touched.
    mkdirSync(join(fakeTmp, "user-experiment"));
    writeFileSync(join(fakeTmp, "user-experiment", "real.txt"), "keep me");

    const r = sweepScratchDirs({ tmpdirPath: fakeTmp, claudeProjectsPath: fakeClaude });

    expect(r.tmpDirsRemoved).toBe(2);
    expect(existsSync(join(fakeTmp, "vibebook-claude-AbCdEf"))).toBe(false);
    expect(existsSync(join(fakeTmp, "memvc-claude-OldStuff"))).toBe(false);
    expect(existsSync(join(fakeTmp, "user-experiment", "real.txt"))).toBe(true);
  });

  it("removes ~/.claude/projects/-...-vibebook-claude-* dirs", () => {
    // Mirrors the dash-encoded path Claude CLI stamps:
    //   /var/folders/x/T/vibebook-claude-Ab → -var-folders-x-T-vibebook-claude-Ab
    const stamped1 = join(fakeClaude, "-private-var-folders-zm-x-T-vibebook-claude-AbCdEf");
    mkdirSync(stamped1);
    writeFileSync(join(stamped1, "session.jsonl"), '{"sessionId":"s1"}');

    const stamped2 = join(fakeClaude, "-tmp-memvc-claude-LegacyXyz");
    mkdirSync(stamped2);
    writeFileSync(join(stamped2, "session.jsonl"), '{"sessionId":"s2"}');

    const realProject = join(fakeClaude, "-Users-yueliu-edge-myproj");
    mkdirSync(realProject);
    writeFileSync(join(realProject, "real.jsonl"), '{"sessionId":"real"}');

    const r = sweepScratchDirs({ tmpdirPath: fakeTmp, claudeProjectsPath: fakeClaude });

    expect(r.claudeDirsRemoved).toBe(2);
    expect(existsSync(stamped1)).toBe(false);
    expect(existsSync(stamped2)).toBe(false);
    expect(existsSync(realProject)).toBe(true);
  });

  it("returns 0/0 on a fresh setup", () => {
    const r = sweepScratchDirs({ tmpdirPath: fakeTmp, claudeProjectsPath: fakeClaude });
    expect(r.tmpDirsRemoved).toBe(0);
    expect(r.claudeDirsRemoved).toBe(0);
  });

  it("never throws when paths don't exist", () => {
    expect(() => sweepScratchDirs({
      tmpdirPath: "/totally/made/up/nope-tmp",
      claudeProjectsPath: "/totally/made/up/nope-claude",
    })).not.toThrow();
  });
});
