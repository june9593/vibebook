import { describe, it, expect } from "vitest";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../src/runner-check.js";

describe("checkBinary", () => {
  it("returns ok:true for a known-good binary (`node --version`)", async () => {
    const r = await checkBinary("node", ["--version"]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^v\d+/);
  });

  it("returns ok:false with hint for unknown binary", async () => {
    const r = await checkBinary("definitely-not-a-real-binary-xyz123");
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("not found");
  });

  it("returns ok:false on non-zero exit", async () => {
    const r = await checkBinary("node", ["-e", "process.exit(7)"], 30_000);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("exited with 7");
  });

  it("times out long-running command", async () => {
    const r = await checkBinary("node", ["-e", "setTimeout(()=>{}, 30000)"], 200);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("timed out");
  });
});

describe("runnerBinary / runnerInstallUrl", () => {
  it("knows claude-cli", () => {
    expect(runnerBinary("claude-cli")).toBe("claude");
    expect(runnerInstallUrl("claude-cli")).toMatch(/^https:/);
  });
  it("returns null for unknown", () => {
    expect(runnerBinary("nope")).toBeNull();
    expect(runnerInstallUrl("nope")).toBeNull();
  });
});
