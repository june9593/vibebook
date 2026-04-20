import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import type { LlmRunner } from "../../src/digest/runner.js";
import { withIsolatedCwd, _claudeProjectHashForTests } from "../../src/digest/with-isolated-cwd.js";

describe("withIsolatedCwd", () => {
  it("wraps runner so .run is called with cwd injected", async () => {
    let captured: string | undefined;
    const runner: LlmRunner = {
      run: async (_p, _v, opts) => {
        captured = opts?.cwd;
        return { ok: true, text: "hi", durationMs: 1 };
      },
    };
    await withIsolatedCwd(runner, async (wrapped) => {
      await wrapped.run("p", {}, { outputFormat: "text" });
    });
    expect(captured).toMatch(/memvc-claude-/);
  });

  it("cleans up the tmp cwd after callback resolves", async () => {
    let cwdSeen = "";
    await withIsolatedCwd(
      { run: async (_p, _v, opts) => { cwdSeen = opts?.cwd ?? ""; return { ok: true, text: "", durationMs: 1 }; } },
      async (w) => { await w.run("p", {}); },
    );
    expect(existsSync(cwdSeen)).toBe(false);
  });

  it("cleans up even when callback throws", async () => {
    let cwdSeen = "";
    await expect(withIsolatedCwd(
      { run: async (_p, _v, opts) => { cwdSeen = opts?.cwd ?? ""; return { ok: true, text: "", durationMs: 1 }; } },
      async (w) => { await w.run("p", {}); throw new Error("boom"); },
    )).rejects.toThrow(/boom/);
    expect(existsSync(cwdSeen)).toBe(false);
  });

  it("preserves opts the runner already had (overlays cwd, doesn't replace)", async () => {
    let captured: any;
    const runner: LlmRunner = {
      run: async (_p, _v, opts) => { captured = opts; return { ok: true, text: "", durationMs: 1 }; },
    };
    await withIsolatedCwd(runner, async (w) => {
      await w.run("p", {}, { outputFormat: "json", timeoutMs: 5000 });
    });
    expect(captured.outputFormat).toBe("json");
    expect(captured.timeoutMs).toBe(5000);
    expect(captured.cwd).toMatch(/memvc-claude-/);
  });

  it("claudeProjectHash mirrors slash-replacement scheme", () => {
    expect(_claudeProjectHashForTests("/var/folders/x/T/memvc-claude-Ab")).toBe(
      "-var-folders-x-T-memvc-claude-Ab",
    );
  });

  it("claudeProjectHash for a /private/var/folders path produces a -private-var-folders-... hash on macOS-style realpath", () => {
    // Simulate what realpath would have returned for an unresolved /var path.
    expect(_claudeProjectHashForTests("/private/var/folders/zm/x/T/memvc-claude-Ab")).toBe(
      "-private-var-folders-zm-x-T-memvc-claude-Ab",
    );
  });
});
