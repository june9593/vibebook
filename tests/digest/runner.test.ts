import { describe, it, expect } from "vitest";
import { createRunner } from "../../src/digest/runner.js";

describe("createRunner factory", () => {
  it("returns an object with a .run() function for claude-cli", () => {
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for anthropic-api", () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for github-models", () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });
});

describe("anthropic-api runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});

describe("github-models runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});
