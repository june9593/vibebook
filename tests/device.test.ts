import { describe, it, expect } from "vitest";
import { sanitizeBranchName, deviceBranchFromHostname } from "../src/device.js";

describe("sanitizeBranchName", () => {
  it("keeps alnum, dash, underscore, dot", () => {
    expect(sanitizeBranchName("yuedeMacBook-Pro-2.local")).toBe("yuedeMacBook-Pro-2.local");
  });
  it("replaces spaces and unsafe chars with dashes", () => {
    expect(sanitizeBranchName("Yue's iMac")).toBe("Yue-s-iMac");
  });
  it("collapses runs of dashes and trims leading/trailing", () => {
    expect(sanitizeBranchName("---foo   bar---")).toBe("foo-bar");
  });
  it("lowercases nothing (preserves case)", () => {
    expect(sanitizeBranchName("MacBook")).toBe("MacBook");
  });
  it("falls back to 'device' when empty after sanitize", () => {
    expect(sanitizeBranchName("///")).toBe("device");
  });
  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long).length).toBe(60);
  });
});

describe("deviceBranchFromHostname", () => {
  it("returns sanitized hostname", () => {
    const b = deviceBranchFromHostname();
    expect(b.length).toBeGreaterThan(0);
    expect(b).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
